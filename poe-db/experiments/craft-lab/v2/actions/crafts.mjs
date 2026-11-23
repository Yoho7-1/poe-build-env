// Bench, Essence, Fossil, Harvest, Bestiary and unveil crafts.
import { baseOf, named, currencyName, armourClasses } from '../catalog.mjs';
import { keys, integer, firstWeight } from '../../engine.mjs';
import { requireThat, definition, sideOf, capacity, count, meta, makeRoll, itemTags, mutable, equipment, rare, hasBlockingMeta, fracturedCount, isJewel } from '../item.mjs';
import { pool, addRandom, pickWeighted, pickUniform, protectedIds, removable, removeRandom, reforge, tierInfo, influenceModOf } from '../draw.mjs';
import { maxSockets, setSocketCount, chromatic } from '../sockets.mjs';
import { addCorruptedImplicits } from './basic.mjs';
import { rule, ruleValue } from '../rules.mjs';

const cut = item => item.memory_strands > 0 ? 'strands' : null;
const ELEMENTS = ['fire', 'cold', 'lightning'];
const LIFEFORCE = ['Wild Crystallised Lifeforce', 'Vivid Crystallised Lifeforce', 'Primal Crystallised Lifeforce', 'Sacred Crystallised Lifeforce'];
export function explicitCost(value, label = 'resource cost') {
  keys(value, Object.keys(value ?? {}), label);
  requireThat(Object.keys(value).length > 0, `Explicit ${label} is required`);
  for (const [name, amount] of Object.entries(value)) requireThat(name.length > 0 && name.length <= 120 && !['__proto__', 'prototype', 'constructor'].includes(name) && Number.isSafeInteger(amount) && amount > 0, `Invalid ${label}`);
  return value;
}

