// WP9: executable preconditions/conflicts from mechanic cards, for build prototypes (WP5 generator) and saved builds.
// Offline: works on a small prototype spec, or on `pob inspect` output (+ optional `pob run` result). The rules are
// pure functions of the spec; only `skill_source_required` reads the pinned skill snapshot (read-only, memoized,
// injectable as `spec.source_catalog`).
//
// Prototype spec (all fields optional; a missing field makes dependent rules return "unknown", never "pass"):
// { ascendancy: 'Occultist', ascendancy_nodes: ['Profane Bloom', ...], keystones: ['Mind Over Matter', ...],
//   skills: [{ label, enabled: true, gems: ['Blasphemy', 'Frostbite'], gem_ids: ['Blasphemy', ...] }], items: ['Viscera ...'],
//   recovery: ['life_recoup', 'life_leech', ...], config: { usePowerCharges: true }, curse_limit: 1,
//   explode_sources: ['Profane Bloom'], charge_sources: ['Cold Snap of Power'],
//   active_skills: [PoB active-skill flags] or buttons: buttonEstimate output, source_catalog: deriveSourceCatalog(...) }
//
// Statuses: pass | fail (mechanically impossible or the effect never happens) | warn (likely wrong, needs a source)
// | unknown (not enough data) | not_applicable.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { classifySkill } from './build-card.mjs';

// Curse gems of 3.30 (hexes and marks). Marks are curses but cannot be supported by Blasphemy (hex-only aura curse).
export const hexes = ['Frostbite', 'Flammability', 'Conductivity', 'Vulnerability', 'Despair', 'Elemental Weakness', 'Enfeeble', 'Temporal Chains', 'Punishment'];
export const marks = ["Assassin's Mark", "Poacher's Mark", "Warlord's Mark", "Sniper's Mark"];
const curseAppliers = ['Blasphemy', 'Hextouch', 'Curse On Hit', 'Bane', 'Impending Doom'];
const corpseSkills = ['Detonate Dead', 'Volatile Dead', 'Corpse Pact', 'Cremation', 'Unearth', 'Desecrate', 'Dark Pact', 'Bodyswap'];
const corpseMakers = ['Desecrate', 'Unearth', 'Cremation'];
// Gems/supports that generate power charges in a common way; tree and item sources are not listed (rule says unknown).
const powerChargeGems = /of Power|Assassin's Mark|Power Charge On Critical|Charged Traps|Kinetic Instability|Inspiration/i;
const frenzyChargeGems = /Frenzy|Poacher's Mark|Blood Rage|Chain Hook/i;
const enduranceChargeGems = /Enduring Cry|Endurance Charge on Melee Stun|Warlord's Mark|Ancestral Warchief|Infernal Cry|Seismic Cry/i;

const baseName = n => String(n ?? '').replace(/ of (Power|Ruin|Siphoning|Ire|Conflux|Fission|Expulsion|Instability|Dirt|Penetration|Storms|Transference|Weaponry)$/i, '').trim();
const isCurse = n => hexes.includes(baseName(n)) || marks.includes(baseName(n));
const enabledGroups = spec => (spec.skills ?? []).filter(s => s.enabled !== false && s.enabled !== 'false');
const lower = list => (list ?? []).map(x => String(x).toLowerCase());

const result = (id, card, gap, status, evidence) => ({ id, card, gap, status, evidence });

// Skill names that the button estimate (build-card `buttonEstimate`, WP1) counts as keys the player presses, or null
// when the spec carries neither PoB active-skill flags nor a ready estimate.
function buttonKeyNames(spec) {
  if (spec.buttons && (spec.buttons.pressed || spec.buttons.utility)) {
    const names = [...(spec.buttons.pressed ?? []), ...(spec.buttons.utility ?? []), ...(spec.buttons.uncertain ?? [])].map(x => String(x?.name ?? x));
    return new Set(names);
  }
  if (!Array.isArray(spec.active_skills)) return null;
  const names = new Set();
  for (const s of spec.active_skills) {
    if (!s?.name) continue;
    const kind = classifySkill(s).kind;
    if (kind === 'pressed' || kind === 'utility' || kind === 'uncertain') names.add(s.name);
  }
  return names;
}

