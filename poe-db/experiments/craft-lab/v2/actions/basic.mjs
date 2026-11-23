// Currency orbs. Each entry: rules (registry ids), previewable (Hinekora), strands (spend key or function), apply(ctx).
import { baseOf, influenceTag, armourClasses, jewelleryClasses } from '../catalog.mjs';
import { firstWeight } from '../../engine.mjs';
import { requireThat, definition, sideOf, capacity, count, meta, makeRoll, itemTags, lowestRarity, mutable, equipment, rare, isJewel, valuesOf, QUALITY_TYPES, fracturedCount } from '../item.mjs';
import { pool, addRandom, pickWeighted, pickUniform, protectedIds, removable, removeRandom, reforge, tierInfo, influenceModOf } from '../draw.mjs';
import { maxSockets, chromatic, jewellerCount, setSocketCount, fusing, randomSockets, qualityGain, colourWeights, socketClasses } from '../sockets.mjs';
import { ruleValue } from '../rules.mjs';

const uncorrupted = ({ catalog, item }) => mutable(catalog, item);
const cutPool = (ctx, extra = {}) => ({ cut: ctx.item.memory_strands > 0 ? 'strands' : null, ...extra });
export const influenceOrbs = Object.freeze({ "Shaper's Exalted Orb": 'Shaper', "Elder's Exalted Orb": 'Elder', "Crusader's Exalted Orb": 'Crusader', "Redeemer's Exalted Orb": 'Redeemer', "Hunter's Exalted Orb": 'Hunter', "Warlord's Exalted Orb": 'Warlord' });
const implicitCurrencies = Object.fromEntries(['Lesser', 'Greater', 'Grand', 'Exceptional'].flatMap((tier, i) => [[`${tier} Eldritch Ember`, { side: 'exarch', tier: i + 1 }], [`${tier} Eldritch Ichor`, { side: 'eater', tier: i + 1 }]]));
const catalysts = ['Abrasive', 'Accelerating', 'Fertile', 'Imbued', 'Intrinsic', 'Noxious', 'Prismatic', 'Tempering', 'Turbulent', 'Unstable', 'Sinistral', 'Dextral'];
const exaltSpend = item => ruleValue('strands.spend').exalted_by_mods[Math.min(5, item.mods.length)];

function outcomeWeights(action, names) {
  requireThat(action.assume && typeof action.assume === 'object', `This currency has unpublished 3.30 outcome odds; pass assume: {${names.join(', ')}} as explicit weights`);
  const rows = names.map(name => ({ name, weight: action.assume[name] ?? 0 }));
  requireThat(Object.keys(action.assume).every(key => names.includes(key)) && rows.every(row => Number.isFinite(row.weight) && row.weight >= 0) && rows.some(row => row.weight > 0), 'Invalid outcome assumption');
  return rows;
}
function eldritchSide(item) {
  const a = item.eldritch.exarch?.tier ?? 0, b = item.eldritch.eater?.tier ?? 0;
  requireThat(a !== b, 'No dominant Eldritch influence');
  return a > b ? 'prefix' : 'suffix';
}
function implicitTier(mod) {
  const tag = mod.spawn_weights.find(row => /^no_tier_[1-6]_eldritch_implicit$/.test(row.tag))?.tag;
  return tag ? 7 - Number(tag.match(/\d/)[0]) : null;
}
function eldritchImplicit(catalog, item, side, tier, rng, familyType = null) {
  const generation = side === 'exarch' ? 'searing_exarch_implicit' : 'eater_of_worlds_implicit';
  const rows = pool(catalog, item, { implicit: true, generation_type: generation, ignore_level: true, respect_tags: false,
    weight: mod => implicitTier(mod) === tier && (familyType === null || mod.type === familyType) ? 1 : 0 }).rows;
  return pickWeighted(rows, rng);
}
function eldritchGate(catalog, item) {
  const base = baseOf(catalog, item.base_id);
  requireThat(armourClasses.includes(base.item_class) && !item.influences.length && !item.synthesised, 'Eldritch currency needs an uninfluenced, unsynthesised armour piece');
  requireThat(!meta(catalog, item).immutable_implicits, 'Implicit modifiers cannot be changed');
}
function corruptedImplicitPool(catalog, item) {
  const base = baseOf(catalog, item.base_id), tags = itemTags(catalog, item);
  return (catalog.candidates.get(base.domain + ':corrupted') ?? []).filter(mod => mod.required_level <= item.item_level && firstWeight(mod.spawn_weights, tags, 0) > 0)
    .map(mod => ({ id: mod.id, weight: firstWeight(mod.spawn_weights, tags, 0), groups: mod.groups }));
}
// Corrupted implicit outcome; with two Vaal implicits it replaces one of them (rule corrupt.implicit_330).
export function addCorruptedImplicits(catalog, item, rng, n) {
  const added = [];
  for (let i = 0; i < n; i++) {
    const rows = corruptedImplicitPool(catalog, item).filter(row => !added.some(roll => definition(catalog, roll).groups.some(group => row.groups.includes(group))));
    if (!rows.length) break;
    const roll = makeRoll(catalog.mods.get(pickWeighted(rows, rng).id), rng, { kind: 'corrupted' });
    const vaal = item.implicits.filter(r => r.kind === 'corrupted' && !added.includes(r));
    const replaceable = vaal.length >= 2 ? vaal : item.implicits.filter(r => !added.includes(r));
    if (replaceable.length) {
      const target = pickUniform(replaceable, rng);
      item.implicits = item.implicits.filter(r => r !== target);
      for (const side of ['exarch', 'eater']) if (item.eldritch[side]?.id === target.id) item.eldritch[side] = null;
    }
    item.implicits.push(roll); added.push(roll);
  }
}
function vaalBrick(catalog, item, rng) {
  item.rarity = 'rare';
  reforge(catalog, item, rng, { count: capacity(catalog, item, 'rare').total, pool: {} });
  randomSockets(catalog, item, rng);
}
// Neighbouring tier of the same mod type (delta +1 = better); null when it does not exist.
function tierStep(catalog, item, roll, delta) {
  const info = tierInfo(catalog, item, definition(catalog, roll));
  const index = info.tier === null ? -1 : info.tier - 1 - delta;
  return delta === 0 || index < 0 || index >= info.tiers.length ? null : info.tiers[index];
}

