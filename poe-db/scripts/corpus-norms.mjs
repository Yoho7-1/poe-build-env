// Corpus norms of build basics (WP5b): how real 3.30 builds of the corpus solve mana/life sustain, how much attribute
// headroom they carry, how many masteries, eldritch implicits, cluster jewels and automatic flasks they use and which
// keystones go with which archetype. Facts per build come from BuildCard.foundation (build-foundation.mjs: PoB output
// and PoB XML); this module only counts. Cards without a foundation are backfilled once from the stored corpus XML with
// the same scenario and main socket group (cached PoB run). Norms are descriptive (what guides do), not proof of optimality.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, flags } from './workspace.mjs';
import { runPob } from './pob.mjs';
import { readBuild, pobGems } from './analysis-candidates.mjs';
import { loadTree } from './tree-graph.mjs';
import { cardDirectory } from './build-card.mjs';
import { corpusDirectory } from './corpus.mjs';
import { readCards, qualityFilter } from './corpus-learn.mjs';
import { foundationOf, foundationCheck, FOUNDATION_SCHEMA } from './build-foundation.mjs';

const stem = f => String(f ?? '').replace(/\.(xml|json)$/i, '');
const cardStem = c => stem(c.identity?.file ?? c._card);
const DOT_FORMS = new Set(['skill_dot', 'ignite', 'poison', 'bleed']);

// ---------- backfill ----------
export function foundationFromXml({ file, card, tree = null }) {
  const build = readBuild(file);
  const chosen = card.skills?.main_selection?.chosen_group ?? build.main_socket_group;
  const changes = chosen !== build.main_socket_group ? { selection: { main_socket_group: chosen } } : {};
  const r = runPob({ input: fs.readFileSync(file), scenario: card.identity?.scenario ?? 'sustained', full: true, changes });
  return foundationOf({ build, output: r.output ?? {}, equipped: r.equipped_items ?? [], tree, keystones: card.features?.keystones ?? [],
    scope: card.damage?.scope ?? 'player', uniques: card.features?.uniques ?? [] });
}
// Adds card.foundation where it is missing (or stale schema; refresh=true recomputes all). Card files keep every other field.
export function backfillFoundations({ cards = cardDirectory(), directory = corpusDirectory(), refresh = false, limit = null, compute = foundationFromXml } = {}) {
  let tree = null; try { tree = loadTree(); } catch { tree = null; }
  const done = [], failed = [], already = [];
  for (const c of readCards(cards)) {
    if (!refresh && c.foundation?.schema === FOUNDATION_SCHEMA) { already.push(c._card); continue; }
    if (limit != null && done.length >= limit) break;
    const xml = path.join(directory, 'xml', `${cardStem(c)}.xml`);
    if (!fs.existsSync(xml)) { failed.push({ card: c._card, error: 'corpus XML not found' }); continue; }
    try {
      const foundation = compute({ file: xml, card: c, tree });
      const { _card, ...stored } = c;
      atomicJson(path.join(cards, _card), { ...stored, foundation });
      done.push(_card);
    } catch (e) { failed.push({ card: c._card, error: e.message.slice(0, 300) }); }
  }
  return { backfilled: done.length, already: already.length, failed };
}

// ---------- statistics ----------
const quantiles = values => {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = p => { const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return Math.round((v[lo] + (v[hi] - v[lo]) * (i - lo)) * 10) / 10; };
  return { n: v.length, p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9) };
};
const shareOf = (list, pred) => list.length ? Math.round(list.filter(pred).length / list.length * 1000) / 1000 : null;
const counts = (list, key) => {
  const m = {};
  for (const x of list) for (const k of [].concat(key(x) ?? [])) m[k] = (m[k] ?? 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, n]) => ({ value, n, share: Math.round(n / list.length * 1000) / 1000 }));
};

export function matchesGroup(card, { ascendancy = null, skillTag = null, form = null } = {}) {
  if (ascendancy && !ascendancy.split(',').map(s => s.trim().toLowerCase()).includes(String(card.features?.ascendancy ?? '').toLowerCase())) return false;
  if (skillTag && !(card.skills?.main?.tags ?? []).includes(skillTag)) return false;
  if (form) {
    const f = card.damage?.primary_form ?? null;
    if (form === 'hit' && f !== 'hit') return false;
    if (form === 'dot' && !DOT_FORMS.has(f)) return false;
    if (!['hit', 'dot'].includes(form) && f !== form) return false;
  }
  return true;
}

