import { baseOf, influenceTag, influenceSuffix, armourClasses } from './catalog.mjs';
import { keys, integer, firstWeight } from '../engine.mjs';

export const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
export const isAffix = mod => mod && ['prefix', 'suffix'].includes(mod.generation_type);
export const definition = (catalog, roll) => catalog.mods.get(roll.id);
export const sideOf = (catalog, roll) => definition(catalog, roll).generation_type;
export const ROLL_KINDS = ['natural', 'crafted', 'essence', 'fossil', 'veiled', 'unveiled', 'implicit', 'corrupted', 'eldritch', 'enchantment', 'elevated', 'beast', 'sell'];
export const QUALITY_TYPES = ['normal', 'abrasive', 'accelerating', 'fertile', 'imbued', 'intrinsic', 'noxious', 'prismatic', 'tempering', 'turbulent', 'unstable', 'sinistral', 'dextral'];
export const JEWEL_DOMAINS = ['jewel', 'abyss_jewel', 'affliction_jewel', 'heist_trinket'];

export const valuesOf = (catalog, rolls) => {
  const result = new Map();
  for (const roll of rolls) definition(catalog, roll).stats.forEach((stat, i) => result.set(stat.id, (result.get(stat.id) ?? 0) + roll.values[i]));
  return result;
};
export function count(catalog, item) {
  return { prefix: item.mods.filter(roll => sideOf(catalog, roll) === 'prefix').length, suffix: item.mods.filter(roll => sideOf(catalog, roll) === 'suffix').length };
}
export function capacity(catalog, item, rarity = item.rarity) {
  if (rarity === 'normal') return { prefix: 0, suffix: 0, total: 0 };
  const base = baseOf(catalog, item.base_id), jewel = JEWEL_DOMAINS.includes(base.domain);
  requireThat(rarity !== 'rare' || !['flask', 'tincture'].includes(base.domain), 'This item type cannot be rare');
  const natural = jewel ? 2 : 3, stats = valuesOf(catalog, item.implicits);
  const p = Math.max(0, natural + (stats.get('local_maximum_prefixes_allowed_+') ?? 0));
  const s = Math.max(0, natural + (stats.get('local_maximum_suffixes_allowed_+') ?? 0));
  return { prefix: rarity === 'magic' ? Math.min(1, p) : p, suffix: rarity === 'magic' ? Math.min(1, s) : s,
    total: rarity === 'magic' ? Math.min(1, p) + Math.min(1, s) : Math.min(jewel ? 4 : 6, p + s) };
}
export const isJewel = (catalog, item) => JEWEL_DOMAINS.includes(baseOf(catalog, item.base_id).domain);
export function itemTags(catalog, item) {
  const base = baseOf(catalog, item.base_id);
  const tags = new Set([...base.tags, item.rarity]);
  for (const roll of [...item.implicits, ...item.mods]) for (const tag of definition(catalog, roll).adds_tags) tags.add(tag);
  for (const influence of influencesOf(catalog, item)) tags.add(influenceTag(catalog, base, influence));
  if (item.cluster) tags.add(catalog.clusters[base.id].passive_skills.find(skill => skill.id === item.cluster.skill).tag);
  return tags;
}
export function influencesOf(catalog, item) {
  return valuesOf(catalog, item.implicits).get('local_item_can_roll_all_influences') ? Object.keys(influenceSuffix) : item.influences;
}
export function meta(catalog, item) {
  const stats = valuesOf(catalog, [...item.mods, ...item.implicits]);
  return {
    prefix: stats.get('item_generation_cannot_change_prefixes') ? Infinity : (stats.get('item_generation_cannot_change_x_prefixes') ?? 0),
    suffix: stats.get('item_generation_cannot_change_suffixes') ? Infinity : (stats.get('item_generation_cannot_change_x_suffixes') ?? 0),
    attack: !!stats.get('item_generation_cannot_roll_attack_affixes'), caster: !!stats.get('item_generation_cannot_roll_caster_affixes'),
    crafted_limit: stats.get('item_generation_can_have_multiple_crafted_mods') ? 3 : 1,
    immutable_implicits: !!stats.get('local_implicit_mod_cannot_be_changed'),
    modifiable_corrupted: !!stats.get('local_can_be_modified_while_corrupted') || !!stats.get('item_can_be_modified_while_corrupted'),
  };
}
export const hasBlockingMeta = (catalog, item) => { const m = meta(catalog, item); return !!(m.prefix || m.suffix || m.attack || m.caster); };
export function makeRoll(mod, rng, { kind = 'natural', fractured = false, lucky = false } = {}) {
  requireThat(mod, 'Unknown modifier definition');
  return { id: mod.id, kind, fractured, values: mod.stats.map(stat => {
    const low = Math.min(stat.min, stat.max), high = Math.max(stat.min, stat.max);
    const draw = () => low + rng.int(high - low + 1);
    return lucky ? Math.max(draw(), draw()) : draw();
  }) };
}
function validateRoll(catalog, roll) {
  keys(roll, ['id', 'kind', 'fractured', 'values'], 'roll');
  const mod = definition(catalog, roll);
  requireThat(mod, `Unknown modifier: ${roll.id}`);
  requireThat(ROLL_KINDS.includes(roll.kind), 'Unknown roll kind');
  requireThat(typeof roll.fractured === 'boolean', 'fractured must be boolean');
  requireThat(Array.isArray(roll.values) && roll.values.length === mod.stats.length, `Wrong stat count for ${roll.id}`);
  mod.stats.forEach((stat, index) => integer(roll.values[index], Math.min(stat.min, stat.max), Math.max(stat.min, stat.max), `roll ${roll.id}`));
  return mod;
}
export const ITEM_FIELDS = ['base_id', 'item_level', 'rarity', 'mods', 'implicits', 'enchantments', 'influences', 'corrupted', 'twice_corrupted', 'mirrored', 'split',
  'synthesised', 'quality', 'quality_type', 'sockets', 'cluster', 'eldritch', 'memory_strands', 'foreseeing'];
