import { baseOf, influenceTag } from './catalog.mjs';
import { firstWeight } from '../engine.mjs';
import { requireThat, isAffix, definition, sideOf, capacity, count, meta, itemTags, influencesOf, makeRoll, JEWEL_DOMAINS } from './item.mjs';
import { ruleValue } from './rules.mjs';

// Tier context of one mod on one item: eligible tiers of its type on this base at this level (rule tier.numbering).
export function tierInfo(catalog, item, mod, tags = itemTags(catalog, item), itemLevel = item.item_level) {
  const rows = (catalog.byType.get(`${mod.domain}|${mod.generation_type}|${mod.type}`) ?? [])
    .filter(row => firstWeight(row.spawn_weights, tags, 0) > 0 && row.required_level <= itemLevel && !row.is_essence_only)
    .sort((a, b) => b.required_level - a.required_level || (a.id < b.id ? -1 : 1));
  const index = rows.findIndex(row => row.id === mod.id);
  return { tiers: rows, tier: index < 0 ? null : index + 1, count: rows.length };
}
// Memory Strand / Foulborn cut (rules strands.cut, strands.foulborn). Returns null for no cut.
export function cutDenominator(item, foulborn = false) {
  const s = item.memory_strands;
  if (!foulborn) return s >= 1 ? 2.5 * s + 147.5 : null;
  return s >= 1 ? 2.5 * s + 147.5 + 75 : 175;
}
export const keptTiers = (T, D) => D === null ? T : Math.min(T, Math.floor(100 / D * (T - 1)) + 1);

export function influenceModOf(catalog, item, mod, tags = itemTags(catalog, item)) {
  const entry = mod.spawn_weights.find(row => tags.has(row.tag));
  const base = baseOf(catalog, item.base_id);
  return influencesOf(catalog, item).find(influence => entry?.tag === influenceTag(catalog, base, influence)) ?? null;
}