// ---------------- Bench
export function benchCost(catalog, action, item) {
  const recipe = catalog.recipes.get(String(action.recipe)); requireThat(recipe, 'Unknown bench recipe');
  const cost = Object.fromEntries(Object.entries(recipe.cost).map(([id, amount]) => [currencyName(catalog, id), amount]));
  const socketCraft = ['change_socket_count', 'link_sockets', 'color_sockets'].some(name => recipe.actions[name]);
  if (socketCraft && item?.corrupted) cost['Vaal Orb'] = (cost['Vaal Orb'] ?? 0) + Object.values(recipe.cost).reduce((a, b) => a + b, 0);
  return cost;
}
export function bench(ctx) {
  const { catalog, session, item, action, rng } = ctx;
  const recipe = catalog.recipes.get(String(action.recipe)); requireThat(recipe, 'Unknown bench recipe');
  requireThat(session.initial.unlocked_recipes === 'all_assumed' || session.initial.unlocked_recipes?.includes(recipe.id), `Recipe unlock is not established: ${recipe.id}`);
  const base = baseOf(catalog, item.base_id);
  requireThat(recipe.item_classes.includes(base.item_class), 'Bench recipe does not accept this item class');
  const fields = Object.entries(recipe.actions).filter(([, value]) => value !== null && value !== false);
  requireThat(fields.length === 1, 'Composite bench action needs a dedicated implementation');
  const [name, value] = fields[0];
  requireThat(!item.mirrored, 'Mirrored items cannot be modified');
  if (['change_socket_count', 'link_sockets', 'color_sockets'].includes(name)) {
    if (name === 'change_socket_count') { requireThat(value <= maxSockets(catalog, item, { ignoreLevel: true }) && value !== item.sockets.colours.length, 'Socket count not allowed or unchanged'); setSocketCount(item, value); }
    else if (name === 'link_sockets') { requireThat(item.sockets.colours.length >= value, 'Not enough sockets'); item.sockets.links = [value, ...Array(item.sockets.colours.length - value).fill(1)]; }
    else if (value === 'w') { requireThat(item.sockets.colours.length > 0, 'No sockets'); item.sockets.colours = item.sockets.colours.map(c => ['A', 'D'].includes(c) ? c : 'W'); ctx.used.push('bench.white_sockets_330'); }
    else { const k = value.length; requireThat(item.sockets.colours.filter(c => !['A', 'D'].includes(c)).length >= k, 'Not enough sockets'); chromatic(catalog, item, rng, colours => colours.filter(c => ['R', 'G', 'B'].includes(c)).length >= k, false); }
    ctx.used.push('bench.sockets'); return;
  }
  mutable(catalog, item);
  if (name === 'remove_crafted_mods') { requireThat(item.mods.some(roll => roll.kind === 'crafted' && !roll.fractured), 'No crafted modifier'); item.mods = item.mods.filter(roll => roll.kind !== 'crafted' || roll.fractured); ctx.used.push('bench.remove_crafted'); return; }
  if (name === 'remove_enchantments') { item.enchantments = []; return; }
  if (name === 'add_enchant_mod') { item.enchantments = [makeRoll(catalog.mods.get(value), rng, { kind: 'enchantment' })]; return; }
  if (name === 'reroll_rarity') {
    ctx.used.push('bench.reroll_rarity', 'bench.chance_cost_conflict');
    requireThat(action.assume, 'Rarity reroll has unpublished 3.30 odds; pass assume: {normal, magic, rare, unique}');
    const rows = ['normal', 'magic', 'rare', 'unique'].map(name => ({ name, weight: action.assume[name] ?? 0 }));
    requireThat(rows.some(row => row.weight > 0) && Object.keys(action.assume).every(key => rows.some(row => row.name === key)), 'Invalid outcome assumption');
    const outcome = pickWeighted(rows, rng).name;
    if (outcome === 'unique') { session.status = 'unique_outcome'; return; }
    item.mods = item.mods.filter(roll => roll.fractured); item.rarity = outcome;
    if (outcome !== 'normal') reforge(catalog, item, rng, { rarity: outcome, pool: { cut: cut(item) } });
    return;
  }
  if (name === 'reroll_rare_mods') {
    ctx.used.push('bench.reroll_rare_mods'); rare(item);
    for (let i = 0; i < value; i++) { if (!removable(catalog, item, rng, { respect_tags: true }).length) break; removeRandom(catalog, item, rng, { respect_tags: true }); }
    for (let i = 0; i < value; i++) { const rows = pool(catalog, item, { cut: cut(item) }).rows; if (!rows.length) break; addRandom(catalog, item, rng, { cut: cut(item) }); }
    return;
  }
  requireThat(name === 'add_explicit_mod', `Unimplemented bench action: ${name}`);
  ctx.used.push('bench.fixed_mod', 'bench.one_crafted');
  const mod = catalog.mods.get(value); requireThat(mod && ['prefix', 'suffix'].includes(mod.generation_type), 'Invalid bench modifier');
  if (/CannotChange|CannotRoll|MultipleCrafted/.test(mod.id)) ctx.used.push('meta.recipes_330', /One|Two/.test(mod.id) ? 'meta.counted_lock_330' : 'meta.full_lock_cost_330');
  requireThat(item.mods.filter(roll => roll.kind === 'crafted').length < meta(catalog, item).crafted_limit, 'Crafted modifier limit reached; remove existing crafts first');
  requireThat(!item.mods.some(roll => definition(catalog, roll).groups.some(group => mod.groups.includes(group))), 'Bench modifier conflicts with an existing group');
  const restrictions = meta(catalog, item);
  requireThat(!(restrictions.attack && mod.implicit_tags.includes('attack')) && !(restrictions.caster && mod.implicit_tags.includes('caster')), 'Bench modifier blocked by tag restriction');
  if (item.rarity === 'normal') item.rarity = 'magic';
  const max = capacity(catalog, item), n = count(catalog, item);
  requireThat(n[mod.generation_type] < max[mod.generation_type] && item.mods.length < max.total, 'No free affix for bench craft');
  item.mods.push(makeRoll(mod, rng, { kind: 'crafted' }));
}