export function validateItem(catalog, item) {
  keys(item, ITEM_FIELDS, 'item');
  const base = baseOf(catalog, item.base_id);
  integer(item.item_level, 1, 100, 'item level');
  requireThat(['normal', 'magic', 'rare'].includes(item.rarity), 'Rarity must be normal/magic/rare');
  for (const field of ['corrupted', 'twice_corrupted', 'mirrored', 'split', 'synthesised']) requireThat(typeof item[field] === 'boolean', `${field} must be boolean`);
  requireThat(!item.twice_corrupted || item.corrupted, 'Twice corrupted implies corrupted');
  integer(item.quality, 0, 30, 'quality');
  requireThat(QUALITY_TYPES.includes(item.quality_type), 'Unknown quality type');
  integer(item.memory_strands, 0, 100, 'memory strands');
  requireThat(item.foreseeing === null || (item.foreseeing && Number.isSafeInteger(item.foreseeing.seed) && Object.keys(item.foreseeing).length === 1), 'Invalid foreseeing state');
  requireThat(Array.isArray(item.influences) && item.influences.length <= 2 && new Set(item.influences).size === item.influences.length, 'At most two distinct influences allowed');
  for (const influence of item.influences) influenceTag(catalog, base, influence);
  requireThat(!(item.influences.length && item.mods.some(roll => roll.fractured)), 'Influenced and fractured states cannot coexist');
  requireThat(!(item.synthesised && item.influences.length), 'Synthesised and influenced states cannot coexist');
  requireThat(Array.isArray(item.mods) && item.mods.length <= 8, 'Invalid explicit modifiers');
  const groups = new Set(), ids = new Set();
  for (const roll of item.mods) {
    const mod = validateRoll(catalog, roll);
    requireThat(isAffix(mod), `Not an explicit affix: ${mod.id}`);
    requireThat([base.domain, 'crafted', 'veiled', 'unveiled', 'delve'].includes(mod.domain), `Wrong modifier domain: ${mod.id}`);
    requireThat(!ids.has(mod.id) && !mod.groups.some(group => groups.has(group)), `Conflicting modifier groups: ${mod.id}`);
    mod.groups.forEach(group => groups.add(group)); ids.add(mod.id);
    requireThat(roll.kind === 'crafted' ? mod.domain === 'crafted' : roll.kind === 'veiled' ? mod.domain === 'veiled' : true, 'Roll kind/domain mismatch');
  }
  for (const field of ['implicits', 'enchantments']) {
    requireThat(Array.isArray(item[field]) && item[field].length <= 8, `Invalid ${field}`);
    for (const roll of item[field]) validateRoll(catalog, roll);
  }
  requireThat(item.implicits.filter(roll => roll.kind === 'corrupted').length <= 2, 'At most two corrupted implicits');
  const max = capacity(catalog, item), n = count(catalog, item);
  requireThat(n.prefix <= max.prefix && n.suffix <= max.suffix && item.mods.length <= max.total, 'Affix capacity exceeded');
  requireThat(item.mods.filter(roll => roll.kind === 'crafted').length <= meta(catalog, item).crafted_limit, 'Crafted modifier limit exceeded');
  keys(item.sockets, ['colours', 'links'], 'sockets');
  requireThat(Array.isArray(item.sockets.colours) && item.sockets.colours.length <= 6 && item.sockets.colours.every(colour => ['R', 'G', 'B', 'W', 'A', 'D'].includes(colour)), 'Invalid socket colours');
  requireThat(Array.isArray(item.sockets.links) && item.sockets.links.every(n => Number.isInteger(n) && n >= 1 && n <= 6) && item.sockets.links.reduce((a, b) => a + b, 0) === item.sockets.colours.length, 'Socket links must partition the sockets');
  keys(item.eldritch, ['exarch', 'eater'], 'eldritch');
  for (const side of ['exarch', 'eater']) if (item.eldritch[side] !== null) {
    const entry = item.eldritch[side]; keys(entry, ['id', 'tier'], 'eldritch implicit'); integer(entry.tier, 1, 6, 'eldritch tier');
    requireThat(item.implicits.some(roll => roll.id === entry.id && roll.kind === 'eldritch'), 'Missing eldritch roll');
  }
  if (item.eldritch.exarch || item.eldritch.eater) {
    requireThat(armourClasses.includes(base.item_class), 'Invalid eldritch item class');
    requireThat(!item.influences.length && !item.synthesised, 'Eldritch cannot coexist with influence/synthesis');
  }
  if (item.cluster !== null) {
    keys(item.cluster, ['skill', 'passives'], 'cluster');
    const cluster = catalog.clusters[base.id];
    requireThat(cluster && cluster.passive_skills.some(skill => skill.id === item.cluster.skill), 'Invalid cluster skill');
    integer(item.cluster.passives, cluster.min_skills, cluster.max_skills, 'cluster passive count');
  } else requireThat(base.domain !== 'affliction_jewel', 'Cluster Jewel needs explicit skill and passive count');
  return item;
}
export function emptyItem(base, itemLevel) {
  return { base_id: base.id, item_level: itemLevel, rarity: 'normal', mods: [], implicits: [], enchantments: [], influences: [], corrupted: false, twice_corrupted: false,
    mirrored: false, split: false, synthesised: false, quality: 0, quality_type: 'normal', sockets: { colours: [], links: [] }, cluster: null,
    eldritch: { exarch: null, eater: null }, memory_strands: 0, foreseeing: null };
}
export const INPUT_FIELDS = ['base', 'item_level', 'rarity', 'mods', 'implicits', 'influences', 'corrupted', 'twice_corrupted', 'mirrored', 'split', 'quality', 'quality_type', 'sockets', 'cluster', 'memory_strands'];
export function createItem(catalog, input, rng) {
  keys(input, INPUT_FIELDS, 'initial item');
  const base = baseOf(catalog, input.base);
  const item = emptyItem(base, input.item_level);
  Object.assign(item, { rarity: input.rarity ?? 'normal', influences: [...(input.influences ?? [])], corrupted: input.corrupted ?? false,
    twice_corrupted: input.twice_corrupted ?? false, mirrored: input.mirrored ?? false, split: input.split ?? false, quality: input.quality ?? 0,
    quality_type: input.quality_type ?? 'normal', sockets: structuredClone(input.sockets ?? { colours: [], links: [] }), cluster: structuredClone(input.cluster ?? null),
    memory_strands: input.memory_strands ?? 0 });
  if (input.implicits === undefined) item.implicits = base.implicits.map(id => makeRoll(catalog.mods.get(id), rng, { kind: 'implicit' }));
  else for (const entry of input.implicits) item.implicits.push(specRoll(catalog, entry, rng, 'implicit', mod => !isAffix(mod)));
  requireThat(Array.isArray(input.mods ?? []) && (input.mods ?? []).length <= 6, 'Initial mods must be an array');
  for (const entry of input.mods ?? []) item.mods.push(specRoll(catalog, entry, rng, null, isAffix));
  validateItem(catalog, item);
  // Ownership of the start item is assumed; natural affixes must still be eligible on this base/influence/level.
  const tags = itemTags(catalog, item);
  for (const roll of item.mods.filter(roll => roll.kind === 'natural')) {
    const mod = definition(catalog, roll);
    requireThat(!mod.is_essence_only && mod.required_level <= item.item_level && firstWeight(mod.spawn_weights, tags, 0) > 0, `Initial modifier not naturally eligible: ${mod.id}`);
  }
  return item;
}
function specRoll(catalog, entry, rng, defaultKind, accept) {
  const spec = typeof entry === 'string' ? { id: entry } : entry;
  keys(spec, ['id', 'kind', 'fractured', 'values'], 'initial modifier');
  const mod = catalog.mods.get(spec.id);
  requireThat(mod && accept(mod), `Unknown or misplaced modifier: ${spec.id}`);
  const kind = spec.kind ?? defaultKind ?? (mod.domain === 'crafted' ? 'crafted' : mod.domain === 'veiled' ? 'veiled' : mod.domain === 'unveiled' ? 'unveiled' : mod.is_essence_only ? 'essence' : 'natural');
  const roll = makeRoll(mod, rng, { kind, fractured: spec.fractured ?? false });
  if (spec.values !== undefined) roll.values = structuredClone(spec.values);
  return roll;
}
export function lowestRarity(catalog, item) {
  item.rarity = item.mods.length >= 2 ? 'rare' : item.mods.length === 1 ? 'magic' : 'normal';
}
export function mutable(catalog, item) {
  requireThat(!item.mirrored, 'Mirrored items cannot be modified');
  requireThat(!item.corrupted || meta(catalog, item).modifiable_corrupted, 'This action requires an uncorrupted item');
}
export function equipment(catalog, item) { requireThat(baseOf(catalog, item.base_id).domain === 'item', 'Requires an equipment base'); }
export function rare(item) { requireThat(item.rarity === 'rare', 'Requires rare rarity'); }
export const fracturedCount = item => item.mods.filter(roll => roll.fractured).length;
