// WP5 Build Request Mode, pure part: request schema (from a build profile or JSON), Architecture Blueprint schema
// and validation, data-driven skill/theme/axis rules, hard filters, button count, diversity and Pareto front.
// Nothing here reads files or runs the engine (design-generate.mjs does). Rules are generic tables over RePoE skill
// types/tags and passive stat text; they choose what to try, PoB decides the numbers.

export const REQUEST_SCHEMA = 'poe-design-request/1';
export const BLUEPRINT_SCHEMA = 'poe-design-blueprint/1';

// ---------- data tables ----------

// Class -> main attributes (gem colour affinity) and the defensive pool family used by the item kit.
export const CLASS_ATTRIBUTES = {
  Marauder: ['str'], Ranger: ['dex'], Witch: ['int'], Duelist: ['str', 'dex'], Templar: ['str', 'int'], Shadow: ['dex', 'int'], Scion: ['str', 'dex', 'int']
};
export const ASCENDANCY_CLASS = {
  Juggernaut: 'Marauder', Berserker: 'Marauder', Chieftain: 'Marauder',
  Raider: 'Ranger', Deadeye: 'Ranger', Pathfinder: 'Ranger',
  Occultist: 'Witch', Elementalist: 'Witch', Necromancer: 'Witch',
  Slayer: 'Duelist', Gladiator: 'Duelist', Champion: 'Duelist',
  Inquisitor: 'Templar', Hierophant: 'Templar', Guardian: 'Templar',
  Assassin: 'Shadow', Trickster: 'Shadow', Saboteur: 'Shadow',
  Ascendant: 'Scion', Reliquarian: 'Scion'
};
// Display names users write -> internal ids (Raider is the 3.30 Warden id; see AGENTS.md).
const ASCENDANCY_ALIASES = { Warden: 'Raider' };
const colourAttr = { r: 'str', g: 'dex', b: 'int' };

// Themes a request may ask for. A theme is met by the skill (types/tags/text) or by an ascendancy notable whose
// stat text matches `node`. Extend by adding rows; nothing below is specific to one build.
export const THEMES = {
  explosion: { words: /explo(?:de|sion|sive)/i, skill_text: /explo(?:de|des|sion|sive)/i, node: /explode/i },
  on_kill_explosion: { words: /on[- ]kill explo|explode on kill|kill.{0,20}explo|corpse explo/i, skill_text: /(?:kill|corpse).{0,60}explo|explo.{0,60}(?:kill|corpse)/i, node: /kill.{0,40}explode/i },
  minion: { words: /minion|summon|zombie|skeleton|spectre|golem|raging spirit/i, types: ['Minion', 'CreatesMinion'], node: /minion/i },
  totem: { words: /totem|ballista/i, types: ['SummonsTotem'], node: /totem/i },
  trap: { words: /\btraps?\b/i, types: ['Trapped'], node: /\btraps?\b/i },
  mine: { words: /\bmines?\b/i, types: ['RemoteMined'], node: /\bmines?\b/i },
  brand: { words: /\bbrands?\b/i, types: ['Brand'], node: /\bbrands?\b/i },
  damage_over_time: { words: /\bdot\b|damage over time|degen/i, types: ['DamageOverTime'], node: /damage over time/i },
  poison: { words: /poison/i, skill_text: /poison/i, node: /poison/i },
  bleed: { words: /bleed/i, skill_text: /bleed/i, node: /bleed/i },
  ignite: { words: /ignite|burning/i, skill_text: /ignite|burning/i, types: ['CausesBurning'], node: /ignite|burning/i },
  projectile: { words: /projectile|bow|arrow/i, types: ['Projectile'], node: /projectile/i },
  melee: { words: /melee|strike|slam/i, types: ['Melee'], node: /melee/i },
  spell: { words: /\bspells?\b|caster/i, types: ['Spell'], node: /spell/i },
  attack: { words: /\battacks?\b/i, types: ['Attack'], node: /attack/i },
  channelling: { words: /channel/i, types: ['Channel'], node: /channel/i },
  fire: { words: /\bfire\b/i, types: ['Fire'], node: /fire damage/i },
  cold: { words: /\bcold\b|frost|ice\b/i, types: ['Cold'], node: /cold damage/i },
  lightning: { words: /lightning|shock/i, types: ['Lightning'], node: /lightning damage/i },
  chaos: { words: /\bchaos\b/i, types: ['Chaos'], node: /chaos damage/i },
  physical: { words: /physical/i, types: ['Physical'], node: /physical damage/i }
};