// ---------------- Essence
export function essenceMod(catalog, essence, base) {
  const mapping = ruleValue('essence.class_mod');
  return essence.mods?.[base.item_class] ?? essence.mods?.[mapping[base.item_class]] ?? null;
}
export function essence(ctx) {
  const { catalog, item, action, rng } = ctx;
  mutable(catalog, item); equipment(catalog, item);
  requireThat(!hasBlockingMeta(catalog, item), 'Essences are refused on items with lock or Attack/Caster metamods');
  const record = named(catalog.essences, action.essence, 'essence');
  const id = essenceMod(catalog, record, baseOf(catalog, item.base_id)); requireThat(id, 'Essence has no modifier for this class');
  const rareOk = record.type?.is_corruption_only || record.level >= 5;
  requireThat(item.rarity === 'normal' || (item.rarity === 'rare' && rareOk), 'Essence rarity/tier mismatch');
  const forced = catalog.mods.get(id);
  requireThat(!item.mods.some(roll => roll.fractured && definition(catalog, roll).groups.some(group => forced.groups.includes(group))), 'Forced essence mod clashes with a fractured mod');
  if (record.name === 'Essence of Desolation' || record.name === 'Essence of Trickery') ctx.used.push('essence.desolation_330');
  reforge(catalog, item, rng, { rarity: 'rare', respect_locks: false, forced: [forced], forced_kind: 'essence',
    pool: { item_level: Math.min(item.item_level, record.item_level_restriction ?? 100), respect_tags: false, cut: cut(item) } });
}