const T = (rules, apply, extra = {}) => ({ rules, apply, previewable: true, ...extra });
export const currency = {
  'Orb of Transmutation': T(['orb.transmutation', 'count.magic', 'strands.cut'], ctx => { uncorrupted(ctx); requireThat(ctx.item.rarity === 'normal', 'Transmutation requires normal rarity'); reforge(ctx.catalog, ctx.item, ctx.rng, { rarity: 'magic', pool: cutPool(ctx) }); }, { strands: 'transmutation' }),
  'Orb of Alteration': T(['orb.alteration', 'count.magic', 'meta.full_lock', 'strands.cut'], ctx => { uncorrupted(ctx); requireThat(ctx.item.rarity === 'magic', 'Alteration requires magic rarity'); reforge(ctx.catalog, ctx.item, ctx.rng, { pool: cutPool(ctx) }); }, { strands: 'alteration' }),
  'Orb of Augmentation': T(['orb.augmentation', 'pool.one_pool', 'strands.cut'], ctx => { uncorrupted(ctx); requireThat(ctx.item.rarity === 'magic', 'Augmentation requires magic rarity'); addRandom(ctx.catalog, ctx.item, ctx.rng, cutPool(ctx)); }, { strands: 'augmentation' }),
  'Regal Orb': T(['orb.regal', 'strands.cut'], ctx => { uncorrupted(ctx); requireThat(ctx.item.rarity === 'magic', 'Regal requires magic rarity'); ctx.item.rarity = 'rare'; addRandom(ctx.catalog, ctx.item, ctx.rng, cutPool(ctx)); }, { strands: 'regal' }),
  'Orb of Alchemy': T(['orb.alchemy', 'count.rare', 'strands.cut'], ctx => { uncorrupted(ctx); requireThat(ctx.item.rarity === 'normal', 'Alchemy requires normal rarity'); reforge(ctx.catalog, ctx.item, ctx.rng, { rarity: 'rare', pool: cutPool(ctx) }); }, { strands: 'alchemy' }),
  'Orb of Binding': T(['orb.alchemy', 'count.rare'], ctx => {
    uncorrupted(ctx); requireThat(ctx.item.rarity === 'normal', 'Binding requires normal rarity');
    reforge(ctx.catalog, ctx.item, ctx.rng, { rarity: 'rare', pool: cutPool(ctx) });
    const n = Math.min(4, ctx.item.sockets.colours.length); if (n) { setSocketCount(ctx.item, n); ctx.item.sockets.links = [n]; }
  }, { strands: 'alchemy', note: 'No longer obtainable in 3.30; existing orbs still function.' }),
  'Chaos Orb': T(['orb.chaos', 'count.rare', 'meta.full_lock', 'meta.tag_filters', 'strands.cut'], ctx => { uncorrupted(ctx); rare(ctx.item); reforge(ctx.catalog, ctx.item, ctx.rng, { pool: cutPool(ctx) }); }, { strands: 'chaos' }),
  'Exalted Orb': T(['orb.exalted', 'pool.one_pool', 'meta.tag_filters', 'strands.cut'], ctx => { uncorrupted(ctx); rare(ctx.item); addRandom(ctx.catalog, ctx.item, ctx.rng, cutPool(ctx)); }, { strands: exaltSpend }),
  'Foulborn Orb of Augmentation': T(['strands.foulborn', 'orb.augmentation'], ctx => { uncorrupted(ctx); requireThat(ctx.item.rarity === 'magic', 'Requires magic rarity'); addRandom(ctx.catalog, ctx.item, ctx.rng, { cut: 'foulborn' }); }, { strands: 'foulborn_augmentation' }),
  'Foulborn Regal Orb': T(['strands.foulborn', 'orb.regal'], ctx => { uncorrupted(ctx); requireThat(ctx.item.rarity === 'magic', 'Requires magic rarity'); ctx.item.rarity = 'rare'; addRandom(ctx.catalog, ctx.item, ctx.rng, { cut: 'foulborn' }); }, { strands: 'foulborn_regal' }),
  'Foulborn Exalted Orb': T(['strands.foulborn', 'orb.exalted'], ctx => { uncorrupted(ctx); rare(ctx.item); addRandom(ctx.catalog, ctx.item, ctx.rng, { cut: 'foulborn' }); }, { strands: item => ruleValue('strands.spend').foulborn_exalted_by_mods[Math.min(5, item.mods.length)] }),
  'Orb of Annulment': T(['orb.annulment', 'orb.annulment_330_tag_filters', 'meta.full_lock'], ctx => { uncorrupted(ctx); requireThat(ctx.item.rarity !== 'normal', 'Annulment requires magic/rare rarity'); removeRandom(ctx.catalog, ctx.item, ctx.rng, { respect_tags: false }); }),
  'Orb of Scouring': T(['orb.scouring', 'meta.full_lock'], ctx => {
    uncorrupted(ctx); requireThat(ctx.item.rarity !== 'normal', 'Scouring requires magic/rare rarity');
    const keep = protectedIds(ctx.catalog, ctx.item, ctx.rng); ctx.item.mods = ctx.item.mods.filter(roll => keep.has(roll.id)); lowestRarity(ctx.catalog, ctx.item);
  }),
  'Divine Orb': T(['orb.divine', 'meta.full_lock'], ctx => {
    uncorrupted(ctx); const keep = protectedIds(ctx.catalog, ctx.item, ctx.rng);
    requireThat(ctx.item.mods.some(roll => !keep.has(roll.id) && definition(ctx.catalog, roll).stats.some(stat => stat.min !== stat.max)), 'No modifiable numeric ranges');
    ctx.item.mods = ctx.item.mods.map(roll => keep.has(roll.id) ? roll : makeRoll(definition(ctx.catalog, roll), ctx.rng, { kind: roll.kind, fractured: roll.fractured }));
  }),
  'Blessed Orb': T(['orb.blessed'], ctx => {
    uncorrupted(ctx); requireThat(!meta(ctx.catalog, ctx.item).immutable_implicits, 'Implicit modifiers cannot be changed');
    requireThat(ctx.item.implicits.some(roll => definition(ctx.catalog, roll).stats.some(stat => stat.min !== stat.max)), 'No implicit with a value range');
    ctx.item.implicits = ctx.item.implicits.map(roll => makeRoll(definition(ctx.catalog, roll), ctx.rng, { kind: roll.kind, fractured: roll.fractured }));
  }),
  'Fracturing Orb': T(['orb.fracturing'], ctx => {
    uncorrupted(ctx); equipment(ctx.catalog, ctx.item); rare(ctx.item);
    requireThat(ctx.item.mods.length >= 4 && !ctx.item.influences.length && !ctx.item.synthesised && !fracturedCount(ctx.item), 'Fracturing needs a rare with >= 4 mods, no influence, synthesis or fractured mod');
    pickUniform(ctx.item.mods, ctx.rng).fractured = true;
  }),
  'Orb of Chance': T(['orb.chance', 'strands.cut'], ctx => {
    uncorrupted(ctx); requireThat(ctx.item.rarity === 'normal', 'Chance requires normal rarity');
    const outcome = pickWeighted(outcomeWeights(ctx.action, ['magic', 'rare', 'unique']), ctx.rng).name;
    if (outcome === 'unique') { ctx.session.status = 'unique_outcome'; ctx.notes.push('Unique outcome: the unique identity of this base is not modelled; the episode ends.'); return; }
    reforge(ctx.catalog, ctx.item, ctx.rng, { rarity: outcome, pool: cutPool(ctx) });
  }, { strands: 'chance', params: ['assume'] }),
  'Orb of Remembrance': T(['strands.remembrance'], ctx => {
    uncorrupted(ctx); equipment(ctx.catalog, ctx.item); requireThat(ctx.item.rarity === 'normal', 'Remembrance requires a normal equipment item');
    for (let i = 0; i < 10000; i++) {
      const u1 = (ctx.rng.int(0xffffffff) + 1) / 0x100000000, u2 = ctx.rng.int(0x100000000) / 0x100000000;
      const x = 35 + 25 * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      if (x >= 10 && x < 100.5) { ctx.item.memory_strands = Math.min(100, Math.round(x)); return; }
    }
    throw new Error('Remembrance sampling limit');
  }),
  'Orb of Unravelling': T(['strands.unravelling'], ctx => {
    uncorrupted(ctx); equipment(ctx.catalog, ctx.item); const s = ctx.item.memory_strands; requireThat(s > 0, 'Unravelling requires Memory Strands');
    const tags = itemTags(ctx.catalog, ctx.item), shadow = structuredClone(ctx.item); shadow.mods = []; shadow.rarity = 'rare';
    const sideWeight = side => pool(ctx.catalog, shadow, { side, respect_tags: false }).total_weight;
    const W = { prefix: sideWeight('prefix'), suffix: sideWeight('suffix') };
    ctx.item.mods = ctx.item.mods.map(roll => {
      const mod = definition(ctx.catalog, roll);
      if (roll.fractured || roll.kind !== 'natural' || influenceModOf(ctx.catalog, ctx.item, mod, tags) === null && firstWeight(mod.spawn_weights, tags, 0) === 0) return roll;
      const info = tierInfo(ctx.catalog, ctx.item, mod, tags); if (!info.tier || info.tier === 1) return roll;
      const higher = info.tiers.slice(0, info.tier - 1), wUp = higher.reduce((a, row) => a + firstWeight(row.spawn_weights, tags, 0), 0);
      const chance = Math.min(1, s * wUp / (2 * W[mod.generation_type]));
      if (ctx.rng.int(1000000) / 1000000 >= chance) return roll;
      const rows = higher.map((row, i) => ({ id: row.id, weight: higher.slice(0, i + 1).reduce((a, r) => a + firstWeight(r.spawn_weights, tags, 0), 0) }));
      return makeRoll(ctx.catalog.mods.get(pickWeighted(rows, ctx.rng).id), ctx.rng, { kind: roll.kind });
    });
    ctx.item.memory_strands = 0;
  }),
  'Veiled Exalted Orb': T(['veiled.exalted'], ctx => {
    const { catalog, item, rng } = ctx; uncorrupted(ctx); equipment(catalog, item); rare(item);
    requireThat(!item.mods.some(roll => ['veiled', 'unveiled'].includes(roll.kind)), 'Item already has a veiled/unveiled modifier');
    removeRandom(catalog, item, rng);
    const max = capacity(catalog, item), n = count(catalog, item), sides = ['prefix', 'suffix'].filter(side => n[side] < max[side]);
    requireThat(sides.length, 'No room for a veiled modifier');
    const side = pickUniform(sides, rng); item.mods.push(makeRoll(catalog.mods.get(side === 'prefix' ? 'VeiledPrefix' : 'VeiledSuffix'), rng, { kind: 'veiled' }));
  }),
  'Veiled Chaos Orb': T(['veiled.chaos', 'veiled.chaos_330b', 'count.rare', 'strands.cut'], ctx => {
    const { catalog, item, rng } = ctx; uncorrupted(ctx); equipment(catalog, item); rare(item);
    const keep = protectedIds(catalog, item, rng);
    requireThat(!item.mods.some(roll => ['veiled', 'unveiled'].includes(roll.kind) && keep.has(roll.id)), 'A veiled mod protected by fracturing or a metamod blocks Veiled Chaos');
    item.mods = item.mods.filter(roll => keep.has(roll.id));
    const total = Math.max(item.mods.length + 1, drawTotal(catalog, item, rng));
    const max = capacity(catalog, item), n = count(catalog, item), sides = ['prefix', 'suffix'].filter(side => n[side] < max[side]);
    requireThat(sides.length, 'No room for a veiled modifier');
    const side = pickUniform(sides, rng); item.mods.push(makeRoll(catalog.mods.get(side === 'prefix' ? 'VeiledPrefix' : 'VeiledSuffix'), rng, { kind: 'veiled' }));
    reforge(catalog, item, rng, { respect_locks: false, keep_ids: item.mods.map(roll => roll.id), count: total, pool: cutPool(ctx) });
  }, { strands: 'veiled_chaos' }),
  'Orb of Dominance': T(['influence.dominance', 'influence.elevated_map'], ctx => {
    const { catalog, item, rng } = ctx; uncorrupted(ctx);
    requireThat(['magic', 'rare'].includes(item.rarity) && armourClasses.includes(baseOf(catalog, item.base_id).item_class), 'Dominance needs a magic/rare armour piece');
    const tags = itemTags(catalog, item), keep = protectedIds(catalog, item, rng);
    const influenced = item.mods.filter(roll => influenceModOf(catalog, item, definition(catalog, roll), tags) || roll.kind === 'elevated');
    requireThat(influenced.length >= 2, 'Needs at least two influenced modifiers');
    const eligible = influenced.filter(roll => !keep.has(roll.id)); requireThat(eligible.length >= 2, 'Locked sides leave fewer than two eligible influenced mods');
    const removed = pickUniform(eligible, rng), upgraded = pickUniform(eligible.filter(roll => roll !== removed), rng);
    item.mods = item.mods.filter(roll => roll !== removed);
    const index = item.mods.indexOf(upgraded), mod = definition(catalog, upgraded);
    if (upgraded.kind === 'elevated') { item.mods[index] = makeRoll(mod, rng, { kind: 'elevated' }); return; }
    const info = tierInfo(catalog, item, mod, tags, 100);
    if (info.tier && info.tier > 1) { item.mods[index] = makeRoll(info.tiers[info.tier - 2], rng, { kind: upgraded.kind }); return; }
    const elevatedId = catalog.elevated.get(mod.id); requireThat(elevatedId, `No admitted Elevated version for ${mod.id}`);
    item.mods[index] = makeRoll(catalog.mods.get(elevatedId), rng, { kind: 'elevated' });
  }),
  'Orb of Conflict': T(['eldritch.conflict'], ctx => {
    const { catalog, item, rng } = ctx; uncorrupted(ctx);
    requireThat(item.eldritch.exarch && item.eldritch.eater, 'Conflict needs both Eldritch implicits');
    const hi = item.eldritch.exarch.tier >= item.eldritch.eater.tier ? 'exarch' : 'eater', lo = hi === 'exarch' ? 'eater' : 'exarch';
    const d = item.eldritch[hi].tier - item.eldritch[lo].tier, { intercept, slope } = ruleValue('eldritch.conflict');
    const p = d === 0 ? 0.5 : 1 / (1 + Math.exp(-(intercept - slope * d)));
    const up = rng.int(1000000) / 1000000 < p ? hi : lo, down = up === hi ? lo : hi;
    const move = (side, tier) => {
      const old = item.implicits.find(roll => roll.id === item.eldritch[side].id); item.implicits = item.implicits.filter(roll => roll !== old);
      if (tier < 1) { item.eldritch[side] = null; return; }
      const type = catalog.mods.get(old.id).type;
      const candidates = [...catalog.candidates.get('item:' + (side === 'exarch' ? 'searing_exarch_implicit' : 'eater_of_worlds_implicit'))].filter(mod => mod.type === type && implicitTier(mod) === tier);
      requireThat(candidates.length === 1, 'Conflict target implicit is ambiguous in the pinned data');
      item.implicits.push(makeRoll(candidates[0], rng, { kind: 'eldritch' })); item.eldritch[side] = { id: candidates[0].id, tier };
    };
    if (item.eldritch[up].tier < 6) move(up, item.eldritch[up].tier + 1);
    move(down, item.eldritch[down].tier - 1);
  }),
  'Eldritch Exalted Orb': T(['eldritch.orbs', 'eldritch.dominance'], ctx => { uncorrupted(ctx); equipment(ctx.catalog, ctx.item); rare(ctx.item); addRandom(ctx.catalog, ctx.item, ctx.rng, cutPool(ctx, { side: eldritchSide(ctx.item) })); }, { strands: exaltSpend }),
  'Eldritch Orb of Annulment': T(['eldritch.orbs', 'eldritch.dominance'], ctx => { uncorrupted(ctx); equipment(ctx.catalog, ctx.item); requireThat(ctx.item.rarity !== 'normal', 'Requires magic/rare'); removeRandom(ctx.catalog, ctx.item, ctx.rng, { side: eldritchSide(ctx.item), respect_tags: true }); }),
  'Eldritch Chaos Orb': T(['eldritch.orbs', 'eldritch.dominance', 'count.rare'], ctx => {
    uncorrupted(ctx); equipment(ctx.catalog, ctx.item); rare(ctx.item); const side = eldritchSide(ctx.item);
    reforge(ctx.catalog, ctx.item, ctx.rng, { keep_side: side === 'prefix' ? 'suffix' : 'prefix', respect_locks: false, pool: cutPool(ctx, { side }) });
  }, { strands: 'eldritch_chaos' }),
  'Vaal Orb': T(['corrupt.vaal', 'corrupt.vaal_jewel', 'corrupt.implicit_330'], ctx => {
    const { catalog, item, rng } = ctx; uncorrupted(ctx); requireThat(!item.corrupted, 'Already corrupted');
    item.corrupted = true;
    const jewel = isJewel(catalog, item), outcome = pickUniform(jewel ? ['implicit', 'brick', 'unique', 'nothing'] : ['implicit', 'socket', 'brick', 'nothing'], rng);
    ctx.notes.push(`Vaal outcome: ${outcome}`);
    if (outcome === 'implicit') addCorruptedImplicits(catalog, item, rng, 1);
    if (outcome === 'socket') { const whites = item.sockets.colours.map((c, i) => [c, i]).filter(([c]) => c === 'W'); if (whites.length) { const [, i] = pickUniform(whites, rng); item.sockets.colours[i] = pickWeighted(Object.entries(colourWeights(catalog, item)).map(([c, weight]) => ({ c, weight })), rng).c; } }
    if (outcome === 'brick') vaalBrick(catalog, item, rng);
    if (outcome === 'unique') { ctx.session.status = 'unique_outcome'; ctx.notes.push('Corruption-only unique jewel; identity is not modelled.'); }
  }),
  "Hinekora's Lock": T(['lock.hinekora'], ctx => {
    uncorrupted(ctx); requireThat(ctx.item.foreseeing === null, 'Item is already foreseeing');
    ctx.item.foreseeing = { seed: ctx.rng.int(0x100000000) }; ctx.keep_foresight = true;
  }, { previewable: false }),
  'Mirror of Kalandra': T(['orb.mirror', 'orb.eternal'], ctx => {
    requireThat(!ctx.item.mirrored && !ctx.item.split, 'Item cannot be mirrored'); requireThat(!meta(ctx.catalog, ctx.item).modifiable_corrupted, '3.30: cannot mirror items that can be modified while corrupted');
    const copy = structuredClone(ctx.item); copy.mirrored = true; copy.foreseeing = null;
    ctx.session.inventory[`mirror-${ctx.session.revision + 1}`] = copy; ctx.keep_foresight = true;
  }, { previewable: false }),
  // Sockets and quality
  "Jeweller's Orb": T(['sockets.jeweller', 'sockets.omens'], ctx => {
    uncorrupted(ctx); const max = maxSockets(ctx.catalog, ctx.item); requireThat(max > 1, 'Item cannot take a different socket count');
    if (ctx.action.omen) requireThat(ctx.action.omen === 'Omen of the Jeweller' && ctx.item.sockets.colours.length < max, 'Wrong omen or already at maximum sockets');
    setSocketCount(ctx.item, jewellerCount(ctx.catalog, ctx.item, ctx.rng, { omen: !!ctx.action.omen }));
  }, { params: ['omen'] }),
  'Orb of Fusing': T(['sockets.fusing', 'sockets.omens'], ctx => { uncorrupted(ctx); if (ctx.action.omen) requireThat(ctx.action.omen === 'Omen of Connections', 'Wrong omen'); fusing(ctx.item, ctx.rng, { omen: !!ctx.action.omen }); }, { params: ['omen'] }),
  'Chromatic Orb': T(['sockets.chromatic', 'sockets.omens'], ctx => {
    uncorrupted(ctx); if (ctx.action.omen) requireThat(ctx.action.omen === 'Omen of Trichromatism' && ctx.item.sockets.colours.length >= 3, 'Wrong omen or fewer than three sockets');
    chromatic(ctx.catalog, ctx.item, ctx.rng, ctx.action.omen ? colours => ['R', 'G', 'B'].every(c => colours.includes(c)) : () => true);
  }, { params: ['omen'] }),
  "Blacksmith's Whetstone": T(['quality.gain'], ctx => quality(ctx, cls => cls.startsWith('weapon'), 'weapon')),
  "Armourer's Scrap": T(['quality.gain'], ctx => quality(ctx, cls => cls === 'armour', 'armour')),
  ...Object.fromEntries(catalysts.map(name => [`${name} Catalyst`, T(['quality.gain', 'quality.catalyst'], ctx => catalyst(ctx, name.toLowerCase()))])),
  // Tainted currency (corrupted items only, rule tainted.model)
  'Tainted Chaos Orb': T(['tainted.model', 'strands.cut'], ctx => {
    const { catalog, item, rng } = ctx; requireThat(item.corrupted && item.rarity === 'rare' && !item.mirrored, 'Requires a corrupted rare');
    if (rng.int(2) === 0) reforge(catalog, item, rng, { respect_locks: false, pool: cutPool(ctx) });
    else { item.mods = item.mods.filter(roll => roll.fractured); lowestRarity(catalog, item); }
  }, { strands: 'tainted_chaos' }),
  'Tainted Exalted Orb': T(['tainted.model'], ctx => {
    const { catalog, item, rng } = ctx; requireThat(item.corrupted && item.rarity === 'rare' && !item.mirrored, 'Requires a corrupted rare');
    const canAdd = pool(catalog, item).rows.length > 0, canRemove = item.mods.some(roll => !roll.fractured);
    requireThat(canAdd || canRemove, 'Nothing to add or remove');
    if (canAdd && (!canRemove || rng.int(2) === 0)) addRandom(catalog, item, rng); else removeRandom(catalog, item, rng, { respect_locks: false });
  }),
  'Tainted Divine Teardrop': T(['tainted.model', 'tier.numbering'], ctx => {
    const { catalog, item, rng } = ctx; requireThat(item.corrupted && item.rarity === 'rare' && !item.mirrored, 'Requires a corrupted rare');
    item.mods = item.mods.map(roll => { if (roll.kind === 'crafted' || roll.fractured) return roll; const next = tierStep(catalog, item, roll, ctx.rng.int(3) - 1); return next ? makeRoll(next, rng, { kind: roll.kind }) : roll; });
  }),
  "Tainted Jeweller's Orb": T(['tainted.model'], ctx => {
    const { catalog, item, rng } = ctx; requireThat(item.corrupted && !item.mirrored, 'Requires a corrupted item');
    const n = item.sockets.colours.length, max = maxSockets(catalog, item), options = [n - 1, n + 1].filter(v => v >= 1 && v <= max);
    requireThat(options.length, 'No socket change possible'); setSocketCount(item, pickUniform(options, rng));
  }),
  'Tainted Orb of Fusing': T(['tainted.model'], ctx => {
    const { item, rng } = ctx; requireThat(item.corrupted && !item.mirrored && item.sockets.colours.length >= 2, 'Requires a corrupted socketed item');
    const largest = Math.max(...item.sockets.links), n = item.sockets.colours.length;
    const target = pickUniform([largest - 1, largest + 1].filter(v => v >= 1 && v <= n), rng);
    item.sockets.links = [target, ...Array(n - target).fill(1)];
  }),
  'Tainted Chromatic Orb': T(['tainted.model'], ctx => {
    requireThat(ctx.item.corrupted && !ctx.item.mirrored, 'Requires a corrupted item');
    chromatic(ctx.catalog, ctx.item, ctx.rng, () => true, false, { R: 1, G: 1, B: 1 });
  }),
  "Tainted Blacksmith's Whetstone": T(['tainted.model'], ctx => taintedQuality(ctx, 'weapon')),
  "Tainted Armourer's Scrap": T(['tainted.model'], ctx => taintedQuality(ctx, 'armour')),
  'Tainted Catalyst': T(['tainted.model'], ctx => {
    const { catalog, item, rng } = ctx; requireThat(item.corrupted && jewelleryClasses.includes(baseOf(catalog, item.base_id).item_class), 'Requires corrupted jewellery');
    item.quality_type = pickUniform(QUALITY_TYPES.slice(1, 11), rng); item.quality = 1 + rng.int(20);
  }),
  // Influence and Eldritch
  ...Object.fromEntries(Object.entries(influenceOrbs).map(([name, influence]) => [name, T(['influence.exalt', 'strands.cut'], ctx => {
    const { catalog, item, rng } = ctx; uncorrupted(ctx); equipment(catalog, item); rare(item);
    requireThat(item.item_level >= 68 && !item.influences.length && !item.synthesised && !fracturedCount(item) && !item.eldritch.exarch && !item.eldritch.eater, 'Invalid influence-orb target');
    influenceTag(catalog, baseOf(catalog, item.base_id), influence); item.influences.push(influence);
    addRandom(catalog, item, rng, cutPool(ctx, { influence }));
  }, { strands: exaltSpend })])),
  ...Object.fromEntries(Object.entries(implicitCurrencies).map(([name, spec]) => [name, T(['eldritch.implicits'], ctx => {
    const { catalog, item, rng } = ctx; uncorrupted(ctx); eldritchGate(catalog, item);
    const opposite = spec.side === 'exarch' ? 'eater' : 'exarch';
    item.implicits = item.implicits.filter(roll => roll.id === item.eldritch[opposite]?.id);
    const selected = eldritchImplicit(catalog, item, spec.side, spec.tier, rng);
    item.implicits.push(makeRoll(catalog.mods.get(selected.id), rng, { kind: 'eldritch' }));
    item.eldritch[spec.side] = { id: selected.id, tier: spec.tier };
  })])),
};
function drawTotal(catalog, item, rng) {
  const table = isJewel(catalog, item) ? ruleValue('count.jewel') : ruleValue('count.rare');
  return Math.min(capacity(catalog, item).total, pickWeighted(Object.entries(table).map(([n, weight]) => ({ n: Number(n), weight })), rng).n);
}
function quality(ctx, accept, label) {
  const { catalog, item, rng } = ctx; uncorrupted(ctx);
  const base = baseOf(catalog, item.base_id), cls = base.tags.includes('weapon') ? 'weapon' : base.tags.includes('armour') ? 'armour' : 'other';
  requireThat(accept(cls), `Requires a ${label}`);
  if (item.quality_type !== 'normal') { item.quality_type = 'normal'; item.quality = 0; }
  requireThat(item.quality < 20, 'Quality is already 20%');
  item.quality = Math.min(20, item.quality + qualityGain(item, rng));
}
function catalyst(ctx, type) {
  const { catalog, item, rng } = ctx; uncorrupted(ctx);
  requireThat(jewelleryClasses.includes(baseOf(catalog, item.base_id).item_class), 'Catalysts apply to rings, amulets and belts');
  if (item.quality_type !== type) { item.quality_type = type; item.quality = 0; }
  requireThat(item.quality < 20, 'Quality is already 20%');
  item.quality = Math.min(20, item.quality + qualityGain(item, rng));
}
function taintedQuality(ctx, cls) {
  const { catalog, item, rng } = ctx; requireThat(item.corrupted && !item.mirrored, 'Requires a corrupted item');
  const base = baseOf(catalog, item.base_id); requireThat(base.tags.includes(cls), `Requires a corrupted ${cls}`);
  item.quality_type = 'normal'; item.quality = 1 + rng.int(20);
}
export { socketClasses, valuesOf, sideOf, removable };