// ---------- WP9: skills that need an entity another skill must provide (derived, not a hand list) ----------
// Blade Blast detonates Lingering Blades, Detonate Dead consumes a corpse, Detonate Mines detonates placed mines:
// PoB multiplies damage by a Config stage/corpse count and never asks where the entity comes from. The pair
// "who needs it / who makes it" is derived from the pinned skill data (knowledge DB rows `gems` and
// `granted_skills`, RePoE 3.30.0.4 `active_skill`: skill types, description, stat ids) by three machine routes:
//   types  - a skill type `Destroys<Entity>` needs the entity, `Creates<Entity>` provides it;
//   text   - the entity is the direct object of a consuming verb (detonate/consume/destroy/target) in the
//            skill's own description, or the subject of "explodes" near the entity word;
//   stats  - a skill provides the entity when one of its stat ids names making or leaving it
//            (`..._blade_left_in_ground_for_every_X_volleys`); a bare cap (`maximum_number_of_blades...`,
//            `number_of_corpses_to_consume`) is a count, not production, and does not count. A skill type that
//            names the entity provides it too (`RemoteMined` -> mine), while a capability type does not
//            (`Mineable` only means the skill can be put in a mine).
// An entity with no provider anywhere in the data is not judgeable (kept in `unjudgeable`): the rule stays
// silent instead of guessing. Whether the provider keeps the entity up during a fight is a PoB gap, not a
// rule - see gap `skill_source_uptime` in mechanics/gaps.mjs.
const FILLER = /^(?:any|all|some|multiple|your|a|an|the|of|up|to|nearby|and|other|more|own|from|its|at)$/i;
const CONSUME_VERB = /^(?:detonat|consum|destro|target)/i;
const ENTITY_WORD = /^[A-Z][a-z]{2,}$/;
// A stat id that only counts or caps the entity is not a source of it.
const COUNT_ONLY_STAT = /^(?:maximum_)?number_of_|_to_consume(?:_|$)|^maximum_/;
// The entity must be what the stat creates, next to the verb - not a condition elsewhere in the id
// ("..._blade_left_in_ground_for_every_X_volleys" makes blades, "create_barnacle_..._vs_rare_unique" does not make rares).
const MAKE_VERB = 'create[ds]?|spawn(?:s|ed)?|place[ds]?|summon(?:s|ed)?|leave[s]?|left|drop(?:s|ped)?';
const MADE_SUFFIX = 'left_in_ground|on_ground|created|spawned|placed|summoned|dropped';
const makesEntity = (token, head) => new RegExp(`(?:^|_)(?:(?:${MAKE_VERB})_(?:${token}|${head})s?|(?:${token}|${head})s?_(?:${MADE_SUFFIX}))(?:_|$)`);
const CAPABILITY_TYPE = /able$|^Destroys/;
// A thing that most skills provide is a property, not an entity a build must arrange for (705 active skills in 3.30).
const ENTITY_MAX_SKILLS = 25;
const camelWords = t => String(t).split(/(?=[A-Z])/).map(w => w.toLowerCase()).filter(Boolean);

const titleSingular = e => String(e).trim().replace(/s$/, '');
const entityHead = e => titleSingular(e).toLowerCase().split(/\s+/).pop();
const entityToken = e => titleSingular(e).toLowerCase().replace(/\s+/g, '_');

// Direct object of a verb: skip determiners/prepositions, then take 1-3 capitalised words ("any of your Lingering Blades").
export function objectsAfter(description, verbRe) {
  const out = [], words = String(description ?? '').split(/[\s,]+/);
  for (let i = 0; i < words.length; i++) {
    if (!verbRe.test(words[i].replace(/[^A-Za-z]/g, ''))) continue;
    let j = i + 1;
    for (let k = 0; k < 4 && j < words.length && FILLER.test(words[j]); k++) j++;
    const phrase = [];
    while (j < words.length && phrase.length < 3 && ENTITY_WORD.test(words[j].replace(/[.;:]$/, ''))) phrase.push(words[j++].replace(/[.;:]$/, ''));
    if (phrase.length) out.push(phrase.join(' '));
  }
  return out;
}