// ---------------- Fossils
const fossilByName = (catalog, value) => named(catalog.fossils, value, 'fossil');
export function fossilCost(catalog, action) {
  requireThat(Array.isArray(action.fossils) && action.fossils.length >= 1 && action.fossils.length <= 4, 'Use one to four fossils');
  const names = action.fossils.map(id => fossilByName(catalog, id).name);
  requireThat(new Set(names).size === names.length && names.every(Boolean), 'A resonator holds distinct named fossils');
  const size = ['Primitive', 'Potent', 'Powerful', 'Prime'][names.length - 1];
  const resonator = action.resonator ?? `${size} Chaotic Resonator`;
  requireThat(resonator === `${size} Chaotic Resonator` || resonator === `${size} Alchemical Resonator`, 'Resonator size must match fossil count');
  return { ...Object.fromEntries(names.map(name => [name, 1])), [resonator]: 1 };
}
export function fossilWeight(fossils, mod) {
  const tags = new Set(mod.implicit_tags);
  if (fossils.some(f => f.negative_mod_weights.some(row => row.weight === 0 && tags.has(row.tag)))) return 0;
  if (fossils.some(f => f.name === 'Opulent Fossil') && tags.size === 0) return 0;
  const bypass = ruleValue('fossil.corroded_bypass'), covered = new Set();
  for (const [hybrid, cover] of Object.entries(bypass)) if (tags.has(hybrid) && fossils.some(f => f.positive_mod_weights.some(row => row.tag === hybrid))) cover.forEach(tag => covered.add(tag));
  let positive = 0, negative = 1;
  for (const fossil of fossils) {
    for (const row of fossil.positive_mod_weights) if (tags.has(row.tag) && !(covered.has(row.tag) && !bypass[row.tag])) positive += row.weight / 100;
    for (const row of fossil.negative_mod_weights) if (tags.has(row.tag) && row.weight > 0 && !covered.has(row.tag)) negative *= row.weight / 100;
  }
  return (positive > 0 ? positive : 1) * negative;
}
export function fossils(ctx) {
  const { catalog, item, action, rng, session } = ctx;
  mutable(catalog, item);
  requireThat(['item', 'jewel', 'abyss_jewel'].includes(baseOf(catalog, item.base_id).domain), 'Resonators work on equipment and jewels');
  requireThat(!hasBlockingMeta(catalog, item), 'Resonators are refused on items with lock or Attack/Caster metamods');
  let source = action.fossils.map(id => fossilByName(catalog, id));
  const tags = itemTags(catalog, item), names = new Set(source.map(f => f.name));
  for (const fossil of source) {
    requireThat(catalog.allBases.get(fossil.id)?.release_state === 'released', `Not an admitted fossil item: ${fossil.name}`);
    requireThat(!fossil.allowed_tags.length || fossil.allowed_tags.some(tag => tags.has(tag)), `Fossil is incompatible with this base: ${fossil.name}`);
    requireThat(!fossil.forbidden_tags.some(tag => tags.has(tag)), `Fossil forbids this base: ${fossil.name}`);
  }
  const resonator = fossilCost(catalog, action) && (action.resonator ?? 'Chaotic');
  requireThat(resonator.includes('Alchemical') ? item.rarity === 'normal' : item.rarity === 'rare', 'Resonator rarity mismatch');
  if (names.has('Fractured Fossil')) requireThat(!fracturedCount(item) && !item.influences.length, 'Fractured Fossil is refused on fractured or influenced items');
  if (names.has('Tangled Fossil')) {
    const outcomes = [...catalog.fossils.values()].filter(f => /RandomFossilOutcome/.test(f.id));
    source = [...source.filter(f => f.name !== 'Tangled Fossil'), pickUniform(outcomes, rng)]; ctx.used.push('fossil.tangled');
  }
  const forced = source.flatMap(f => f.name === 'Tangled Fossil' ? [] : f.forced_mods).map(id => catalog.mods.get(id));
  if (names.has('Glyphic Fossil')) {
    const base = baseOf(catalog, item.base_id), fractured = item.mods.filter(roll => roll.fractured).flatMap(roll => definition(catalog, roll).groups);
    const rows = [...catalog.essences.values()].filter(e => ['Essence of Hysteria', 'Essence of Insanity', 'Essence of Horror', 'Essence of Delirium'].includes(e.name))
      .map(e => essenceMod(catalog, e, base)).filter(Boolean).map(id => catalog.mods.get(id)).filter(mod => !mod.groups.some(g => fractured.includes(g)))
      .map(mod => ({ id: mod.id, weight: ruleValue('fossil.glyphic') * fossilWeight(source, mod) })).filter(row => row.weight > 0);
    requireThat(rows.length, 'Glyphic Fossil has no admissible corrupted-essence mod'); forced.push(catalog.mods.get(pickWeighted(rows, rng).id)); ctx.used.push('fossil.glyphic');
  }
  const added = source.filter(f => f.name !== 'Tangled Fossil' && !/RandomFossilOutcome/.test(f.id)).flatMap(f => f.name === 'Faceted Fossil' ? f.added_mods : []);
  const sanctified = names.has('Sanctified Fossil');
  if (sanctified) ctx.used.push('fossil.sanctified'); if (added.length) ctx.used.push('fossil.faceted'); if (forced.length) ctx.used.push('fossil.forced');
  reforge(catalog, item, rng, { rarity: 'rare', respect_locks: false, forced, forced_kind: 'fossil', kind: 'natural', lucky: sanctified,
    pool: { respect_tags: false, added_mods: added, weight: mod => fossilWeight(source, mod) * (sanctified ? 1 + (mod.required_level - ruleValue('fossil.sanctified')) / 100 : 1) } });
  if (names.has('Fractured Fossil')) { pickUniform(item.mods, rng).fractured = true; ctx.used.push('fossil.fractured'); }
  // Bloodstained + Gilded: the corrupted implicit replaces every implicit (rule fossil.bloodstained); Gilded alone adds a sell-price implicit.
  if (names.has('Bloodstained Fossil')) {
    if (names.has('Gilded Fossil')) item.implicits = [];
    for (const side of ['exarch', 'eater']) if (!item.implicits.some(r => r.id === item.eldritch[side]?.id)) item.eldritch[side] = null;
    item.corrupted = true; addCorruptedImplicits(catalog, item, rng, 1); ctx.used.push('fossil.bloodstained');
  } else if (names.has('Gilded Fossil')) {
    const sell = source.find(f => f.name === 'Gilded Fossil').sell_price_mods.map(id => catalog.mods.get(id)).filter(Boolean);
    item.implicits.push(makeRoll(pickUniform(sell, rng), rng, { kind: 'sell' })); ctx.used.push('fossil.gilded');
  }
  void session;
}