// Conditions in passive stat text and how a prototype can meet them. `enabler` names a generator step; null = the
// skill itself must provide it (checked against skill themes), otherwise the node is penalised.
export const NODE_REQUIREMENTS = [
  { need: 'curse', text: /cursed enem/i, enabler: 'curse' },
  { need: 'bleed', text: /bleeding enem/i, enabler: null, theme: 'bleed' },
  { need: 'ignite', text: /ignited enem/i, enabler: null, theme: 'ignite' },
  { need: 'poison', text: /poisoned enem/i, enabler: null, theme: 'poison' },
  { need: 'totem', text: /\btotems? kill/i, enabler: null, theme: 'totem', optional: true },
  { need: 'minion', text: /\bminions? kill/i, enabler: null, theme: 'minion', optional: true }
];

// Offensive scaling axes from skill types (passive stat patterns). Weight = value of a matching notable.
export const AXIS_RULES = [
  { when: ['Spell'], axis: 'spell_damage', pattern: /spell damage|cast speed/i, weight: 1 },
  { when: ['Attack'], axis: 'attack_damage', pattern: /attack damage|attack speed/i, weight: 1 },
  { when: ['Melee'], axis: 'melee_damage', pattern: /melee (?:physical )?damage/i, weight: 0.8 },
  { when: ['Projectile'], axis: 'projectile_damage', pattern: /projectile damage/i, weight: 0.8 },
  { when: ['Area'], axis: 'area_damage', pattern: /area damage|area of effect/i, weight: 0.6 },
  { when: ['DamageOverTime'], axis: 'damage_over_time', pattern: /damage over time/i, weight: 1.2 },
  { when: ['Fire'], axis: 'fire_damage', pattern: /fire damage|elemental damage/i, weight: 1 },
  { when: ['Cold'], axis: 'cold_damage', pattern: /cold damage|elemental damage/i, weight: 1 },
  { when: ['Lightning'], axis: 'lightning_damage', pattern: /lightning damage|elemental damage/i, weight: 1 },
  { when: ['Chaos'], axis: 'chaos_damage', pattern: /chaos damage/i, weight: 1 },
  { when: ['Physical'], axis: 'physical_damage', pattern: /physical damage/i, weight: 1 },
  { when: ['Minion'], axis: 'minion_damage', pattern: /minions? (?:deal|have|gain).*(?:damage|attack|cast)/i, weight: 1.3 },
  { when: ['SummonsTotem'], axis: 'totem', pattern: /totem/i, weight: 1 },
  { when: ['Trapped'], axis: 'trap', pattern: /\btraps?\b/i, weight: 1 },
  { when: ['RemoteMined'], axis: 'mine', pattern: /\bmines?\b/i, weight: 1 },
  { when: ['Brand'], axis: 'brand', pattern: /\bbrands?\b/i, weight: 1 },
  { when: ['Bow'], axis: 'bow', pattern: /\bbows?\b/i, weight: 1 },
  { when: ['TwoHand'], axis: 'two_handed', pattern: /two handed/i, weight: 0.8 }
];
export const DEFENCE_AXES = [
  { axis: 'life', pattern: /maximum life/i, weight: 1.3 },
  { axis: 'resistances', pattern: /to all elemental resistances|elemental resistances/i, weight: 0.4 },
  { axis: 'minion_life', pattern: /minions have .*maximum life/i, weight: 0.3, when: ['Minion'] }
];