// skills: [{ id, name, types: [], description, stat_ids: [] }] from the pinned skill data.
export function deriveSourceCatalog(skills = []) {
  const entities = new Map();
  const rec = e => { const k = titleSingular(e); if (!entities.has(k)) entities.set(k, { entity: k, consumers: new Map(), providers: new Map() }); return entities.get(k); };
  const mark = (e, side, skill, how) => { const m = rec(e)[side]; if (!m.has(skill.name)) m.set(skill.name, { name: skill.name, id: skill.id ?? null, how }); };
  for (const s of skills) {
    for (const t of s.types ?? []) {
      const d = /^Destroys(.+)$/.exec(t); if (d) mark(d[1], 'consumers', s, `skill_type:${t}`);
      const c = /^Creates(.+)$/.exec(t); if (c) mark(c[1], 'providers', s, `skill_type:${t}`);
    }
    for (const e of objectsAfter(s.description, CONSUME_VERB)) mark(e, 'consumers', s, 'description:consume_object');
  }
  const typedEntities = new Set([...entities.keys()].filter(k => [...entities.get(k).consumers.values(), ...entities.get(k).providers.values()].some(x => x.how.startsWith('skill_type:Creates') || x.how.startsWith('skill_type:Destroys'))));
  for (const r of [...entities.values()]) {
    const head = entityHead(r.entity), token = entityToken(r.entity);
    const inStat = new RegExp(`(?:^|_)(?:${token}|${head})s?(?:_|$)`);
    const makes = makesEntity(token, head);
    const asWord = new RegExp(`^${head}(?:s|d|ed)?$`);
    const inText = new RegExp(`\\b${head}s?\\b[^.]{0,40}\\bexplod|\\btarget\\w*\\s+(?:\\w+\\s+){0,3}${head}s?\\b`, 'i');
    r.attested = typedEntities.has(r.entity) || skills.some(s => (s.stat_ids ?? []).some(id => inStat.test(id)));
    for (const s of skills) {
      if ((s.stat_ids ?? []).some(id => makes.test(id) && !COUNT_ONLY_STAT.test(id))) mark(r.entity, 'providers', s, 'stat_id:makes_entity');
      else if ((s.types ?? []).some(t => !CAPABILITY_TYPE.test(t) && camelWords(t).some(w => asWord.test(w)))) mark(r.entity, 'providers', s, 'skill_type:names_entity');
      if (!r.providers.has(s.name) && inText.test(s.description ?? '')) mark(r.entity, 'consumers', s, 'description:entity_targeted_or_exploded');
    }
  }
  // An entity is judgeable only when the data names it as an object (stat id or Creates/Destroys type), both sides
  // exist, and it is a discrete entity rather than a property of most skills (cardinality limit).
  const judgeable = [], unjudgeable = [];
  for (const r of entities.values()) {
    const row = { entity: r.entity, head: entityHead(r.entity), consumers: [...r.consumers.values()], providers: [...r.providers.values()] };
    const ok = r.attested && row.providers.length && row.consumers.length && row.providers.length <= ENTITY_MAX_SKILLS && row.consumers.length <= ENTITY_MAX_SKILLS;
    (ok ? judgeable : unjudgeable).push(row);
  }
  const byConsumer = new Map();
  for (const r of judgeable) for (const c of r.consumers) {
    if (!byConsumer.has(c.name)) byConsumer.set(c.name, []);
    byConsumer.get(c.name).push({ entity: r.entity, how: c.how, providers: r.providers.map(p => p.name) });
    if (c.id && !byConsumer.has(c.id)) byConsumer.set(c.id, byConsumer.get(c.name));
  }
  const providerNames = new Map();
  for (const r of judgeable) for (const p of r.providers) {
    for (const key of [p.name, p.id].filter(Boolean)) {
      if (!providerNames.has(key)) providerNames.set(key, new Set());
      providerNames.get(key).add(r.entity);
    }
  }
  return { entities: judgeable, unjudgeable: unjudgeable.map(r => ({ entity: r.entity, consumers: r.consumers.map(c => c.name), providers: r.providers.map(p => p.name) })),
    requirementsOf: key => byConsumer.get(key) ?? [], providesOf: key => providerNames.get(key) ?? new Set(),
    note: 'Derived from the pinned skill data (skill types, descriptions, stat ids); entities without a known provider are in `unjudgeable`.' };
}