// ---------------- Harvest
const tagExists = (catalog, tag) => catalog.tags.has(tag);
export function harvestCost(catalog, action) {
  if (action.method === 'reforge') return { ...requireTag(ruleValue('harvest.tagged_cost'), action.tag) };
  if (action.method === 'augment') return { ...requireTag(ruleValue('harvest.augment'), action.tag), 'Sacred Crystallised Lifeforce': 1 };
  if (action.method === 'more_likely' || action.method === 'less_likely') return { ...ruleValue('harvest.likelihood').cost };
  if (action.method === 'influence_reforge') return { ...ruleValue('harvest.influence_reforge') };
  if (action.method === 'swap') {
    const cost = explicitCost(action.cost, 'Harvest swap cost (3.30: 300 of two lifeforce types)');
    const life = Object.entries(cost).filter(([name]) => LIFEFORCE.includes(name));
    requireThat(life.length === 2 && life.every(([, n]) => n === 300) && (action.kind === 'damage') === (cost['Crystallised Rancour'] === 1) && Object.keys(cost).length === life.length + (action.kind === 'damage' ? 1 : 0), 'Swap cost must be 300 of two lifeforce types (+1 Crystallised Rancour for damage swaps)');
    return cost;
  }
  throw new Error(`Unknown Harvest method: ${action.method}`);
}
function requireTag(table, tag) { requireThat(Object.hasOwn(table, tag), `No Harvest craft for tag: ${tag}`); return table[tag]; }
export function harvest(ctx) {
  const { catalog, item, action, rng } = ctx;
  mutable(catalog, item); equipment(catalog, item);
  const m = action.method;
  if (m === 'reforge') {
    rare(item); requireThat(tagExists(catalog, action.tag), 'Unknown tag'); ctx.used.push('harvest.tagged_reforge', 'harvest.tagged_cost', 'harvest.meta_first_mod', 'harvest.no_strands');
    return reforge(catalog, item, rng, { first: { tag: action.tag, respect_tags: true }, pool: { respect_tags: false } });
  }
  if (m === 'influence_reforge') {
    rare(item); requireThat(item.influences.length, 'Influence reforge needs an influenced item'); ctx.used.push('harvest.influence_reforge');
    return reforge(catalog, item, rng, { first: { influenced_only: true, respect_tags: true }, pool: { respect_tags: false } });
  }
  if (m === 'more_likely' || m === 'less_likely') {
    rare(item); const { factor, floor } = ruleValue('harvest.likelihood'); ctx.used.push('harvest.likelihood');
    const families = new Set(item.mods.flatMap(roll => definition(catalog, roll).groups)), total = Math.min(capacity(catalog, item).total, Math.max(floor, item.mods.length));
    return reforge(catalog, item, rng, { count: total, pool: { respect_tags: false, weight: mod => mod.groups.some(g => families.has(g)) ? (m === 'more_likely' ? factor : 1 / factor) : 1 } });
  }
  if (m === 'augment') {
    requireThat(item.rarity !== 'normal' && !item.influences.length, 'Augment craft needs a magic/rare non-influenced item'); ctx.used.push('harvest.augment');
    const roll = addRandom(catalog, item, rng, { tag: action.tag, respect_tags: true });
    requireThat(removable(catalog, item, rng, { exclude: [roll.id] }).length, 'Nothing removable after the addition');
    removeRandom(catalog, item, rng, { exclude: [roll.id], respect_tags: false }); return;
  }
  if (m === 'swap') {
    requireThat(ELEMENTS.includes(action.from) && ELEMENTS.includes(action.to) && action.from !== action.to && ['resistance', 'damage'].includes(action.kind), 'Swap needs kind resistance|damage and two different elements');
    ctx.used.push('harvest.swap', 'harvest.swap_cost_330');
    const keep = protectedIds(catalog, item, rng), patterns = action.kind === 'resistance' ? ['base_X_damage_resistance_%', 'base_maximum_X_damage_resistance_%'] : ['X_damage_+%', 'local_minimum_added_X_damage', 'spell_minimum_added_X_damage', 'attack_minimum_added_X_damage'];
    const tags = itemTags(catalog, item), sources = [];
    for (const roll of item.mods) {
      const mod = definition(catalog, roll);
      if (roll.fractured || roll.kind === 'crafted' || keep.has(roll.id) || !mod.stats.some(stat => patterns.some(p => stat.id === p.replace('X', action.from)))) continue;
      if (action.kind === 'damage' && mod.stats.some(stat => /critical_strike_multiplier/.test(stat.id))) continue;
      const wanted = mod.stats.map(stat => stat.id.replaceAll(action.from, action.to)).sort().join('|');
      const info = tierInfo(catalog, item, mod, tags, 100);
      const targets = [...catalog.candidates.get(mod.domain + ':' + mod.generation_type)].filter(t => t.stats.map(s => s.id).sort().join('|') === wanted && firstWeight(t.spawn_weights, tags, 0) > 0);
      const target = targets.find(t => tierInfo(catalog, item, t, tags, 100).tier === info.tier);
      if (!target || target.required_level > item.item_level) continue;
      if (item.mods.some(other => other !== roll && definition(catalog, other).groups.some(g => target.groups.includes(g)))) continue;
      sources.push([roll, target]);
    }
    requireThat(sources.length, 'No modifier qualifies as a swap source');
    const [roll, target] = pickUniform(sources, rng); item.mods[item.mods.indexOf(roll)] = makeRoll(target, rng, { kind: roll.kind }); return;
  }
  throw new Error(`Unknown Harvest method: ${m}`);
}