// Attribute axis for the second requirement repair (attributes still unmet after the kit repair).
const ATTR_NAMES = { str: 'Strength', dex: 'Dexterity', int: 'Intelligence' };
export const attributeAxis = a => ({ axis: `attribute_${a}`, pattern: new RegExp(`to ${ATTR_NAMES[a]}|to all attributes|to ${ATTR_NAMES[a]} and`, 'i'), weight: 1.2 });
export const RESOURCE_AXIS = { axis: 'mana_sustain', pattern: /mana regeneration|mana cost|cost of skills/i, weight: 0.9 };

// Skills excluded from "main skill" candidates (non-damaging utility); attacks without 'Damage' type stay in.
const UTILITY_TYPES = ['Aura', 'Herald', 'Banner', 'Mark', 'Link', 'Offering', 'Guard', 'Stance', 'Travel', 'Blink', 'Vaal', 'Hex', 'Warcry', 'Retaliation', 'Triggered', 'InbuiltTrigger', 'Pact'];

// Weapon families an item kit can provide, in preference order for attacks.
export const WEAPON_FAMILIES = ['Bow', 'Two Hand Mace', 'Staff', 'Two Hand Axe', 'Two Hand Sword', 'One Hand Sword', 'One Hand Axe', 'One Hand Mace', 'Claw', 'Dagger', 'Wand', 'Sceptre'];

// ---------- helpers ----------
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const strList = v => Array.isArray(v) ? v.filter(x => typeof x === 'string') : typeof v === 'string' ? [v] : [];
const round = (v, d = 0) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export function normalizeAscendancy(name) {
  if (typeof name !== 'string') return null;
  const n = ASCENDANCY_ALIASES[name] ?? name;
  return ASCENDANCY_CLASS[n] ? n : null;
}

// ---------- request ----------
// Profile (build.json) -> request. Free text is matched against the tables above; anything not stated stays null
// and every default is listed in `assumptions` (never invented preferences).
export function requestFromProfile(build, { level = null, mapTier = null } = {}) {
  const p = build?.profile ?? build ?? {};
  const texts = [...strList(p.preferred_skills), ...strList(p.preferred_content), ...strList(p.goals), ...strList(p.buttons), ...strList(p.disliked_mechanics)];
  const preferred = strList(p.preferred_skills).join(' \n ');
  const disliked = strList(p.disliked_mechanics).join(' \n ');
  const assumptions = [];
  const ascendancies = [];
  for (const word of preferred.split(/[^A-Za-z]+/)) { const a = normalizeAscendancy(word); if (a && !ascendancies.includes(a)) ascendancies.push(a); }
  const themes = Object.entries(THEMES).filter(([, t]) => t.words.test(preferred)).map(([k]) => k);
  const tierMatch = texts.join(' ').match(/\bT(1[0-7]|[1-9])\b/);
  const tier = mapTier ?? (tierMatch ? Number(tierMatch[1]) : null);
  if (mapTier == null && tier == null) assumptions.push('map tier not stated: encounters use T16');
  const buttonsText = [p.buttons, disliked].filter(Boolean).join(' ');
  let maxButtons = null;
  if (/\bfew\b|many buttons/i.test(buttonsText)) { maxButtons = 3; assumptions.push('"few buttons" read as at most 3 manually pressed skills (criterion is soft, value is an interpretation)'); }
  const lvl = level ?? 92;
  if (level == null) assumptions.push('character level not stated: prototypes use level 92');
  const req = {
    schema: REQUEST_SCHEMA,
    source: build?.id ? `build:${build.id}` : 'json',
    classes: ascendancies.map(a => ({ class: ASCENDANCY_CLASS[a], ascendancy: a })),
    themes, avoid_themes: Object.entries(THEMES).filter(([k, t]) => t.words.test(disliked) && !['spell', 'attack'].includes(k)).map(([k]) => k),
    level: lvl, map_tier: tier ?? 16,
    buttons: { max: maxButtons, text: p.buttons ?? null },
    constraints: {
      no_mana_flask: /flask/i.test(disliked) || null,
      exclude_delivery_supports: maxButtons != null && maxButtons <= 3 ? true : null,
      uniques: 'rares_only_prototype'
    },
    budget: isObj(p.budget) ? { amount: p.budget.amount ?? null, currency: p.budget.currency ?? null } : null,
    platform: p.platform ?? null,
    content: strList(p.preferred_content), goals: strList(p.goals),
    assumptions
  };
  if (!req.classes.length) assumptions.push('no ascendancy named: generator considers every ascendancy (slow); pass --ascendancy');
  if (req.budget && req.platform == null) assumptions.push('platform unknown: budget is not checked against prices (rare prices are not in local data anyway)');
  return validateRequest(req);
}