// Norms over foundations. Mana norms use player-scope builds with a mana cost only (minion builds and life-cost builds
// answer a different question); every other part uses all matching builds.
export function normsOf(foundations) {
  const all = foundations;
  const mana = all.filter(f => f.mana?.applies);
  const attr = all.filter(f => f.attributes?.requirements_known && !f.attributes.omniscience);
  return {
    builds: all.length,
    mana: { builds: mana.length, primary: counts(mana, f => f.mana.primary), uses_leech: shareOf(mana, f => (f.mana.leech_per_s ?? 0) > 0),
      regen_primary_without_leech: shareOf(mana, f => f.mana.primary === 'regen' && !((f.mana.leech_per_s ?? 0) > 0)),
      sustain_deficit: shareOf(mana, f => (f.mana.sustain_per_s ?? 0) < 0), sustain_per_s: quantiles(mana.map(f => f.mana.sustain_per_s)),
      regen_share: quantiles(mana.map(f => f.mana.regen_share)), reserved_pct: quantiles(mana.map(f => f.mana.reserved_pct)) },
    life: { primary: counts(all, f => f.life?.primary), uses_leech: shareOf(all, f => (f.life?.leech_per_s ?? 0) > 0), uses_recoup: shareOf(all, f => (f.life?.recoup_pct ?? 0) > 0),
      regen_pct: quantiles(all.map(f => f.life?.regen_pct)) },
    attributes: { builds: attr.length, slack_total: quantiles(attr.map(f => f.attributes.slack_total)), max_slack: quantiles(attr.map(f => f.attributes.max_slack)),
      unmet: shareOf(attr, f => f.attributes.unmet.length > 0) },
    masteries: { count: quantiles(all.map(f => f.masteries?.count)), none: shareOf(all, f => !f.masteries?.count), top: counts(all, f => (f.masteries?.effects ?? []).map(e => e.mastery).filter(Boolean)).slice(0, 12) },
    eldritch: { uses: shareOf(all, f => (f.eldritch?.items ?? 0) > 0), items: quantiles(all.map(f => f.eldritch?.items)), slots: counts(all, f => f.eldritch?.slots ?? []) },
    clusters: { uses: shareOf(all, f => (f.clusters?.total ?? 0) > 0), large: shareOf(all, f => (f.clusters?.large ?? 0) > 0), total: quantiles(all.map(f => f.clusters?.total)) },
    anoint: { uses: shareOf(all, f => !!f.anoint), top: counts(all.filter(f => f.anoint), f => f.anoint).slice(0, 10) },
    flasks: { auto: quantiles(all.map(f => f.flasks?.auto)), uses_auto: shareOf(all, f => (f.flasks?.auto ?? 0) > 0), manual: quantiles(all.map(f => f.flasks?.manual)) },
    keystones: { none: shareOf(all, f => !f.keystones?.length), top: counts(all, f => f.keystones ?? []).slice(0, 15) }
  };
}

export function corpusNorms({ cards = null, ascendancy = null, skillTag = null, form = null, all = false, minLevel = 80, minGroup = 8 } = {}) {
  const list = cards ?? readCards();
  const quality = all ? null : qualityFilter(list, { minLevel });
  const pool = list.filter(c => !quality || quality.keep.has(cardStem(c)));
  const withF = pool.filter(c => c.foundation?.schema === FOUNDATION_SCHEMA);
  const group = { ascendancy, skill_tag: skillTag, form };
  const grouped = Object.values(group).some(Boolean);
  const members = withF.filter(c => matchesGroup(c, { ascendancy, skillTag, form }));
  const out = { schema: 'corpus-norms/1', group, quality_filter: quality ? { min_level: minLevel, kept: quality.kept, cards: quality.cards } : 'off (--all)',
    builds_in_pool: pool.length, builds_with_foundation: withF.length, missing_foundation: pool.length - withF.length,
    norms: normsOf(members.map(c => c.foundation)), members: members.map(c => ({ file: cardStem(c), ascendancy: c.features?.ascendancy ?? null, main_skill: c.features?.main_skill ?? null, form: c.damage?.primary_form ?? null })) };
  if (grouped && members.length < minGroup) { out.small_group = true; out.note = `Group has ${members.length} < ${minGroup} builds: compare with corpus-wide norms (norms_all).`; out.norms_all = normsOf(withF.map(c => c.foundation)); }
  if (out.missing_foundation) out.hint = 'Run corpus norms --backfill to add foundations to older cards (one cached PoB run per card).';
  out.caveat = 'Descriptive: what popular 3.30 guides do (corpus is biased to YouTube guides); not proof of optimality. Numbers are PoB, not game tests.';
  return out;
}