// ---------------- Bestiary
const BEASTS = { imprint: { 'Craicic Croaker': 1 }, talisman_imprint: { 'Fenumal Plagued Arachnid': 1 }, add_prefix_remove_suffix: { 'Farric Wolf Alpha': 1 }, add_suffix_remove_prefix: { 'Farric Lynx Alpha': 1 },
  metamod: { 'Wild Bristle Matron': 1 }, max_sockets: { 'The Black Mórrígan': 1, 'Craicic Shield Crab': 1 }, max_links: { 'The Black Mórrígan': 1, 'Craicic Sand Spitter': 1 } };
const ASPECTS = { cat: 'Farrul, First of the Plains', bird: 'Saqawal, First of the Sky', spider: 'Fenumus, First of the Night', crab: 'Craiceann, First of the Deep' };
const INFLUENCE_BEASTS = { Shaper: 'Fenumal Devourer', Elder: 'Saqawine Blood Viper', Crusader: 'Farric Goliath', Hunter: 'Craicic Watcher', Redeemer: 'Fenumal Queen', Warlord: 'Fenumal Scrabbler' };
export function beastCost(action) {
  if (action.method === 'restore_imprint') return {};
  if (BEASTS[action.method]) return { ...BEASTS[action.method] };
  if (action.method === 'aspect') { requireThat(ASPECTS[action.aspect] && [20, 30].includes(action.level ?? 20), 'Aspect needs cat|bird|spider|crab and level 20|30'); return { [ASPECTS[action.aspect]]: 1, ...((action.level ?? 20) === 30 ? { 'The Black Mórrígan': 1 } : {}) }; }
  if (action.method === 'talisman_fracture') return { 'Craicic Chimeral': action.count === 2 ? 2 : 1 };
  if (action.method === 'influence') { requireThat(INFLUENCE_BEASTS[action.influence], 'Unknown influence'); return { [INFLUENCE_BEASTS[action.influence]]: 1, 'Craicic Maw': 1 }; }
  throw new Error(`Unknown beastcraft: ${action.method}`);
}
function metamodRecipeMod(catalog, item, stat) {
  const cls = baseOf(catalog, item.base_id).item_class;
  const recipe = [...catalog.recipes.values()].find(r => r.item_classes.includes(cls) && r.actions.add_explicit_mod && catalog.mods.get(r.actions.add_explicit_mod)?.stats.some(s => s.id === stat));
  return recipe ? catalog.mods.get(recipe.actions.add_explicit_mod) : null;
}
export function beast(ctx) {
  const { catalog, session, item, action, rng } = ctx;
  const m = action.method;
  if (m === 'restore_imprint') {
    requireThat(session.imprint && session.imprint.base_id === item.base_id && !item.split && !fracturedCount(item) && !item.corrupted && !item.mirrored, 'No compatible imprint, or the item is fractured/split/corrupted/mirrored');
    session.item = structuredClone(session.imprint); session.imprint = null; ctx.used.push('beast.imprint'); return;
  }
  mutable(catalog, item); equipment(catalog, item); ctx.used.push('beast.no_yellow_330');
  const base = baseOf(catalog, item.base_id), talisman = base.tags.includes('talisman');
  if (m === 'imprint' || m === 'talisman_imprint') {
    requireThat(m === 'imprint' ? item.rarity === 'magic' : item.rarity === 'rare' && talisman, m === 'imprint' ? 'Imprint needs a magic item' : 'Talisman imprint needs a rare Talisman');
    requireThat(!fracturedCount(item), 'Imprint is refused on fractured items');
    session.imprint = structuredClone(item); ctx.used.push('beast.imprint'); return;
  }
  if (m === 'add_prefix_remove_suffix' || m === 'add_suffix_remove_prefix') {
    rare(item); ctx.used.push('beast.side_swap');
    const add = m === 'add_prefix_remove_suffix' ? 'prefix' : 'suffix', lose = add === 'prefix' ? 'suffix' : 'prefix';
    const level = action.beast_level ?? ruleValue('beast.side_swap').default_beast_level; integer(level, 1, 100, 'beast level');
    const lockedLose = meta(catalog, item)[lose] === Infinity;
    const removableMods = lockedLose ? [] : removable(catalog, item, rng, { side: lose });
    requireThat(lockedLose || removableMods.length, `No ${lose} to remove`);
    if (removableMods.length) { const target = pickUniform(removableMods, rng); item.mods = item.mods.filter(roll => roll !== target); }
    addRandom(catalog, item, rng, { side: add, item_level: level }); return;
  }
  if (m === 'metamod') {
    ctx.used.push('beast.metamod'); requireThat(item.rarity !== 'normal', 'Needs a magic or rare item');
    const crafted = item.mods.filter(roll => roll.kind === 'crafted');
    requireThat(crafted.length < meta(catalog, item).crafted_limit, 'Crafted modifier limit reached');
    const max = capacity(catalog, item), n = count(catalog, item);
    const options = ['item_generation_cannot_change_prefixes', 'item_generation_cannot_change_suffixes', 'item_generation_cannot_roll_attack_affixes', 'item_generation_cannot_roll_caster_affixes', 'item_generation_can_have_multiple_crafted_mods']
      .map(stat => metamodRecipeMod(catalog, item, stat)).filter(mod => mod && n[mod.generation_type] < max[mod.generation_type] && item.mods.length < max.total
        && !item.mods.some(roll => definition(catalog, roll).groups.some(g => mod.groups.includes(g))));
    requireThat(options.length, 'No metamod is allowed on this item');
    item.mods.push(makeRoll(pickUniform(options, rng), rng, { kind: 'crafted' })); return;
  }
  if (m === 'aspect') {
    ctx.used.push('beast.aspect');
    const id = { cat: 'GrantsCatAspectCrafted', bird: 'GrantsBirdAspectCrafted', spider: 'GrantsSpiderAspectCrafted', crab: 'GrantsCrabAspectCrafted' }[action.aspect] + ((action.level ?? 20) === 30 ? '30' : '');
    const mod = catalog.mods.get(id), max = capacity(catalog, item), n = count(catalog, item);
    requireThat(item.rarity !== 'normal' && n.suffix < max.suffix && item.mods.length < max.total && !item.mods.some(roll => definition(catalog, roll).groups.some(g => mod.groups.includes(g))), 'Aspect needs an open suffix and no other aspect');
    item.mods.push(makeRoll(mod, rng, { kind: 'beast' })); return;
  }
  if (m === 'talisman_fracture') {
    ctx.used.push('beast.talisman_fracture'); const k = action.count === 2 ? 2 : 1;
    requireThat(talisman && item.rarity === 'rare' && item.mods.length >= (k === 2 ? 6 : 4) && !fracturedCount(item) && !item.influences.length, 'Talisman fracture gate not met');
    const pool = [...item.mods]; for (let i = 0; i < k; i++) pool.splice(rng.int(pool.length), 1)[0].fractured = true; return;
  }
  if (m === 'influence') {
    ctx.used.push('beast.influence'); rare(item); requireThat(item.influences.includes(action.influence), 'Item lacks that influence');
    addRandom(catalog, item, rng, { influence: action.influence }); return;
  }
  if (m === 'max_sockets') { ctx.used.push('beast.black_morrigan'); setSocketCount(item, maxSockets(catalog, item, { ignoreLevel: true })); return; }
  if (m === 'max_links') { ctx.used.push('beast.black_morrigan'); setSocketCount(item, maxSockets(catalog, item, { ignoreLevel: true })); item.sockets.links = [item.sockets.colours.length]; return; }
  throw new Error(`Unknown beastcraft: ${m}`);
}