export function validateRequest(r) {
  if (!isObj(r)) throw new Error('request must be an object');
  if (r.schema !== REQUEST_SCHEMA) throw new Error(`request.schema must be ${REQUEST_SCHEMA}`);
  if (!Array.isArray(r.classes)) throw new Error('request.classes must be an array');
  r.classes.forEach((c, i) => {
    if (!isObj(c) || !normalizeAscendancy(c.ascendancy)) throw new Error(`request.classes[${i}].ascendancy must be a 3.30 ascendancy`);
    c.ascendancy = normalizeAscendancy(c.ascendancy);
    if (c.class != null && c.class !== ASCENDANCY_CLASS[c.ascendancy]) throw new Error(`request.classes[${i}]: ${c.ascendancy} belongs to ${ASCENDANCY_CLASS[c.ascendancy]}`);
    c.class = ASCENDANCY_CLASS[c.ascendancy];
  });
  for (const k of ['themes', 'avoid_themes']) {
    if (!Array.isArray(r[k] ?? [])) throw new Error(`request.${k} must be an array`);
    for (const t of r[k] ?? []) if (!THEMES[t]) throw new Error(`Unknown theme ${t}; known: ${Object.keys(THEMES).join(', ')}`);
  }
  if (!Number.isInteger(r.level) || r.level < 1 || r.level > 100) throw new Error('request.level must be 1-100');
  if (!Number.isInteger(r.map_tier) || r.map_tier < 1 || r.map_tier > 17) throw new Error('request.map_tier must be 1-17');
  if (r.buttons?.max != null && (!Number.isInteger(r.buttons.max) || r.buttons.max < 0)) throw new Error('request.buttons.max must be a non-negative integer or null');
  r.assumptions = strList(r.assumptions);
  r.themes = r.themes ?? []; r.avoid_themes = r.avoid_themes ?? []; r.constraints = r.constraints ?? {};
  return r;
}

// ---------- skill analysis ----------
// Gem record shape: { id, name, tags, types, minion_types, weapon_restrictions, colour, description, requirements }.
export function isMainSkillCandidate(g) {
  if (!g || g.is_support || !g.types?.length) return { ok: false, reason: 'not_active' };
  if (g.eligibility && g.eligibility !== 'released_in_client') return { ok: false, reason: `eligibility_${g.eligibility}` };
  if (/Royale$/.test(g.id) || g.tags?.includes('vaal')) return { ok: false, reason: 'vaal_or_royale' };
  const t = new Set(g.types);
  const damaging = t.has('Damage') || t.has('Attack') || t.has('DamageOverTime') || t.has('CreatesMinion') || t.has('Minion');
  if (!damaging) return { ok: false, reason: 'non_damaging' };
  const util = UTILITY_TYPES.find(x => t.has(x));
  if (util && !(t.has('Damage') && ['Hex', 'Warcry', 'Retaliation', 'Aura'].includes(util))) return { ok: false, reason: `utility_${util}` };
  if (t.has('Minion') && !(g.minion_types?.length) && !t.has('CreatesMinion')) return { ok: false, reason: 'minion_without_damage_types' };
  return { ok: true, reason: null };
}

