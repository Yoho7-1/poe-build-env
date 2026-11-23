import { baseOf, influenceTag, influenceSuffix } from './catalog.mjs';
import { keys, integer, firstWeight } from '../engine.mjs';

export const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
export const isAffix = mod => mod && ['prefix', 'suffix'].includes(mod.generation_type);
export const definition = (catalog, roll) => catalog.mods.get(roll.id);
export const valuesOf = (catalog, rolls) => {
  const result = new Map();
  for (const roll of rolls) definition(catalog, roll).stats.forEach((stat, i) => result.set(stat.id, (result.get(stat.id) ?? 0) + roll.values[i]));
  return result;
};
export function count(catalog, item) {
  return { prefix: item.mods.filter(roll => definition(catalog, roll).generation_type === 'prefix').length,
    suffix: item.mods.filter(roll => definition(catalog, roll).generation_type === 'suffix').length };
}
export function capacity(catalog, item, rarity = item.rarity) {
  if (rarity === 'normal') return { prefix: 0, suffix: 0, total: 0 };
  const base = baseOf(catalog, item.base_id), jewel = ['jewel', 'abyss_jewel', 'affliction_jewel', 'heist_trinket'].includes(base.domain);
  requireThat(rarity !== 'rare' || !['flask', 'tincture'].includes(base.domain), 'This item type cannot be rare');
  const natural = jewel ? 2 : 3, stats = valuesOf(catalog, item.implicits);
  const p = Math.max(0, natural + (stats.get('local_maximum_prefixes_allowed_+') ?? 0));
  const s = Math.max(0, natural + (stats.get('local_maximum_suffixes_allowed_+') ?? 0));
  return { prefix: rarity === 'magic' ? Math.min(1, p) : p, suffix: rarity === 'magic' ? Math.min(1, s) : s,
    total: rarity === 'magic' ? Math.min(1, p) + Math.min(1, s) : Math.min(jewel ? 4 : 6, p + s) };
}
export function itemTags(catalog, item) {
  const base = baseOf(catalog, item.base_id);
  const tags = new Set([...base.tags, item.rarity]);
  for (const roll of [...item.implicits, ...item.mods]) for (const tag of definition(catalog, roll).adds_tags) tags.add(tag);
  const implicitStats = valuesOf(catalog, item.implicits);
  const influences = implicitStats.get('local_item_can_roll_all_influences') ? Object.keys(influenceSuffix) : item.influences;
  for (const influence of influences) tags.add(influenceTag(catalog, base, influence));
  if (item.cluster) tags.add(catalog.clusters[base.id].passive_skills.find(skill => skill.id === item.cluster.skill).tag);
  return tags;
}
export function meta(catalog, item) {
  const stats = valuesOf(catalog, [...item.mods, ...item.implicits]);
  return {
    prefix: stats.get('item_generation_cannot_change_prefixes') ? Infinity : (stats.get('item_generation_cannot_change_x_prefixes') ?? 0),
    suffix: stats.get('item_generation_cannot_change_suffixes') ? Infinity : (stats.get('item_generation_cannot_change_x_suffixes') ?? 0),
    attack: !!stats.get('item_generation_cannot_roll_attack_affixes'), caster: !!stats.get('item_generation_cannot_roll_caster_affixes'),
    crafted_limit: stats.get('item_generation_can_have_multiple_crafted_mods') ? 3 : 1,
    immutable_implicits: !!stats.get('local_implicit_mod_cannot_be_changed'),
  };
}
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
  requireThat(['natural', 'crafted', 'essence', 'fossil', 'veiled', 'unveiled', 'implicit', 'corrupted', 'eldritch', 'enchantment', 'elevated'].includes(roll.kind), 'Unknown roll kind');
  requireThat(typeof roll.fractured === 'boolean', 'fractured must be boolean');
  requireThat(Array.isArray(roll.values) && roll.values.length === mod.stats.length, `Wrong stat count for ${roll.id}`);
  mod.stats.forEach((stat, index) => integer(roll.values[index], Math.min(stat.min, stat.max), Math.max(stat.min, stat.max), `roll ${roll.id}`));
  return mod;
}
export function validateItem(catalog, item) {
  keys(item, ['base_id', 'item_level', 'rarity', 'mods', 'implicits', 'enchantments', 'influences', 'corrupted', 'mirrored', 'split', 'synthesised', 'quality', 'sockets', 'cluster', 'eldritch'], 'item');
  const base = baseOf(catalog, item.base_id);
  integer(item.item_level, 1, 100, 'item level');
  requireThat(['normal', 'magic', 'rare'].includes(item.rarity), 'Rarity must be normal/magic/rare');
  for (const field of ['corrupted', 'mirrored', 'split', 'synthesised']) requireThat(typeof item[field] === 'boolean', `${field} must be boolean`);
  integer(item.quality, 0, 30, 'quality');
  requireThat(Array.isArray(item.influences) && item.influences.length <= 2 && new Set(item.influences).size === item.influences.length, 'At most two distinct influences allowed');
  for (const influence of item.influences) influenceTag(catalog, base, influence);
  requireThat(!(item.influences.length && item.mods.some(roll => roll.fractured)), 'Influenced and fractured states cannot coexist');
  requireThat(!(item.synthesised && item.influences.length), 'Synthesised and influenced states cannot coexist');
  requireThat(Array.isArray(item.mods) && item.mods.length <= 8, 'Invalid explicit modifiers');
  const groups = new Set(), ids = new Set();
  const domain = base.domain;
  for (const roll of item.mods) {
    const mod = validateRoll(catalog, roll);
    requireThat(isAffix(mod), `Not an explicit affix: ${mod.id}`);
    requireThat([domain, 'crafted', 'veiled', 'unveiled'].includes(mod.domain), `Wrong modifier domain: ${mod.id}`);
    requireThat(!ids.has(mod.id) && !mod.groups.some(group => groups.has(group)), `Conflicting modifier groups: ${mod.id}`);
    mod.groups.forEach(group => groups.add(group)); ids.add(mod.id);
    requireThat(roll.kind === 'crafted' ? mod.domain === 'crafted' : roll.kind === 'veiled' ? mod.domain === 'veiled' : true, 'Roll kind/domain mismatch');
  }
  for (const field of ['implicits', 'enchantments']) {
    requireThat(Array.isArray(item[field]) && item[field].length <= 8, `Invalid ${field}`);
    for (const roll of item[field]) validateRoll(catalog, roll);
  }
  const max = capacity(catalog, item), n = count(catalog, item);
  requireThat(n.prefix <= max.prefix && n.suffix <= max.suffix && item.mods.length <= max.total, 'Affix capacity exceeded');
  requireThat(item.mods.filter(roll => roll.kind === 'crafted').length <= meta(catalog, item).crafted_limit, 'Crafted modifier limit exceeded');
  keys(item.sockets, ['colours', 'links'], 'sockets');
  requireThat(Array.isArray(item.sockets.colours) && item.sockets.colours.length <= 6 && item.sockets.colours.every(colour => ['R', 'G', 'B', 'W', 'A'].includes(colour)), 'Invalid socket colours');
  requireThat(Array.isArray(item.sockets.links) && item.sockets.links.every(n => Number.isInteger(n) && n >= 1 && n <= 6) && item.sockets.links.reduce((a, b) => a + b, 0) === item.sockets.colours.length, 'Socket links must partition the sockets');
  keys(item.eldritch, ['exarch', 'eater'], 'eldritch');
  for (const side of ['exarch', 'eater']) if (item.eldritch[side] !== null) {
    const entry = item.eldritch[side]; keys(entry, ['id', 'tier'], 'eldritch implicit'); integer(entry.tier, 1, 6, 'eldritch tier');
    requireThat(item.implicits.some(roll => roll.id === entry.id && roll.kind === 'eldritch'), 'Missing eldritch roll');
  }
  if (item.eldritch.exarch || item.eldritch.eater) {
    requireThat(['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(base.item_class), 'Invalid eldritch item class');
    requireThat(!item.influences.length && !item.synthesised, 'Eldritch cannot coexist with influence/synthesis');
  }
  if (item.cluster !== null) {
    keys(item.cluster, ['skill', 'passives'], 'cluster');
    const cluster = catalog.clusters[base.id];
    requireThat(cluster && cluster.passive_skills.some(skill => skill.id === item.cluster.skill), 'Invalid cluster skill');
    integer(item.cluster.passives, cluster.min_skills, cluster.max_skills, 'cluster passive count');
  } else requireThat(domain !== 'affliction_jewel', 'Cluster Jewel needs explicit skill and passive count');
  return item;
}

export function createItem(catalog, input, rng) {
  keys(input, ['base', 'item_level', 'rarity', 'mods', 'influences', 'corrupted', 'mirrored', 'split', 'quality', 'sockets', 'cluster'], 'initial item');
  const base = baseOf(catalog, input.base);
  const item = { base_id: base.id, item_level: input.item_level, rarity: input.rarity ?? 'normal', mods: [],
    implicits: base.implicits.map(id => makeRoll(catalog.mods.get(id), rng, { kind: 'implicit' })), enchantments: [],
    influences: [...(input.influences ?? [])], corrupted: input.corrupted ?? false, mirrored: input.mirrored ?? false, split: input.split ?? false,
    synthesised: false, quality: input.quality ?? 0, sockets: structuredClone(input.sockets ?? { colours: [], links: [] }),
    cluster: structuredClone(input.cluster ?? null), eldritch: { exarch: null, eater: null } };
  requireThat(Array.isArray(input.mods ?? []) && (input.mods ?? []).length <= 6, 'Initial mods must be an array');
  for (const entry of input.mods ?? []) {
    const spec = typeof entry === 'string' ? { id: entry } : entry;
    keys(spec, ['id', 'kind', 'fractured', 'values'], 'initial modifier');
    const mod = catalog.mods.get(spec.id);
    requireThat(isAffix(mod), `Unknown affix: ${spec.id}`);
    const roll = makeRoll(mod, rng, { kind: spec.kind ?? (mod.domain === 'crafted' ? 'crafted' : mod.domain === 'veiled' ? 'veiled' : mod.domain === 'unveiled' ? 'unveiled' : mod.is_essence_only ? 'essence' : 'natural'), fractured: spec.fractured ?? false });
    if (spec.values !== undefined) roll.values = structuredClone(spec.values);
    item.mods.push(roll);
  }
  validateItem(catalog, item);
  // Initial ownership is assumed, but ordinary natural affixes still require a base/influence/ilvl match.
  const tags = itemTags(catalog, item);
  for (const roll of item.mods.filter(roll => roll.kind === 'natural')) {
    const mod = definition(catalog, roll);
    requireThat(!mod.is_essence_only && mod.required_level <= item.item_level && firstWeight(mod.spawn_weights, tags, 0) > 0, `Initial modifier not naturally eligible: ${mod.id}`);
  }
  return item;
}

export function pool(catalog, item, options = {}) {
  const base = baseOf(catalog, item.base_id), tags = itemTags(catalog, item), max = capacity(catalog, item), n = count(catalog, item), restrictions = meta(catalog, item);
  const existing = options.implicit ? item.implicits : item.mods;
  const ids = new Set(existing.map(roll => roll.id)), groups = new Set(existing.flatMap(roll => definition(catalog, roll).groups));
  const domain = options.domain ?? base.domain;
  const source = [...(catalog.candidates.get(domain + ':' + (options.implicit ? options.generation_type : 'affix')) ?? []), ...(options.added_mods ?? []).map(id => catalog.mods.get(id))];
  const seen = new Set(), result = [];
  for (const mod of source) {
    if (!mod || seen.has(mod.id)) continue; seen.add(mod.id);
    if (options.implicit ? mod.generation_type !== options.generation_type : !isAffix(mod)) continue;
    if (mod.is_essence_only && !(options.added_mods ?? []).includes(mod.id)) continue;
    if (/Royale/.test(mod.id) || ids.has(mod.id) || (options.excluded_ids ?? []).includes(mod.id) || mod.groups.some(group => groups.has(group) || (options.excluded_groups ?? []).includes(group))) continue;
    if (!options.ignore_level && mod.required_level > (options.item_level ?? item.item_level)) continue;
    if (!options.implicit && (item.mods.length >= max.total || n[mod.generation_type] >= max[mod.generation_type])) continue;
    if (options.side && mod.generation_type !== options.side) continue;
    if (options.tag && !mod.implicit_tags.includes(options.tag)) continue;
    if (options.influence && !mod.spawn_weights.some(w => w.tag === influenceTag(catalog, base, options.influence) && w.weight > 0)) continue;
    if (options.respect_tags !== false && ((restrictions.attack && mod.implicit_tags.includes('attack')) || (restrictions.caster && mod.implicit_tags.includes('caster')))) continue;
    let weight = firstWeight(mod.spawn_weights, tags, 0) * firstWeight(mod.generation_weights, tags, 100) / 100;
    if ((options.added_mods ?? []).includes(mod.id) && weight === 0 && mod.spawn_weights.length === 0) weight = 1000;
    if (options.weight) weight *= options.weight(mod);
    if (weight > 0) result.push({ id: mod.id, weight, side: mod.generation_type, groups: mod.groups, required_level: mod.required_level, text: mod.text ?? null });
  }
  return { rows: result, total_weight: result.reduce((sum, row) => sum + row.weight, 0), tags: [...tags].sort() };
}
export function pickWeighted(rows, rng) {
  requireThat(rows.length > 0, 'No eligible outcomes');
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  requireThat(Number.isFinite(total) && total > 0, 'Invalid outcome weights');
  let ticket = rng.int(0x100000000) / 0x100000000 * total;
  return rows.find(row => (ticket -= row.weight) < 0) ?? rows.at(-1);
}
export function addRandom(catalog, item, rng, options = {}) {
  const selected = pickWeighted(pool(catalog, item, options).rows, rng);
  const roll = makeRoll(catalog.mods.get(selected.id), rng, { kind: options.kind ?? 'natural', lucky: options.lucky ?? false });
  (options.implicit ? item.implicits : item.mods).push(roll);
  return roll;
}
export function protectedIds(catalog, item, rng, respectLocks = true) {
  const locked = new Set(item.mods.filter(roll => roll.fractured).map(roll => roll.id));
  if (!respectLocks) return locked;
  const limits = meta(catalog, item);
  for (const side of ['prefix', 'suffix']) {
    const candidates = item.mods.filter(roll => definition(catalog, roll).generation_type === side && !locked.has(roll.id));
    // Counted 3.30 locks choose protected affixes for this action, never freeze a chosen affix across actions.
    let remaining = limits[side];
    while (remaining > 0 && candidates.length) { locked.add(candidates.splice(rng.int(candidates.length), 1)[0].id); remaining--; }
  }
  return locked;
}
export function removeRandom(catalog, item, rng, options = {}) {
  const locked = protectedIds(catalog, item, rng, options.respect_locks !== false);
  const candidates = item.mods.filter(roll => !locked.has(roll.id) && (!options.side || definition(catalog, roll).generation_type === options.side));
  requireThat(candidates.length > 0, 'No removable modifier');
  const selected = candidates[rng.int(candidates.length)];
  item.mods = item.mods.filter(roll => roll.id !== selected.id); return selected;
}
export function lowestRarity(catalog, item) {
  const n = count(catalog, item);
  item.rarity = n.prefix > 1 || n.suffix > 1 ? 'rare' : item.mods.length ? 'magic' : 'normal';
}
