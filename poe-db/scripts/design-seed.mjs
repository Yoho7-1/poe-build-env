// Corpus seeding for the WP5 generator (WP5b item 3): a prototype starts from the tree, items, masteries, jewels,
// flasks and auras of the closest real corpus build instead of a tree grown from the class start and a generic kit.
// Only the main skill group is replaced by the candidate skill; everything else is the author's solution to the
// basics (mana, attributes, defences). Pure ranking here; the engine part lives in design-generate.mjs.
import path from 'node:path';
import fs from 'node:fs';
import { corpusDirectory } from './corpus.mjs';
import { readCards, qualityFilter } from './corpus-learn.mjs';
import { referenceDb, priceQuery } from './reference-store.mjs';

const DOT_FORMS = new Set(['skill_dot', 'ignite', 'poison', 'bleed']);
const stem = f => String(f ?? '').replace(/\.(xml|json)$/i, '');
// Card damage form -> generator form family (design-blueprint damageFormOf).
export function cardFamily(card) {
  const tags = new Set(card.skills?.main?.tags ?? []);
  if (card.damage?.scope === 'minion' || tags.has('minion')) return 'minion';
  if (tags.has('totem')) return 'totem';
  if (tags.has('trap') || tags.has('mine')) return 'trap_mine';
  if (tags.has('brand')) return 'brand';
  if (DOT_FORMS.has(card.damage?.primary_form) && !tags.has('attack')) return 'damage_over_time';
  return tags.has('attack') ? 'attack_hit' : 'spell_hit';
}

// Similarity of a corpus build to a candidate skill: the same skill dominates; then the same form family (attack vs
// spell vs DoT vs minion decides tree, items and sustain), shared gem tags and the main damage type.
export function seedScore(card, { skill, form, damageTypes = [], tags = [] }) {
  const reasons = [];
  let s = 0;
  if (card.features?.main_skill === skill) { s += 100; reasons.push('same_skill'); }
  const fam = cardFamily(card);
  if (fam === form) { s += 20; reasons.push(`form:${form}`); }
  else if ((fam === 'attack_hit') !== (form === 'attack_hit') || (fam === 'minion') !== (form === 'minion')) s -= 30;
  const shared = (card.skills?.main?.tags ?? []).filter(t => tags.includes(t) && !['grants_active_skill', 'intelligence', 'strength', 'dexterity', 'active_skill'].includes(t));
  s += 3 * shared.length; if (shared.length) reasons.push(`tags:${shared.join(',')}`);
  if (damageTypes.length && card.features?.primary_type && damageTypes.includes(card.features.primary_type)) { s += 10; reasons.push(`type:${card.features.primary_type}`); }
  return { score: s, reasons };
}

// Lower bound of a seed's unique-item cost in divine (cheapest stored variant per unique, poe.ninja divineValue of
// one snapshot: no chaos/divine conversion). Rares have no price: the bound is a floor, never a full budget.
export function uniqueCostFloor(uniques = [], lookup) {
  let div = 0; const unknown = [], priced = [];
  for (const u of uniques) {
    const v = lookup(u);
    if (v == null) { unknown.push(u); continue; }
    div += v; priced.push({ name: u, divine: Math.round(v * 10) / 10 });
  }
  return { divine_floor: Math.round(div * 10) / 10, priced, unknown };
}
let priceDb = null;
export function defaultUniqueLookup(platform = 'pc') {
  return name => {
    try {
      priceDb ??= referenceDb(undefined, { readOnly: true });
      const r = priceQuery('get', name, priceDb, { platform, limit: 20 }).results.map(x => x.variant?.divineValue).filter(v => typeof v === 'number' && v >= 0);
      return r.length ? Math.min(...r) : null;
    } catch { return null; }
  };
}

// Best seeds for one candidate row: quality-filtered cards of the same ascendancy whose main group is a normal
// (not item-granted) group, sorted by similarity, then level. With budgetDivine, seeds whose unique-cost floor
// already exceeds the budget come after every seed within it (their strength would come from gear the request cannot buy).
export function seedsFor(row, gem, { cards = null, minLevel = 80, top = 1, directory = corpusDirectory(), budgetDivine = null, lookup = null } = {}) {
  const list = cards ?? readCards();
  const q = qualityFilter(list, { minLevel });
  const want = { skill: gem.name, form: row.form, damageTypes: row.damage_types ?? [], tags: gem.tags ?? [] };
  const priceOf = budgetDivine != null ? (lookup ?? defaultUniqueLookup()) : null;
  return list.filter(c => q.keep.has(stem(c.identity?.file ?? c._card)) && c.features?.ascendancy === row.ascendancy)
    .map(c => {
      const s = seedScore(c, want);
      if (!priceOf) return { card: c, ...s };
      const cost = uniqueCostFloor(c.features?.uniques ?? [], priceOf);
      const over = cost.divine_floor > budgetDivine;
      return { card: c, score: s.score, over, reasons: over ? [...s.reasons, `over_budget:${cost.divine_floor}div>${budgetDivine}`] : s.reasons, cost };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => (a.over ? 1 : 0) - (b.over ? 1 : 0) || b.score - a.score || (b.card.identity?.level ?? 0) - (a.card.identity?.level ?? 0) || stem(a.card.identity?.file).localeCompare(stem(b.card.identity?.file)))
    .slice(0, top)
    .map(x => ({ xml: path.join(directory, 'xml', `${stem(x.card.identity.file)}.xml`), file: stem(x.card.identity.file), main_skill: x.card.features?.main_skill ?? null,
      main_group: x.card.skills?.main_selection?.chosen_group ?? null, level: x.card.identity?.level ?? null, source: x.card.identity?.source ?? null, score: x.score, reasons: x.reasons, unique_cost_floor: x.cost ?? null }))
    .filter(s => fs.existsSync(s.xml));
}

// Seed configuration (WP11 stage 1): the author's Configuration tab describes the author's skill and play (charges,
// "been hit recently", enemy conditions, Pantheon) and is not part of the architecture. A seeded prototype replaces the
// main skill, so it runs on the configuration of a new PoB build (defaults of PoB's ConfigTab:NewConfigSet, read from
// the class base run) like scratch prototypes do. Pure: author/defaults = runPob `config` tables; scenario keys stay
// with the scenario. Keys without a default (nil in PoB) reset to false/0: PoB applies a check only when true and a
// count only when non-zero. Custom modifier blocks are not inputs and are reported, not reset.
export function neutralConfig(author = {}, defaults = {}, scenarioKeys = []) {
  const skip = new Set(scenarioKeys), config = {}, kept = [];
  for (const [k, v] of Object.entries(author)) {
    if (skip.has(k) || k === 'customMods' || JSON.stringify(defaults[k]) === JSON.stringify(v)) continue;
    if (k in defaults) config[k] = defaults[k];
    else if (typeof v === 'boolean') config[k] = false;
    else if (typeof v === 'number') config[k] = 0;
    else kept.push(k);
  }
  return { config, reset: Object.keys(config).sort(), kept };
}