export function weaponFamilyFor(g) {
  const t = new Set(g.types ?? []);
  if (t.has('Minion') || t.has('CreatesMinion')) return 'minion';
  if (!t.has('Attack')) return 'caster';
  const r = g.weapon_restrictions ?? [];
  if (!r.length) return 'Two Hand Mace';
  return WEAPON_FAMILIES.find(f => r.includes(f)) ?? null;
}

export function damageTypesOf(g) {
  const t = new Set([...(g.types ?? []), ...(g.minion_types ?? [])]);
  const out = ['Fire', 'Cold', 'Lightning', 'Chaos', 'Physical'].filter(x => t.has(x));
  if (!out.length && t.has('Attack')) out.push('Physical');
  return out;
}

export function damageFormOf(g) {
  const t = new Set(g.types ?? []);
  if (t.has('Minion') || t.has('CreatesMinion')) return 'minion';
  if (t.has('DamageOverTime') && !t.has('Attack')) return 'damage_over_time';
  if (t.has('SummonsTotem')) return 'totem';
  if (t.has('Trapped') || t.has('RemoteMined')) return 'trap_mine';
  if (t.has('Brand')) return 'brand';
  return t.has('Attack') ? 'attack_hit' : 'spell_hit';
}

export function skillThemes(g) {
  const t = new Set([...(g.types ?? []), ...(g.minion_types ?? [])]);
  const text = `${g.name ?? ''}\n${g.description ?? ''}`;
  return Object.entries(THEMES).filter(([, th]) => (th.types ?? []).some(x => t.has(x)) || (th.skill_text && th.skill_text.test(text))).map(([k]) => k);
}

// Requirements of a passive node read from its stat text.
export function nodeRequirements(stats) {
  const text = strList(stats).join('\n');
  return NODE_REQUIREMENTS.filter(r => r.text.test(text)).map(r => ({ need: r.need, enabler: r.enabler, theme: r.theme ?? null, optional: !!r.optional }));
}
// Can this skill (with generator enablers) satisfy the node's requirements?
export function requirementsMet(reqs, themesOfSkill) {
  const unmet = reqs.filter(r => !r.optional && !r.enabler && !themesOfSkill.includes(r.theme));
  return { ok: unmet.length === 0, unmet: unmet.map(r => r.need), enablers: [...new Set(reqs.filter(r => r.enabler).map(r => r.enabler))] };
}

