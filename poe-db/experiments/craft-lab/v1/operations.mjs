import { baseOf, named, currencyName, influenceTag } from './catalog.mjs';
import { keys, integer } from '../engine.mjs';
import { requireThat, makeRoll, definition, capacity, count, meta, pool, addRandom, pickWeighted, protectedIds, removeRandom, lowestRarity, itemTags } from './state.mjs';

export const basicActions = Object.freeze(['Orb of Transmutation', 'Orb of Alteration', 'Orb of Augmentation', 'Regal Orb', 'Orb of Alchemy', 'Chaos Orb', 'Exalted Orb', 'Orb of Annulment', 'Orb of Scouring', 'Divine Orb', 'Blessed Orb', 'Fracturing Orb', 'Veiled Exalted Orb', 'Eldritch Exalted Orb', 'Eldritch Orb of Annulment', 'Eldritch Chaos Orb']);
export const influenceOrbs = Object.freeze({ "Shaper's Exalted Orb": 'Shaper', "Elder's Exalted Orb": 'Elder', "Crusader's Exalted Orb": 'Crusader', "Redeemer's Exalted Orb": 'Redeemer', "Hunter's Exalted Orb": 'Hunter', "Warlord's Exalted Orb": 'Warlord' });
const implicitCurrencies = Object.fromEntries(['Lesser', 'Greater', 'Grand', 'Exceptional'].flatMap((tier, i) => [[`${tier} Eldritch Ember`, { side: 'exarch', tier: i + 1 }], [`${tier} Eldritch Ichor`, { side: 'eater', tier: i + 1 }]]));
export const currencyActions = [...basicActions, ...Object.keys(influenceOrbs), ...Object.keys(implicitCurrencies)];