export function pool(catalog, item, options = {}) {
  const base = baseOf(catalog, item.base_id), tags = options.tags ?? itemTags(catalog, item), max = capacity(catalog, item), n = count(catalog, item), restrictions = meta(catalog, item);
  const existing = options.implicit ? item.implicits : item.mods;
  const ids = new Set(existing.map(roll => roll.id)), groups = new Set((options.implicit ? existing.filter(roll => options.block_implicit_groups) : existing).flatMap(roll => definition(catalog, roll).groups));
  const domain = options.domain ?? base.domain, itemLevel = options.item_level ?? item.item_level;
  const added = (options.added_mods ?? []).map(id => catalog.mods.get(id)).filter(Boolean);
  const source = [...(catalog.candidates.get(domain + ':' + (options.implicit ? options.generation_type : 'affix')) ?? []), ...added];
  const D = options.cut === 'strands' ? cutDenominator(item) : options.cut === 'foulborn' ? cutDenominator(item, true) : null;
  const tierCache = new Map(), seen = new Set(), result = [];
  for (const mod of source) {
    if (!mod || seen.has(mod.id)) continue; seen.add(mod.id);
    const isAdded = added.includes(mod);
    if (options.implicit ? mod.generation_type !== options.generation_type : !isAffix(mod)) continue;
    if (mod.is_essence_only && !isAdded) continue;
    if (/Royale/.test(mod.id) || ids.has(mod.id) || (options.excluded_ids ?? []).includes(mod.id) || mod.groups.some(group => groups.has(group) || (options.excluded_groups ?? []).includes(group))) continue;
    if (!options.ignore_level && mod.required_level > itemLevel) continue;
    if (!options.implicit && !options.ignore_capacity && (item.mods.length >= max.total || n[mod.generation_type] >= max[mod.generation_type])) continue;
    if (options.side && mod.generation_type !== options.side) continue;
    if (options.tag && !mod.implicit_tags.includes(options.tag)) continue;
    if (options.influence && influenceModOf(catalog, item, mod, tags) !== options.influence) continue;
    if (options.influenced_only && !influenceModOf(catalog, item, mod, tags)) continue;
    if (options.respect_tags !== false && ((restrictions.attack && mod.implicit_tags.includes('attack')) || (restrictions.caster && mod.implicit_tags.includes('caster')))) continue;
    let weight = firstWeight(mod.spawn_weights, tags, 0) * firstWeight(mod.generation_weights, tags, 100) / 100;
    if (isAdded && weight === 0 && mod.spawn_weights.every(row => row.weight === 0)) weight = options.added_weight ?? 1000;
    if (weight > 0 && D !== null && !options.implicit) {
      const key = mod.type + '|' + mod.generation_type;
      if (!tierCache.has(key)) tierCache.set(key, tierInfo(catalog, item, mod, tags, itemLevel));
      const info = tierCache.get(key), K = keptTiers(info.count, D);
      const index = info.tiers.findIndex(row => row.id === mod.id);
      if (index >= 0) { if (index >= K) continue; weight *= info.count / K; }
    }
    if (options.weight) weight *= options.weight(mod);
    if (weight > 0) result.push({ id: mod.id, weight, side: mod.generation_type, groups: mod.groups, required_level: mod.required_level, text: mod.text ?? null });
  }
  return { rows: result, total_weight: result.reduce((sum, row) => sum + row.weight, 0), tags: [...tags].sort(), cut_denominator: D };
}
export function pickWeighted(rows, rng) {
  requireThat(rows.length > 0, 'No eligible outcomes');
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  requireThat(Number.isFinite(total) && total > 0, 'Invalid outcome weights');
  let ticket = rng.int(0x100000000) / 0x100000000 * total;
  return rows.find(row => (ticket -= row.weight) < 0) ?? rows.at(-1);
}
export const pickUniform = (rows, rng) => { requireThat(rows.length > 0, 'No eligible outcomes'); return rows[rng.int(rows.length)]; };
export function addRandom(catalog, item, rng, options = {}) {
  const selected = pickWeighted(pool(catalog, item, options).rows, rng);
  const roll = makeRoll(catalog.mods.get(selected.id), rng, { kind: options.kind ?? 'natural', lucky: options.lucky ?? false });
  (options.implicit ? item.implicits : item.mods).push(roll);
  return roll;
}
// Fractured mods plus mods protected by full/counted locks for this action (rules meta.full_lock, meta.counted_lock_selection).
export function protectedIds(catalog, item, rng, respectLocks = true) {
  const locked = new Set(item.mods.filter(roll => roll.fractured).map(roll => roll.id));
  if (!respectLocks) return locked;
  const limits = meta(catalog, item);
  for (const side of ['prefix', 'suffix']) {
    const candidates = item.mods.filter(roll => sideOf(catalog, roll) === side && !locked.has(roll.id));
    let remaining = limits[side];
    while (remaining > 0 && candidates.length) { locked.add(candidates.splice(rng.int(candidates.length), 1)[0].id); remaining--; }
  }
  return locked;
}
export function removable(catalog, item, rng, options = {}) {
  const locked = protectedIds(catalog, item, rng, options.respect_locks !== false);
  const m = meta(catalog, item);
  return item.mods.filter(roll => !locked.has(roll.id) && !(options.exclude ?? []).includes(roll.id)
    && (!options.side || sideOf(catalog, roll) === options.side)
    && (!options.respect_tags || !((m.attack && definition(catalog, roll).implicit_tags.includes('attack')) || (m.caster && definition(catalog, roll).implicit_tags.includes('caster')))));
}
export function removeRandom(catalog, item, rng, options = {}) {
  const candidates = removable(catalog, item, rng, options);
  requireThat(candidates.length > 0, 'No removable modifier');
  const selected = candidates[rng.int(candidates.length)];
  item.mods = item.mods.filter(roll => roll !== selected); return selected;
}
export function drawCount(catalog, item, rng) {
  const max = capacity(catalog, item);
  if (item.rarity === 'magic') return Math.min(max.total, pickWeighted(Object.entries(ruleValue('count.magic')).map(([n, weight]) => ({ n: Number(n), weight })), rng).n);
  const base = baseOf(catalog, item.base_id);
  if (base.tags.some(tag => /nightmare/.test(tag))) return max.total;
  const table = JEWEL_DOMAINS.includes(base.domain) ? ruleValue('count.jewel') : ruleValue('count.rare');
  return Math.min(max.total, pickWeighted(Object.entries(table).map(([n, weight]) => ({ n: Number(n), weight })), rng).n);
}
// Chaos-like reforge. Kept (fractured/locked) and forced mods count inside the drawn total (rules count.rare, count.dry_pool).
export function reforge(catalog, item, rng, options = {}) {
  const keep = protectedIds(catalog, item, rng, options.respect_locks !== false);
  for (const id of options.keep_ids ?? []) keep.add(id);
  item.mods = item.mods.filter(roll => keep.has(roll.id) || (options.keep_side && sideOf(catalog, roll) === options.keep_side));
  if (options.rarity) item.rarity = options.rarity;
  const targetCount = Math.max(item.mods.length, options.count ?? drawCount(catalog, item, rng));
  for (const mod of options.forced ?? []) {
    const max = capacity(catalog, item), n = count(catalog, item);
    requireThat(n[mod.generation_type] < max[mod.generation_type] && item.mods.length < max.total, 'No slot for guaranteed modifier');
    requireThat(!item.mods.some(roll => definition(catalog, roll).groups.some(group => mod.groups.includes(group))), 'Guaranteed modifier conflicts with retained modifiers');
    item.mods.push(makeRoll(mod, rng, { kind: options.forced_kind ?? 'essence', lucky: options.lucky ?? false }));
  }
  if (options.first) {
    const rows = pool(catalog, item, { ...options.pool, ...options.first }).rows;
    requireThat(rows.length > 0, 'No modifier of the guaranteed kind fits the item');
    const choice = pickWeighted(rows, rng);
    item.mods.push(makeRoll(catalog.mods.get(choice.id), rng, { kind: options.first.kind ?? 'natural', lucky: options.lucky ?? false }));
  }
  while (item.mods.length < targetCount) {
    const candidates = pool(catalog, item, options.pool ?? {});
    if (!candidates.rows.length) break;
    const choice = pickWeighted(candidates.rows, rng);
    item.mods.push(makeRoll(catalog.mods.get(choice.id), rng, { kind: options.kind ?? 'natural', lucky: options.lucky ?? false }));
  }
  requireThat(item.mods.length > 0 || options.allow_empty, 'No eligible modifiers for this base/context');
}