// Axis patterns for the tree from the skill's types (plus weapon family pseudo-types).
export function axesFor(g) {
  const t = new Set([...(g.types ?? []), ...(g.minion_types ?? [])]);
  const fam = weaponFamilyFor(g);
  if (fam === 'Bow') t.add('Bow');
  if (/^(Two Hand|Staff)/.test(fam ?? '')) t.add('TwoHand');
  const minion = t.has('Minion') || t.has('CreatesMinion');
  // A minion skill's own types (Spell, Fire...) describe the summon cast, not the damage the player scales.
  const offence = AXIS_RULES.filter(r => r.when.some(x => t.has(x)) && !(minion && !['Minion', 'SummonsTotem'].includes(r.when[0])));
  const defence = DEFENCE_AXES.filter(d => !d.when || d.when.some(x => t.has(x)));
  return [...offence, ...defence].map(r => ({ axis: r.axis, pattern: r.pattern, weight: r.weight }));
}
// Per line: a line about minions only counts for minion axes; a line limited to a weapon class ("while wielding a
// Staff", "with Bows") only counts when the prototype's weapon family is that class (unknown family: counted).
const WEAPON_WORDS = { staff: /staff|staves/i, bow: /\bbows?\b/i, wand: /\bwands?\b/i, sceptre: /sceptres?/i, sword: /swords?/i, axe: /\baxes?\b/i, mace: /\bmaces?\b/i, dagger: /daggers?/i, claw: /claws?/i, shield: /shields?/i };
const weaponLimited = line => /\b(while wielding|with|using)\b/i.test(line) ? Object.keys(WEAPON_WORDS).filter(k => WEAPON_WORDS[k].test(line)) : [];
export function nodeValue(stats, axes, { family = null } = {}) {
  const lines = strList(stats).flatMap(s => String(s).split('\n'));
  const fam = family ? String(family).toLowerCase() : null;
  let v = 0; const hit = [];
  for (const a of axes) {
    const minionAxis = /^minion/.test(a.axis);
    const ok = lines.some(l => {
      if (!minionAxis && /\bminions?\b/i.test(l)) return false;
      const limited = weaponLimited(l);
      if (fam && limited.length && !limited.some(k => fam.includes(k))) return false;
      return a.pattern.test(l);
    });
    if (ok) { v += a.weight; hit.push(a.axis); }
  }
  return { value: v, axes: hit };
}

// Pre-engine score of a (skill, ascendancy) pair. ascNodes: [{name, stats}] notables of the ascendancy.
export function scoreCandidate(g, cls, ascNodes, request) {
  const themes = skillThemes(g);
  const axes = axesFor(g);
  const attrs = CLASS_ATTRIBUTES[cls.class] ?? [];
  const reasons = [];
  let score = 0;
  if (attrs.includes(colourAttr[g.colour])) { score += 1; reasons.push(`gem colour matches ${cls.class}`); }
  const asc = ascNodes.map(n => ({ ...n, ...nodeValue(n.stats, axes), reqs: nodeRequirements(n.stats) }));
  const synergy = asc.filter(n => n.value > 0 && requirementsMet(n.reqs, themes).ok).reduce((s, n) => s + n.value, 0);
  score += Math.min(4, synergy) * 0.5;
  if (synergy) reasons.push(`ascendancy synergy ${round(synergy, 1)}`);
  const met = [], missing = [];
  for (const th of request.themes ?? []) {
    if (themes.includes(th)) { met.push({ theme: th, by: 'skill' }); score += 3; continue; }
    const node = asc.find(n => THEMES[th].node.test(strList(n.stats).join('\n')) && requirementsMet(n.reqs, themes).ok);
    if (node) { met.push({ theme: th, by: `ascendancy:${node.name}`, enablers: requirementsMet(node.reqs, themes).enablers }); score += 2; }
    else missing.push(th);
  }
  const avoided = (request.avoid_themes ?? []).filter(th => themes.includes(th));
  score -= 2 * avoided.length;
  return { score: round(score, 2), themes, themes_met: met, themes_missing: missing, avoided, reasons };
}

// Keep the best candidate per diversity key first, then fill by score.
export function diversify(rows, n, keyOf) {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const seen = new Set(), first = [], rest = [];
  for (const r of sorted) { const k = keyOf(r); if (seen.has(k)) rest.push(r); else { seen.add(k); first.push(r); } }
  return [...first, ...rest].slice(0, n);
}

// ---------- buttons ----------
// Manually pressed skills: enabled groups with an active gem that is not an aura/herald/blessing/curse aura and not
// triggered; recast-on-duration skills are reported separately. groups: [{label, gems:[{name, types}]}].
export function countButtons(groups) {
  const pressed = [], recast = [];
  for (const g of groups) {
    const actives = g.gems.filter(x => x.types?.length);
    if (!actives.length || g.enabled === false) continue;
    const linked = new Set(g.gems.flatMap(x => x.support_types ?? []));
    for (const a of actives) {
      const t = new Set(a.types);
      if (t.has('Aura') || t.has('Herald') || t.has('HasReservation') || t.has('Triggered') || t.has('InbuiltTrigger') || linked.has('trigger')) continue;
      if (a.role === 'enabler_auto') continue;
      pressed.push(a.name);
      if (t.has('Duration') && !t.has('Channel')) recast.push(a.name);
    }
  }
  return { pressed: pressed.length, skills: pressed, recast_on_duration: recast };
}