export function normalizeAction(input) {
  const action = typeof input === 'string' ? { type: 'currency', name: input } : structuredClone(input);
  const fields = {
    currency: ['type', 'name'], bench: ['type', 'recipe'], essence: ['type', 'essence'], fossils: ['type', 'fossils', 'resonator'],
    harvest: ['type', 'method', 'tag', 'cost'], beast: ['type', 'method', 'cost'], unveil: ['type'], choose_unveil: ['type', 'index'],
  };
  requireThat(action && Object.hasOwn(fields, action.type), `Unsupported action type: ${action?.type}`);
  keys(action, fields[action.type], 'action');
  if (action.type === 'currency') requireThat(currencyActions.includes(action.name), `Unimplemented currency: ${action.name}`);
  return action;
}
function mutable(item) { requireThat(!item.corrupted && !item.mirrored, 'This action requires an uncorrupted, unmirrored item'); }
function rare(item) { requireThat(item.rarity === 'rare', 'Requires rare rarity'); }
function equipment(catalog, item) { requireThat(baseOf(catalog, item.base_id).domain === 'item', 'Requires an equipment base'); }
function noBlockingMeta(catalog, item) {
  const m = meta(catalog, item);
  requireThat(!m.prefix && !m.suffix && !m.attack && !m.caster, 'Essence/Fossil application with blocking metamods is not admitted');
}
export function drawCount(catalog, item, rng) {
  const max = capacity(catalog, item);
  if (item.rarity === 'magic') return Math.min(max.total, 1 + rng.int(2));
  const base = baseOf(catalog, item.base_id);
  if (base.tags.some(tag => /nightmare/.test(tag))) return max.total;
  if (['jewel', 'abyss_jewel', 'affliction_jewel', 'heist_trinket'].includes(base.domain)) return Math.min(max.total, rng.int(100) < 65 ? 3 : 4);
  return Math.min(max.total, pickWeighted([{ number: 4, weight: 8 }, { number: 5, weight: 3 }, { number: 6, weight: 1 }], rng).number);
}
export function reforge(catalog, item, rng, options = {}) {
  const keep = protectedIds(catalog, item, rng, options.respect_locks !== false);
  item.mods = item.mods.filter(roll => keep.has(roll.id) || (options.keep_side && definition(catalog, roll).generation_type === options.keep_side));
  if (options.rarity) item.rarity = options.rarity;
  const targetCount = Math.max(item.mods.length, drawCount(catalog, item, rng));
  if (options.forced) for (const mod of options.forced) {
    const max = capacity(catalog, item), n = count(catalog, item);
    requireThat(n[mod.generation_type] < max[mod.generation_type] && item.mods.length < max.total, 'No slot for guaranteed modifier');
    requireThat(!item.mods.some(roll => definition(catalog, roll).groups.some(group => mod.groups.includes(group))), 'Guaranteed modifier conflicts with retained modifiers');
    item.mods.push(makeRoll(mod, rng, { kind: options.kind ?? 'essence' }));
  }
  if (options.tag) addRandom(catalog, item, rng, { ...options, respect_tags: true });
  while (item.mods.length < targetCount) {
    const candidates = pool(catalog, item, { ...options, tag: undefined, respect_tags: options.tag ? false : options.respect_tags });
    if (!candidates.rows.length) break;
    const choice = pickWeighted(candidates.rows, rng);
    item.mods.push(makeRoll(catalog.mods.get(choice.id), rng, { lucky: options.lucky ?? false }));
  }
  requireThat(item.mods.length > 0, 'No eligible modifiers for this base/context');
}
function costsObject(value) {
  keys(value, Object.keys(value ?? {}), 'resource cost');
  requireThat(Object.keys(value).length > 0, 'Explicit recipe resource cost is required');
  for (const [name, amount] of Object.entries(value)) requireThat(name.length > 0 && !Object.hasOwn(Object.prototype, name) && !['__proto__', 'prototype'].includes(name) && Number.isSafeInteger(amount) && amount > 0, 'Invalid resource cost');
  return value;
}
export function costOf(catalog, action) {
  if (action.type === 'currency') return { [action.name]: 1 };
  if (action.type === 'bench') {
    const recipe = catalog.recipes.get(String(action.recipe)); requireThat(recipe, 'Unknown bench recipe');
    return Object.fromEntries(Object.entries(recipe.cost).map(([id, amount]) => [currencyName(catalog, id), amount]));
  }
  if (action.type === 'essence') return { [named(catalog.essences, action.essence, 'essence').name]: 1 };
  if (action.type === 'fossils') {
    requireThat(Array.isArray(action.fossils) && action.fossils.length >= 1 && action.fossils.length <= 4, 'Use one to four fossils');
    const names = action.fossils.map(id => named(catalog.fossils, id, 'fossil').name);
    requireThat(new Set(names).size === names.length, 'A resonator cannot contain duplicate fossils');
    const size = ['Primitive', 'Potent', 'Powerful', 'Prime'][names.length - 1];
    const resonator = action.resonator ?? `${size} Chaotic Resonator`;
    requireThat(resonator === `${size} Chaotic Resonator` || resonator === `${size} Alchemical Resonator`, 'Resonator size must match fossil count');
    return { ...Object.fromEntries(names.map(name => [name, 1])), [resonator]: 1 };
  }
  if (action.type === 'beast' && action.method === 'restore_imprint') return {};
  if (action.type === 'harvest' || action.type === 'beast') return costsObject(action.cost);
  return {};
}
function bench(catalog, session, item, action, rng) {
  const recipe = catalog.recipes.get(String(action.recipe)); requireThat(recipe, 'Unknown bench recipe');
  requireThat(session.initial.unlocked_recipes === 'all_assumed' || session.initial.unlocked_recipes?.includes(recipe.id), `Recipe unlock is not established: ${recipe.id}`);
  const base = baseOf(catalog, item.base_id);
  requireThat(recipe.item_classes.includes(base.item_class), 'Bench recipe does not accept this item class');
  const fields = Object.entries(recipe.actions).filter(([, value]) => value !== null && value !== false);
  requireThat(fields.length === 1, 'Composite bench action needs a dedicated implementation');
  const [name, value] = fields[0];
  if (name === 'change_socket_count' || name === 'link_sockets') {
    requireThat(!item.mirrored, 'Mirrored sockets cannot be changed');
    requireThat(!item.corrupted, 'Corrupted bench costs/Vaal surcharge not implemented');
    if (name === 'change_socket_count') {
      requireThat(value <= maxSockets(catalog, item), 'Too many sockets for the base');
      throw new Error('Socket-count crafts need a verified socket/colour distribution; no colour is fabricated');
    } else {
      requireThat(item.sockets.colours.length >= value, 'Not enough sockets');
      item.sockets.links = [value, ...Array(item.sockets.colours.length - value).fill(1)];
    }
    return;
  }
  mutable(item);
  if (name === 'remove_crafted_mods') { item.mods = item.mods.filter(roll => roll.kind !== 'crafted' || roll.fractured); return; }
  if (name === 'remove_enchantments') { item.enchantments = []; return; }
  if (name === 'add_enchant_mod') { item.enchantments = [makeRoll(catalog.mods.get(value), rng, { kind: 'enchantment' })]; return; }
  requireThat(name === 'add_explicit_mod', `Unimplemented bench action: ${name}`);
  const mod = catalog.mods.get(value); requireThat(mod && ['prefix', 'suffix'].includes(mod.generation_type), 'Invalid bench modifier');
  requireThat(item.mods.filter(roll => roll.kind === 'crafted').length < meta(catalog, item).crafted_limit, 'Crafted modifier limit reached; remove existing crafts first');
  requireThat(!item.mods.some(roll => definition(catalog, roll).groups.some(group => mod.groups.includes(group))), 'Bench modifier conflicts with an existing group');
  const restrictions = meta(catalog, item);
  requireThat(!(restrictions.attack && mod.implicit_tags.includes('attack')) && !(restrictions.caster && mod.implicit_tags.includes('caster')), 'Bench modifier blocked by tag restriction');
  if (item.rarity === 'normal') item.rarity = 'magic';
  const max = capacity(catalog, item), n = count(catalog, item);
  requireThat(n[mod.generation_type] < max[mod.generation_type] && item.mods.length < max.total, 'No free affix for bench craft');
  item.mods.push(makeRoll(mod, rng, { kind: 'crafted' }));
}
export function maxSockets(catalog, item) {
  const base = baseOf(catalog, item.base_id), stats = new Map();
  for (const roll of item.implicits) definition(catalog, roll).stats.forEach((stat, i) => stats.set(stat.id, roll.values[i]));
  if (stats.has('local_has_X_sockets')) return stats.get('local_has_X_sockets');
  if (base.item_class === 'Body Armour' || ['Bow', 'Staff', 'Warstaff', 'Two Hand Axe', 'Two Hand Mace', 'Two Hand Sword'].includes(base.item_class)) return 6;
  if (['Boots', 'Gloves', 'Helmet'].includes(base.item_class)) return 4;
  return ['Claw', 'Dagger', 'Rune Dagger', 'One Hand Axe', 'One Hand Mace', 'One Hand Sword', 'Thrusting One Hand Sword', 'Sceptre', 'Wand', 'Shield'].includes(base.item_class) ? 3 : 0;
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
function eldritch(catalog, item, spec, rng) {
  const base = baseOf(catalog, item.base_id);
  requireThat(['Body Armour', 'Boots', 'Gloves', 'Helmet'].includes(base.item_class) && !item.influences.length && !item.synthesised, 'Invalid base or existing influence for Eldritch currency');
  requireThat(!meta(catalog, item).immutable_implicits, 'Implicit modifiers cannot be changed');
  const generation = spec.side === 'exarch' ? 'searing_exarch_implicit' : 'eater_of_worlds_implicit';
  const opposite = spec.side === 'exarch' ? 'eater' : 'exarch';
  item.implicits = item.implicits.filter(roll => roll.id === item.eldritch[opposite]?.id);
  const selected = pickWeighted(pool(catalog, item, { implicit: true, generation_type: generation, ignore_level: true, respect_tags: false, weight: mod => implicitTier(mod) === spec.tier ? 1 : 0 }).rows, rng);
  item.implicits.push(makeRoll(catalog.mods.get(selected.id), rng, { kind: 'eldritch' }));
  item.eldritch[spec.side] = { id: selected.id, tier: spec.tier };
}
function fossils(catalog, item, action, rng) {
  equipment(catalog, item); noBlockingMeta(catalog, item);
  const source = action.fossils.map(id => named(catalog.fossils, id, 'fossil'));
  const tags = itemTags(catalog, item);
  const forced = [];
  for (const fossil of source) {
    requireThat(fossil.name && catalog.allBases.get(fossil.id)?.release_state === 'released', 'Not an admitted fossil item');
    requireThat(!fossil.allowed_tags.length || fossil.allowed_tags.some(tag => tags.has(tag)), `Fossil is incompatible with this base: ${fossil.name}`);
    requireThat(!fossil.forbidden_tags.some(tag => tags.has(tag)), `Fossil forbids this base: ${fossil.name}`);
    requireThat(!fossil.added_mods.length && !fossil.rolls_lucky && !fossil.corrupted_essence_chance && !fossil.changes_quality && !fossil.mirrors && !fossil.rolls_white_sockets && !fossil.sell_price_mods.length && !['Fractured Fossil', 'Bloodstained Fossil', 'Glyphic Fossil'].includes(fossil.name), `Special fossil effect needs an independently verified 3.30 rule: ${fossil.name}`);
    for (const id of fossil.forced_mods) forced.push(catalog.mods.get(id));
  }
  const resonator = action.resonator ?? `${['Primitive', 'Potent', 'Powerful', 'Prime'][source.length - 1]} Chaotic Resonator`;
  requireThat(resonator.includes('Alchemical') ? item.rarity === 'normal' : item.rarity === 'rare', 'Resonator rarity mismatch');
  reforge(catalog, item, rng, { rarity: 'rare', respect_locks: false, respect_tags: false, forced, kind: 'fossil', weight: mod => {
    let positive = 0, negative = 1;
    const modTags = new Set(mod.implicit_tags);
    for (const fossil of source) {
      positive += fossil.positive_mod_weights.find(row => modTags.has(row.tag))?.weight ?? 0;
      const reduction = fossil.negative_mod_weights.find(row => modTags.has(row.tag));
      if (reduction) negative *= reduction.weight / 100;
    }
    return (positive ? positive / 100 : 1) * negative;
  } });
}
function harvest(catalog, item, action, rng) {
  equipment(catalog, item); rare(item);
  requireThat(['reforge', 'augment', 'reforge_keep_prefixes', 'reforge_keep_suffixes'].includes(action.method), `Unimplemented Harvest method: ${action.method}`);
  if (action.method.startsWith('reforge_keep')) throw new Error('Historical keep-prefix/suffix Harvest availability is not established for 3.30');
  requireThat(typeof action.tag === 'string' && [...catalog.mods.values()].some(mod => mod.implicit_tags.includes(action.tag)), 'Unknown Harvest tag');
  if (action.method === 'reforge') reforge(catalog, item, rng, { tag: action.tag });
  else {
    requireThat(!item.influences.length, 'Harvest augment requires a non-influenced item');
    // Choose a new mod from the original open slot/group context, then remove an old mod.
    const chosen = pickWeighted(pool(catalog, item, { tag: action.tag }).rows, rng);
    removeRandom(catalog, item, rng); item.mods.push(makeRoll(catalog.mods.get(chosen.id), rng));
  }
}
function beast(catalog, session, item, action, rng) {
  equipment(catalog, item);
  if (action.method === 'imprint') {
    requireThat(item.rarity === 'magic' && !item.mods.some(roll => roll.fractured), 'Imprint requires an unfractured magic item');
    session.imprint = structuredClone(item); return;
  }
  if (action.method === 'restore_imprint') {
    requireThat(session.imprint && session.imprint.base_id === item.base_id && !item.split, 'No compatible imprint or item was split');
    session.item = structuredClone(session.imprint); session.imprint = null; return;
  }
  if (action.method === 'prefix_to_suffix' || action.method === 'suffix_to_prefix') {
    rare(item);
    const removeSide = action.method === 'prefix_to_suffix' ? 'prefix' : 'suffix', addSide = removeSide === 'prefix' ? 'suffix' : 'prefix';
    // Beast level is not silently substituted for item level; this variant only admits an explicit equal level contract.
    throw new Error('Beast add/remove requires a source-verified beast-level rule; item level cannot be substituted');
  }
  throw new Error(`Unimplemented beastcraft: ${action.method}`);
}
function unveil(catalog, session, item, action, rng) {
  if (action.type === 'choose_unveil') {
    requireThat(session.offers !== null, 'No unveil offers');
    integer(action.index, 0, session.offers.ids.length - 1, 'unveil choice');
    const id = session.offers.ids[action.index], placeholder = session.offers.placeholder;
    item.mods = item.mods.filter(roll => roll.id !== placeholder);
    item.mods.push(makeRoll(catalog.mods.get(id), rng, { kind: 'unveiled' })); session.offers = null; return;
  }
  const placeholders = item.mods.filter(roll => roll.kind === 'veiled');
  requireThat(placeholders.length === 1 && session.offers === null, 'Requires exactly one veiled modifier and no pending offers');
  const placeholder = placeholders[0], side = definition(catalog, placeholder).generation_type;
  const shadow = structuredClone(item); shadow.mods = shadow.mods.filter(roll => roll.id !== placeholder.id);
  const offers = [], excludedGroups = [];
  for (let i = 0; i < 3; i++) {
    const rows = pool(catalog, shadow, { domain: 'unveiled', side, respect_tags: false, excluded_ids: offers, excluded_groups: excludedGroups }).rows;
    if (!rows.length) break;
    const chosen = pickWeighted(rows, rng); offers.push(chosen.id);
    excludedGroups.push(...catalog.mods.get(chosen.id).groups);
  }
  requireThat(offers.length > 0, 'No eligible unveil outcomes in the pinned source');
  session.offers = { placeholder: placeholder.id, ids: offers };
}

export function apply(catalog, session, action, rng) {
  const item = session.item;
  requireThat(!session.offers || action.type === 'choose_unveil', 'Choose an unveiled modifier before another action');
  if (action.type === 'bench') return bench(catalog, session, item, action, rng);
  mutable(item);
  if (action.type === 'essence') {
    equipment(catalog, item); noBlockingMeta(catalog, item);
    const essence = named(catalog.essences, action.essence, 'essence');
    requireThat(item.rarity === 'normal' || (item.rarity === 'rare' && essence.level >= 5), 'Essence rarity/tier mismatch');
    const id = essence.mods?.[baseOf(catalog, item.base_id).item_class]; requireThat(id, 'Essence has no modifier for this class');
    return reforge(catalog, item, rng, { rarity: 'rare', respect_locks: false, respect_tags: false, item_level: Math.min(item.item_level, essence.item_level_restriction ?? 100), forced: [catalog.mods.get(id)], kind: 'essence' });
  }
  if (action.type === 'fossils') return fossils(catalog, item, action, rng);
  if (action.type === 'harvest') return harvest(catalog, item, action, rng);
  if (action.type === 'beast') return beast(catalog, session, item, action, rng);
  if (action.type === 'unveil' || action.type === 'choose_unveil') return unveil(catalog, session, item, action, rng);
  const name = action.name;
  if (implicitCurrencies[name]) return eldritch(catalog, item, implicitCurrencies[name], rng);
  if (influenceOrbs[name]) {
    equipment(catalog, item); rare(item);
    requireThat(item.item_level >= 68 && !item.influences.length && !item.synthesised && !item.mods.some(roll => roll.fractured) && !item.eldritch.exarch && !item.eldritch.eater, 'Invalid influence-orb target');
    const influence = influenceOrbs[name]; influenceTag(catalog, baseOf(catalog, item.base_id), influence); item.influences.push(influence);
    return addRandom(catalog, item, rng, { influence });
  }
  if (name === 'Orb of Transmutation') {
    requireThat(item.rarity === 'normal', 'Transmutation requires normal rarity'); return reforge(catalog, item, rng, { rarity: 'magic' });
  }
  if (name === 'Orb of Alteration') { requireThat(item.rarity === 'magic', 'Alteration requires magic rarity'); return reforge(catalog, item, rng); }
  if (name === 'Orb of Alchemy') { requireThat(item.rarity === 'normal', 'Alchemy requires normal rarity'); return reforge(catalog, item, rng, { rarity: 'rare' }); }
  if (name === 'Chaos Orb') { rare(item); return reforge(catalog, item, rng); }
  if (name === 'Orb of Augmentation') { requireThat(item.rarity === 'magic', 'Augmentation requires magic rarity'); return addRandom(catalog, item, rng); }
  if (name === 'Regal Orb') { requireThat(item.rarity === 'magic', 'Regal requires magic rarity'); item.rarity = 'rare'; return addRandom(catalog, item, rng); }
  if (name === 'Exalted Orb') { rare(item); return addRandom(catalog, item, rng); }
  if (name === 'Orb of Annulment') { requireThat(item.rarity !== 'normal', 'Annulment requires magic/rare rarity'); return removeRandom(catalog, item, rng); }
  if (name === 'Orb of Scouring') {
    requireThat(item.rarity !== 'normal', 'Scouring requires magic/rare rarity');
    const keep = protectedIds(catalog, item, rng); item.mods = item.mods.filter(roll => keep.has(roll.id)); lowestRarity(catalog, item); return;
  }
  if (name === 'Divine Orb' || name === 'Blessed Orb') {
    const field = name === 'Divine Orb' ? 'mods' : 'implicits';
    requireThat(field !== 'implicits' || !meta(catalog, item).immutable_implicits, 'Implicit modifiers cannot be changed');
    const keep = field === 'mods' ? protectedIds(catalog, item, rng) : new Set();
    requireThat(item[field].some(roll => !keep.has(roll.id) && definition(catalog, roll).stats.some(stat => stat.min !== stat.max)), 'No modifiable numeric ranges');
    item[field] = item[field].map(roll => keep.has(roll.id) ? roll : makeRoll(definition(catalog, roll), rng, { kind: roll.kind, fractured: roll.fractured })); return;
  }
  if (name === 'Fracturing Orb') {
    equipment(catalog, item); rare(item);
    requireThat(item.mods.length >= 4 && !item.influences.length && !item.synthesised && !item.mods.some(roll => roll.fractured), 'Invalid Fracturing Orb target');
    item.mods[rng.int(item.mods.length)].fractured = true; return;
  }
  if (name === 'Veiled Exalted Orb') {
    equipment(catalog, item); rare(item);
    requireThat(!item.mods.some(roll => ['veiled', 'unveiled'].includes(roll.kind)), 'Item already has a veiled/unveiled modifier');
    removeRandom(catalog, item, rng);
    const max = capacity(catalog, item), n = count(catalog, item), sides = ['prefix', 'suffix'].filter(side => n[side] < max[side]);
    requireThat(sides.length, 'No room for a veiled modifier');
    const side = sides[rng.int(sides.length)]; item.mods.push(makeRoll(catalog.mods.get(side === 'prefix' ? 'VeiledPrefix' : 'VeiledSuffix'), rng, { kind: 'veiled' })); return;
  }
  if (name.startsWith('Eldritch ')) {
    equipment(catalog, item); rare(item); const side = eldritchSide(item);
    if (name === 'Eldritch Exalted Orb') return addRandom(catalog, item, rng, { side });
    if (name === 'Eldritch Orb of Annulment') return removeRandom(catalog, item, rng, { side, respect_locks: false });
    if (name === 'Eldritch Chaos Orb') return reforge(catalog, item, rng, { keep_side: side === 'prefix' ? 'suffix' : 'prefix', respect_locks: false, side });
  }
  throw new Error(`Unimplemented action: ${name}`);
}