// ---------------- Unveil
export function unveil(ctx) {
  const { catalog, session, item, action, rng } = ctx;
  ctx.used.push('veiled.unveil');
  if (action.type === 'choose_unveil') {
    requireThat(session.offers !== null, 'No unveil offers');
    integer(action.index, 0, session.offers.ids.length - 1, 'unveil choice');
    const id = session.offers.ids[action.index], placeholder = session.offers.placeholder;
    item.mods = item.mods.filter(roll => roll.id !== placeholder);
    item.mods.push(makeRoll(catalog.mods.get(id), rng, { kind: 'unveiled' })); session.offers = null; return;
  }
  const placeholders = item.mods.filter(roll => roll.kind === 'veiled');
  requireThat(placeholders.length === 1 && session.offers === null, 'Requires exactly one veiled modifier and no pending offers');
  const placeholder = placeholders[0], side = sideOf(catalog, placeholder);
  const shadow = structuredClone(item); shadow.mods = shadow.mods.filter(roll => roll.id !== placeholder.id);
  const offers = [], excludedGroups = [];
  for (let i = 0; i < 3; i++) {
    const rows = pool(catalog, shadow, { domain: 'unveiled', side, respect_tags: false, ignore_level: true, excluded_ids: offers, excluded_groups: excludedGroups }).rows;
    if (!rows.length) break;
    const chosen = pickWeighted(rows, rng); offers.push(chosen.id); excludedGroups.push(...catalog.mods.get(chosen.id).groups);
  }
  requireThat(offers.length > 0, 'No eligible unveil outcomes in the pinned source');
  session.offers = { placeholder: placeholder.id, ids: offers };
}
export { rule, armourClasses, isJewel, influenceModOf };