// ---------- hard filters ----------
// metrics: output of design-generate summarise(). Returns failures [{code, detail}] (empty = passes).
export function hardFilters(m, request) {
  const fail = [];
  if (!(m.dps > 0)) fail.push({ code: 'no_damage', detail: 'PoB reports no damage for the main skill (missing config, weapon, corpses or unsupported skill)' });
  if (m.unmet_requirements?.length) fail.push({ code: 'requirements_unmet', detail: m.unmet_requirements.join('; ') });
  if (m.skill_disabled) fail.push({ code: 'skill_disabled', detail: m.skill_disabled });
  if (m.mana_unreserved != null && m.mana_cost != null && m.mana_unreserved < m.mana_cost) fail.push({ code: 'cannot_pay_cost', detail: `unreserved mana ${m.mana_unreserved} < cost ${m.mana_cost}` });
  if (request.constraints?.no_mana_flask && m.mana_sustain != null && m.mana_sustain < 0 && !m.minion) fail.push({ code: 'mana_not_sustained', detail: `mana per second ${m.mana_sustain} without flasks (profile dislikes flask pressing)` });
  if (m.life_unreserved != null && m.life_unreserved <= 0) fail.push({ code: 'life_reserved_out', detail: 'no unreserved life' });
  if (m.unparsed_item_mods > 0) fail.push({ code: 'unparsed_item_mods', detail: `${m.unparsed_item_mods} kit modifiers not parsed by PoB` });
  return fail;
}

// ---------- Pareto front ----------
// objectives: [{key, dir:'max'|'min'}]; rows with null in an objective are dominated on it.
export function dominates(a, b, objectives) {
  let better = false;
  for (const { key, dir } of objectives) {
    const x = a[key], y = b[key];
    const xv = x == null ? -Infinity : dir === 'min' ? -x : x, yv = y == null ? -Infinity : dir === 'min' ? -y : y;
    if (xv < yv) return false;
    if (xv > yv) better = true;
  }
  return better;
}
export function paretoFront(rows, objectives) {
  const front = [], dominated = [];
  for (const r of rows) {
    const by = rows.filter(o => o !== r && dominates(o, r, objectives)).map(o => o.id);
    (by.length ? dominated : front).push(by.length ? { id: r.id, dominated_by: by } : r);
  }
  return { front, dominated };
}
export const DEFAULT_OBJECTIVES = [
  { key: 'boss_dps', dir: 'max' }, { key: 'weakest_max_hit', dir: 'max' }, { key: 'ehp', dir: 'max' },
  { key: 'buttons', dir: 'min' }, { key: 'clear_score', dir: 'max' }
];