// Foundation of any PoB file (prototype, user build) + check against the norms of its ascendancy (corpus-wide when the
// group is small). One full PoB run (cached); keystones from the active tree spec.
export function foundationOfXml(file, { scenario = 'sustained', tree = null } = {}) {
  const build = readBuild(file);
  const t = tree ?? (() => { try { return loadTree(); } catch { return null; } })();
  const r = runPob({ input: fs.readFileSync(file), scenario, full: true });
  const keystones = [...build.allocated].map(id => t?.nodes.get(Number(id))).filter(n => n?.type === 'keystone').map(n => n.name).sort();
  const uniques = (r.equipped_items ?? []).filter(i => String(i.rarity).toUpperCase() === 'UNIQUE').map(i => i.name);
  const scope = !(Number(r.output?.CombinedDPS ?? r.output?.TotalDPS ?? 0) > 0) && r.minion_output ? 'minion' : 'player';
  return foundationOf({ build, output: r.output ?? {}, equipped: r.equipped_items ?? [], tree: t, keystones, scope, uniques });
}
// Skill family of the main group for norm grouping: mana is solved differently by attacks (leech) and spells (regen)
// in the corpus, so the norm group is chosen in this order: ascendancy+family, family, ascendancy, whole corpus.
export function mainSkillFamily(build, gems = pobGems()) {
  const g = build.groups[(build.main_socket_group ?? 1) - 1];
  const tags = (g?.gems ?? []).filter(x => x.enabled).map(x => gems.get(x.skill_id)?.tags ?? {}).find(t => t.grants_active_skill) ?? {};
  return tags.minion ? 'minion' : tags.attack ? 'attack' : tags.spell ? 'spell' : null;
}
export function chooseNormGroup({ cards = null, ascendancy = null, family = null, minGroup = 8 } = {}) {
  const asc = ascendancy && ascendancy !== 'None' ? ascendancy : null;
  const tries = [asc && family ? { ascendancy: asc, skillTag: family } : null, family ? { skillTag: family } : null, asc ? { ascendancy: asc } : null, {}].filter(Boolean);
  for (const g of tries) {
    const n = corpusNorms({ cards, ...g, minGroup });
    if (n.norms.builds >= minGroup || !Object.keys(g).length) return { norms: n.norms, group: { ascendancy: g.ascendancy ?? null, skill_tag: g.skillTag ?? null, builds: n.norms.builds } };
  }
}
export function foundationReport({ file, scenario = 'sustained', ascendancy = null, cards = null, foundation = null, minGroup = 8 } = {}) {
  const f = foundation ?? foundationOfXml(file, { scenario });
  const build = readBuild(file);
  const asc = ascendancy ?? build.ascendancy ?? null;
  const family = mainSkillFamily(build);
  const list = cards ?? readCards();
  const { norms, group } = chooseNormGroup({ cards: list, ascendancy: asc, family, minGroup });
  return { foundation: f, check: foundationCheck(f, norms), norm_group: { ...group, requested: { ascendancy: asc, skill_family: family }, rule: `first group with >= ${minGroup} builds of: ascendancy+skill family, skill family, ascendancy, whole corpus` } };
}

export function normsCommand(args) {
  const { positional, options } = flags(args, ['ascendancy', 'skill-tag', 'form', 'min-level', 'min-group', 'limit', 'out', 'check', 'scenario'], ['all', 'backfill', 'refresh', 'members']);
  if (positional[0] !== 'norms') throw new Error('Use corpus norms [--ascendancy A,B] [--skill-tag t] [--form hit|dot|poison|ignite|...] [--backfill [--refresh] [--limit N]] [--all] [--members] | corpus norms --check <xml>');
  if (options.check) {
    const r = foundationReport({ file: path.resolve(options.check), scenario: options.scenario ?? 'sustained', ascendancy: options.ascendancy ?? null, minGroup: Number(options['min-group'] ?? 8) });
    if (options.out) atomicJson(path.resolve(options.out), r);
    return r;
  }
  const backfill = options.backfill || options.refresh ? backfillFoundations({ refresh: !!options.refresh, limit: options.limit ? Number(options.limit) : null }) : null;
  const r = corpusNorms({ ascendancy: options.ascendancy ?? null, skillTag: options['skill-tag'] ?? null, form: options.form ?? null, all: !!options.all,
    minLevel: Number(options['min-level'] ?? 80), minGroup: Number(options['min-group'] ?? 8) });
  if (!options.members) r.members = r.members.length;
  if (backfill) r.backfill = backfill;
  if (options.out) atomicJson(path.resolve(options.out), r);
  return r;
}
export const normsHelp = {
  'corpus norms [--ascendancy A,B] [--skill-tag spell] [--form hit|dot|poison|...] [--backfill [--refresh] [--limit N]] [--members] [--all] [--out f.json]':
    'corpus norms --check <xml> [--ascendancy A] checks one build (prototype or own) against the norms of its ascendancy (warnings, not failures). Norms of build basics over quality-filtered corpus cards:mana/life sustain sources (leech vs regen, deficit), attribute headroom, masteries, eldritch implicits, cluster jewels, anoint, automatic flasks, keystones. --backfill adds BuildCard.foundation to older cards (cached PoB run). Small groups (< --min-group 8) also get corpus-wide norms. Descriptive, not optimal.'
};