// Pinned skill data from the knowledge snapshot (read-only, no network). Returns null when the snapshot is absent,
// and the rule then reports `unknown` instead of guessing.
export function readSkillData(db) {
  const skills = [];
  for (const row of db.prepare("SELECT id, name, payload_json FROM records WHERE category IN ('gems', 'granted_skills')").all()) {
    const payload = JSON.parse(row.payload_json);
    if (payload.is_support || !payload.active_skill) continue;
    const statIds = new Set();
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (typeof o.id === 'string' && o.type) statIds.add(o.id);
      for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
    };
    walk(payload);
    skills.push({ id: row.id, name: row.name, types: payload.active_skill.types ?? [], description: payload.active_skill.description ?? '', stat_ids: [...statIds] });
  }
  return skills;
}

let catalogCache;
export function sourceCatalog() {
  if (catalogCache !== undefined) return catalogCache;
  catalogCache = null;
  try {
    const file = fileURLToPath(new URL('../data/knowledge-3.30.sqlite', import.meta.url));
    if (!fs.existsSync(file)) return catalogCache;
    const db = new DatabaseSync(file, { readOnly: true });
    try { catalogCache = deriveSourceCatalog(readSkillData(db)); } finally { db.close(); }
  } catch { catalogCache = null; }
  return catalogCache;
}