// ---------- Blueprint ----------
const FORMS = ['spell_hit', 'attack_hit', 'damage_over_time', 'minion', 'totem', 'trap_mine', 'brand'];
export function validateBlueprint(b) {
  const err = m => { throw new Error(`blueprint: ${m}`); };
  if (!isObj(b)) err('must be an object');
  if (b.schema !== BLUEPRINT_SCHEMA) err(`schema must be ${BLUEPRINT_SCHEMA}`);
  if (typeof b.id !== 'string' || !/^[a-z0-9-]{3,80}$/.test(b.id)) err('id must be a slug');
  if (!normalizeAscendancy(b.ascendancy) || ASCENDANCY_CLASS[b.ascendancy] !== b.class) err('class/ascendancy mismatch');
  const d = b.damage_chain;
  if (!isObj(d) || !isObj(d.source) || typeof d.source.skill !== 'string') err('damage_chain.source.skill required');
  if (!FORMS.includes(d.form)) err(`damage_chain.form must be one of ${FORMS.join('|')}`);
  if (!Array.isArray(d.damage_types) || !d.damage_types.length) err('damage_chain.damage_types required');
  if (!Array.isArray(d.delivery_supports)) err('damage_chain.delivery_supports must be an array');
  if (!Array.isArray(b.scaling_axes) || !b.scaling_axes.length || b.scaling_axes.some(a => typeof a.axis !== 'string')) err('scaling_axes required');
  if (!Array.isArray(b.clear_mechanism)) err('clear_mechanism must be an array');
  for (const c of b.clear_mechanism) if (!['skill_area', 'projectiles', 'minions', 'on_kill_explosion', 'single_target'].includes(c.kind)) err(`clear_mechanism kind ${c.kind}`);
  if (!Array.isArray(b.defence_layers) || !b.defence_layers.length) err('defence_layers required');
  for (const l of b.defence_layers) if (!['pool', 'mitigation', 'avoidance', 'recovery', 'resistances'].includes(l.layer)) err(`defence layer ${l.layer}`);
  if (!isObj(b.resources) || !Array.isArray(b.resources.reservation)) err('resources.reservation required');
  if (!isObj(b.uptime) || !Number.isInteger(b.uptime.buttons_planned)) err('uptime.buttons_planned required');
  if (!isObj(b.components) || !['core', 'implementation', 'replaceable'].every(k => Array.isArray(b.components[k]))) err('components core/implementation/replaceable required');
  if (!Array.isArray(b.success_criteria)) err('success_criteria must be an array');
  for (const c of b.success_criteria) {
    if (typeof c.metric !== 'string' || !['>=', '<=', 'rank'].includes(c.op)) err('success criterion needs metric and op >=|<=|rank');
    if (!['profile', 'default', 'interpretation'].includes(c.source)) err('success criterion source must be profile|default|interpretation');
  }
  if (!Array.isArray(b.assumptions) || !Array.isArray(b.not_modelled)) err('assumptions and not_modelled must be arrays');
  return b;
}

export function successCriteria(request) {
  const out = [
    { metric: 'resists_capped', op: '>=', value: 75, source: 'default', note: 'elemental resistances at the 75% cap' },
    { metric: 'boss_dps', op: 'rank', value: null, source: 'profile', note: `kill T${request.map_tier} map bosses; boss life per boss is not in local data, so DPS is ranked, not thresholded` },
    { metric: 'weakest_max_hit', op: 'rank', value: null, source: 'profile', note: `survive T${request.map_tier} content; ranked across prototypes` },
    { metric: 'clear_score', op: 'rank', value: null, source: 'interpretation', note: 'fast clear: area/projectile/minion coverage plus on-kill explosions (PoB does not model clear speed)' }
  ];
  if (request.buttons?.max != null) out.push({ metric: 'buttons', op: '<=', value: request.buttons.max, source: 'interpretation', note: request.buttons.text ?? 'buttons' });
  if (request.constraints?.no_mana_flask) out.push({ metric: 'mana_sustain', op: '>=', value: 0, source: 'profile', note: 'no constant flask pressing' });
  return out;
}

// Clear proxy (documented heuristic, not a PoB number): area/projectile/minions +1 each, chains/nova/rain +0.5,
// an engine-reported on-kill explosion +1.5.
export function clearScore(types, explosions) {
  const t = new Set(types ?? []);
  let s = 0;
  if (t.has('Area')) s += 1;
  if (t.has('Projectile')) s += 1;
  if (t.has('Minion') || t.has('CreatesMinion')) s += 1;
  if (['Chains', 'Nova', 'Rain', 'Cascadable', 'ProjectileNumber'].some(x => t.has(x))) s += 0.5;
  if (explosions > 0) s += 1.5;
  return s;
}