export const rules = {
  // Profane Bloom: cursed enemies killed explode. No curse source = no explosions (PoB keeps the explosion group anyway).
  profane_bloom_curse(spec) {
    const nodes = lower(spec.ascendancy_nodes), explode = lower(spec.explode_sources);
    const has = nodes.includes('profane bloom') || explode.includes('profane bloom');
    if (!has) return result('profane_bloom_curse', 'curse-limit', 'on_kill_explosions', spec.ascendancy_nodes || spec.explode_sources ? 'not_applicable' : 'unknown', 'Profane Bloom not in ascendancy_nodes/explode_sources.');
    if (!spec.skills) return result('profane_bloom_curse', 'curse-limit', 'on_kill_explosions', 'unknown', 'No skills in the prototype.');
    const curses = enabledGroups(spec).flatMap(g => g.gems ?? []).filter(isCurse);
    const fromItems = lower(spec.items).some(i => /curse enemies|hextouch|curse on hit/.test(i));
    if (curses.length) return result('profane_bloom_curse', 'curse-limit', 'on_kill_explosions', 'pass', `Curse source: ${[...new Set(curses)].join(', ')}.`);
    return result('profane_bloom_curse', 'curse-limit', 'on_kill_explosions', fromItems ? 'warn' : 'fail', fromItems ? 'No curse gem; an item may curse - verify.' : 'Profane Bloom without any curse: explosions never happen (PoB still lists the group).');
  },
  // More distinct curses than the curse limit: only `limit` apply at once.
  curse_limit(spec) {
    if (!spec.skills) return result('curse_limit', 'curse-limit', 'curse_application', 'unknown', 'No skills in the prototype.');
    const curses = [...new Set(enabledGroups(spec).flatMap(g => g.gems ?? []).filter(isCurse).map(baseName))];
    const limit = Number.isInteger(spec.curse_limit) ? spec.curse_limit : 1;
    if (!curses.length) return result('curse_limit', 'curse-limit', 'curse_application', 'not_applicable', 'No curse gems.');
    if (curses.length <= limit) return result('curse_limit', 'curse-limit', 'curse_application', 'pass', `${curses.length} curse(s) within limit ${limit}${spec.curse_limit == null ? ' (default 1; tree/items may raise it)' : ''}.`);
    return result('curse_limit', 'curse-limit', 'curse_application', spec.curse_limit == null ? 'warn' : 'fail', `${curses.length} curses (${curses.join(', ')}) over limit ${limit}${spec.curse_limit == null ? ' (default; pass curse_limit or PoB EnemyCurseLimit)' : ''}.`);
  },
  // Blasphemy needs a hex in its group and cannot support marks.
  blasphemy_hex(spec) {
    if (!spec.skills) return result('blasphemy_hex', 'curse-limit', 'curse_application', 'unknown', 'No skills in the prototype.');
    const groups = enabledGroups(spec).filter(g => (g.gems ?? []).some(n => baseName(n) === 'Blasphemy'));
    if (!groups.length) return result('blasphemy_hex', 'curse-limit', 'curse_application', 'not_applicable', 'No Blasphemy.');
    const bad = groups.filter(g => !(g.gems ?? []).some(n => hexes.includes(baseName(n))));
    const markGroups = groups.filter(g => (g.gems ?? []).some(n => marks.includes(baseName(n))));
    if (bad.length) return result('blasphemy_hex', 'curse-limit', 'curse_application', 'fail', `Blasphemy without a hex in group(s): ${bad.map(g => g.label ?? '?').join(', ')}${markGroups.length ? ' (marks cannot be supported by Blasphemy)' : ''}.`);
    return result('blasphemy_hex', 'curse-limit', 'curse_application', markGroups.length ? 'warn' : 'pass', markGroups.length ? 'Mark linked to Blasphemy is not supported by it.' : 'Blasphemy links a hex.');
  },
  // Chaos Inoculation sets life to 1: life recoup/leech/regeneration plans give nothing.
  ci_life_recovery(spec) {
    const ks = lower(spec.keystones);
    if (!spec.keystones) return result('ci_life_recovery', 'low-life-ci-hybrid', 'recoup', 'unknown', 'No keystones in the prototype.');
    if (!ks.includes('chaos inoculation')) return result('ci_life_recovery', 'low-life-ci-hybrid', 'recoup', 'not_applicable', 'No Chaos Inoculation.');
    const life = lower(spec.recovery).filter(r => r.startsWith('life_'));
    return life.length ? result('ci_life_recovery', 'low-life-ci-hybrid', 'recoup', 'fail', `Chaos Inoculation (Life = 1) with life recovery: ${life.join(', ')}.`)
      : result('ci_life_recovery', 'low-life-ci-hybrid', 'recoup', 'pass', 'No life-based recovery with CI.');
  },
  // Eldritch Battery + Mind Over Matter: ES protects mana, and mana both pays skills and takes MoM damage.
  eb_mom_shared_pool(spec) {
    const ks = lower(spec.keystones);
    if (!spec.keystones) return result('eb_mom_shared_pool', 'eldritch-battery-mom', null, 'unknown', 'No keystones in the prototype.');
    if (!(ks.includes('eldritch battery') && ks.includes('mind over matter'))) return result('eb_mom_shared_pool', 'eldritch-battery-mom', null, 'not_applicable', 'Not both Eldritch Battery and Mind Over Matter.');
    return result('eb_mom_shared_pool', 'eldritch-battery-mom', null, 'warn', 'Eldritch Battery + Mind Over Matter: one ES/mana pool pays skills and absorbs damage; check sustain under continuous casting and hits.');
  },
  // Corpse skills need corpses: boss fights and the first pack have none without a corpse maker.
  corpse_source(spec) {
    if (!spec.skills) return result('corpse_source', 'uptime', 'corpse_availability', 'unknown', 'No skills in the prototype.');
    const gems = enabledGroups(spec).flatMap(g => g.gems ?? []).map(baseName);
    const users = gems.filter(n => corpseSkills.includes(n) && !corpseMakers.includes(n));
    if (!users.length) return result('corpse_source', 'uptime', 'corpse_availability', 'not_applicable', 'No corpse-consuming skill.');
    const makers = gems.filter(n => corpseMakers.includes(n));
    return makers.length ? result('corpse_source', 'uptime', 'corpse_availability', 'pass', `Corpse maker: ${makers.join(', ')}.`)
      : result('corpse_source', 'uptime', 'corpse_availability', 'warn', `${[...new Set(users)].join(', ')} without Desecrate/Unearth: no corpses at bosses or the first pack.`);
  },
  // A skill that needs an entity another skill creates (Lingering Blades, corpses, placed mines): the entity must have
  // a source among the prototype's own skill groups, and that source is a key the player presses.
  skill_source_required(spec) {
    const r = (status, evidence, extra = {}) => ({ ...result('skill_source_required', 'uptime', 'skill_source_uptime', status, evidence), ...extra });
    if (!spec.skills) return r('unknown', 'No skills in the prototype.');
    const catalog = spec.source_catalog ?? sourceCatalog();
    if (!catalog) return r('unknown', 'Pinned skill data (knowledge snapshot) unavailable: cannot derive which skills need a source.');
    const groups = enabledGroups(spec);
    const keys = [...new Set(groups.flatMap(g => [...(g.gems ?? []), ...(g.gem_ids ?? [])]).map(String))];
    const required = new Map();
    for (const key of keys) for (const req of catalog.requirementsOf(key)) {
      const seen = required.get(req.entity);
      if (seen) { if (!seen.needed_by.includes(key)) seen.needed_by.push(key); continue; }
      required.set(req.entity, { entity: req.entity, needed_by: [key], how: req.how, known_providers: req.providers });
    }
    if (!required.size) return r('not_applicable', 'No skill in the prototype needs an entity another skill creates.');
    const provided = new Set(keys.flatMap(key => [...catalog.providesOf(key)]));
    const sources = { entities: [...required.values()].map(x => ({ entity: x.entity, needed_by: x.needed_by[0], derived_from: x.how, provided: provided.has(x.entity) })) };
    const missing = [...required.values()].filter(x => !provided.has(x.entity));
    if (missing.length) return r('fail', missing.map(x => `${x.needed_by[0]} needs ${x.entity}: no skill group of the prototype creates ${x.entity} (skills that do: ${x.known_providers.slice(0, 4).join(', ')}${x.known_providers.length > 4 ? ', ...' : ''}); PoB multiplies damage by a Config count of ${x.entity} regardless.`).join(' '), { sources });
    // Source present: its placement is a pressed key and must be inside the button estimate.
    const pressedNames = buttonKeyNames(spec);
    const present = [...required.values()].map(x => ({ entity: x.entity, providers: x.known_providers.filter(p => keys.includes(p)) }));
    const evidence = present.map(x => `${x.entity} from ${x.providers.join(', ') || 'a skill of the prototype'}`).join('; ');
    if (!pressedNames) return r('pass', `Source present: ${evidence}. Button accounting not checked (no PoB active skills or button estimate in the spec).`, { sources });
    const uncounted = present.flatMap(x => x.providers.filter(p => !pressedNames.has(p)).map(p => `${p} (source of ${x.entity})`));
    return uncounted.length ? r('warn', `Source present but not counted as a pressed key: ${uncounted.join(', ')}. The button estimate understates how many keys the build needs.`, { sources })
      : r('pass', `Source present and counted as a pressed key: ${evidence}.`, { sources });
  },
  // Ascendancy points: 8 in total, a Bloodline spends the same budget.
  ascendancy_budget(spec) {
    if (!spec.ascendancy_nodes && spec.ascendancy_points == null) return result('ascendancy_budget', 'ascendancy-budget', null, 'unknown', 'No ascendancy_nodes in the prototype.');
    const n = spec.ascendancy_points ?? spec.ascendancy_nodes.length;
    return n <= 8 ? result('ascendancy_budget', 'ascendancy-budget', null, 'pass', `${n} of 8 ascendancy points${spec.ascendancy_points == null ? ' (counted as nodes; small nodes and paths may cost more)' : ''}.`)
      : result('ascendancy_budget', 'ascendancy-budget', null, 'fail', `${n} ascendancy points exceed 8 (Bloodline included in the same budget).`);
  },
  // Config charges at maximum need a generator (card charges/uptime).
  config_charge_sources(spec) {
    const c = spec.config ?? null;
    if (!c) return result('config_charge_sources', 'charges', 'charges_and_buffs', 'unknown', 'No config in the prototype.');
    const gems = enabledGroups(spec).flatMap(g => g.gems ?? []).concat(spec.charge_sources ?? []);
    const missing = [['usePowerCharges', powerChargeGems, 'power'], ['useFrenzyCharges', frenzyChargeGems, 'frenzy'], ['useEnduranceCharges', enduranceChargeGems, 'endurance']]
      .filter(([flag, re]) => c[flag] && !gems.some(n => re.test(n))).map(([, , k]) => k);
    const used = ['usePowerCharges', 'useFrenzyCharges', 'useEnduranceCharges'].filter(f => c[f]);
    if (!used.length) return result('config_charge_sources', 'charges', 'charges_and_buffs', 'not_applicable', 'No charges enabled in config.');
    return missing.length ? result('config_charge_sources', 'charges', 'charges_and_buffs', 'warn', `Config uses ${missing.join(', ')} charges without a gem source; tree/items may provide one (pass charge_sources).`)
      : result('config_charge_sources', 'charges', 'charges_and_buffs', 'pass', 'Every enabled charge type has a gem source.');
  }
};

export function validatePrototype(spec, { only = null } = {}) {
  const ids = only ?? Object.keys(rules);
  const checks = ids.map(id => { if (!rules[id]) throw new Error(`Unknown validator rule: ${id}. Known: ${Object.keys(rules).join(', ')}`); return rules[id](spec ?? {}); });
  const count = s => checks.filter(c => c.status === s).length;
  return { valid: count('fail') === 0, counts: { fail: count('fail'), warn: count('warn'), unknown: count('unknown'), pass: count('pass'), not_applicable: count('not_applicable') }, checks,
    note: 'Rule checks from mechanic cards (WP9); "unknown" means the prototype lacks the field, not that the mechanic is fine.' };
}

// Spec from `pob inspect` output (+ optional `pob run` result for explode sources and keystones of the calculation).
export function specFromInspect(inspect, run = null) {
  const skills = (inspect.skills ?? []).filter(s => s.label !== 'On Kill Monster Explosion')
    .map(s => { const gems = (s.gems ?? []).filter(g => g.enabled !== 'false' && g.name);
      const ids = gems.map(g => g.skill_id).filter(Boolean);
      return { label: s.label, enabled: s.enabled !== 'false', gems: gems.map(g => g.name), ...(ids.length ? { gem_ids: ids } : {}) }; });
  const spec = { ascendancy: inspect.ascendancy ?? null, skills, config: inspect.config ?? {} };
  if (!run) return spec;
  const o = run.output ?? {};
  spec.explode_sources = (run.explode_mods ?? []).map(m => m.source_name).filter(Boolean);
  if (Array.isArray(run.active_skills)) spec.active_skills = run.active_skills;
  if (Array.isArray(run.equipped_items)) spec.items = run.equipped_items.map(i => [i.name, i.base].filter(Boolean).join(' '));
  if (Number.isFinite(run.budget?.ascendancy_used)) spec.ascendancy_points = run.budget.ascendancy_used;
  if (Number.isFinite(o.EnemyCurseLimit)) spec.curse_limit = o.EnemyCurseLimit;
  spec.recovery = [['life_recoup', o.LifeRecoup], ['life_leech', o.LifeLeechGainRate], ['life_regen', o.LifeRegenRecovery], ['es_recoup', o.EnergyShieldRecoup]]
    .filter(([, v]) => v > 0).map(([k]) => k);
  return spec;
}
