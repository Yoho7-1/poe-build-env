// Item builder (stage 2): assemble a normal/magic/rare item from RePoE mods, validate it against the
// natural/bench pool of its base and item level, render PoB item text and optionally check it in PoB.
// Pool data, tiers and stat-text rendering are reused from Craft Lab v2 (pinned RePoE 3.30.0.4).
import fs from 'node:fs';
import path from 'node:path';
import { flags } from './workspace.mjs';
import { runPob, compareResults } from './pob.mjs';
import { loadCatalog, baseOf, influenceTag, influenceSuffix } from '../experiments/craft-lab/v2/catalog.mjs';
import { emptyItem, itemTags, capacity, count, meta, isAffix } from '../experiments/craft-lab/v2/item.mjs';
import { tierInfo, pool as craftPool } from '../experiments/craft-lab/v2/draw.mjs';
import { renderRoll } from '../experiments/craft-lab/v2/export.mjs';
import { firstWeight } from '../experiments/craft-lab/engine.mjs';

export const RARITIES = ['normal', 'magic', 'rare'];
export const ROLL_POLICIES = ['max', 'min', 'mid'];
export const KEY_STATS = ['Life', 'EnergyShield', 'Mana', 'Armour', 'Evasion', 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
  'SpellSuppressionChance', 'TotalEHP', 'CombinedDPS', 'FullDPS'];
const SLOT_BY_CLASS = { Helmet: 'Helmet', 'Body Armour': 'Body Armour', Gloves: 'Gloves', Boots: 'Boots', Belt: 'Belt', Amulet: 'Amulet', Ring: 'Ring 1',
  Shield: 'Weapon 2', Quiver: 'Weapon 2' };
const SCOPE = 'Pool legality uses RePoE 3.30.0.4 spawn weights/levels (Craft Lab v2 catalog). It does not prove the item is obtainable, priced or game-tested; default values are a chosen roll, not a random outcome.';

export const catalog = () => loadCatalog();

// ---------- text matching
const normText = text => String(text ?? '').toLowerCase().replace(/\(-?[\d.]+--?[\d.]+\)/g, '#').replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
const core = text => normText(text).replace(/[#+%]/g, '').replace(/\s+/g, ' ').trim();
function modTemplate(cat, mod) {
  if (mod.text) return mod.text;
  try { return renderRoll(cat, { id: mod.id, values: mod.stats.map(stat => stat.min) }).join('\n'); } catch { return mod.id; }
}
function textScore(cat, mod, query) {
  const q = query.trim().toLowerCase();
  if (mod.type?.toLowerCase() === q) return 5;
  if (mod.groups.some(group => group.toLowerCase() === q)) return 4;
  const template = modTemplate(cat, mod), c = core(template), cq = core(query);
  if (!cq) return 0;
  if (c === cq) return 3;
  if (c.replace(/^(to|adds|of)\s+/, '') === cq) return 2;
  return normText(template).includes(normText(query)) || c.includes(cq) ? 1 : 0;
}

// ---------- spec parsing: REF[:Tn][=v1,v2]
export function parseModSpec(spec) {
  const match = /^(.*?)(?::[Tt](\d+))?(?:=(-?\d+(?:\s*,\s*-?\d+)*))?$/.exec(String(spec).trim());
  if (!match || !match[1].trim()) throw new Error(`Invalid modifier spec: ${spec}; use ID|text[:Tn][=v1,v2]`);
  return { ref: match[1].trim(), tier: match[2] ? Number(match[2]) : null, values: match[3] ? match[3].split(',').map(v => Number(v.trim())) : null };
}

// ---------- item context
function makeItem(cat, input) {
  const base = baseOf(cat, input.base);
  const itemLevel = input.item_level ?? input.ilvl;
  if (!Number.isSafeInteger(itemLevel) || itemLevel < 1 || itemLevel > 100) throw new Error('Item level must be an integer 1..100');
  const rarity = input.rarity ?? 'rare';
  if (!RARITIES.includes(rarity)) throw new Error(`Rarity must be one of ${RARITIES.join('/')}`);
  const item = emptyItem(base, itemLevel);
  item.rarity = rarity;
  item.influences = [...(input.influences ?? [])];
  return { base, item };
}
const weightOn = (mod, tags) => firstWeight(mod.spawn_weights, tags, 0) * firstWeight(mod.generation_weights, tags, 100) / 100;

// Tier table of a mod type on this base at this item level (T1 = highest required level that can spawn here).
function tiersFor(cat, item, mod, tags) {
  const info = tierInfo(cat, item, mod, tags);
  if (info.tier !== null) return { ...info, scope: 'base_ilvl' };
  const rows = (cat.byType.get(`${mod.domain}|${mod.generation_type}|${mod.type}`) ?? []).filter(row => !/Royale/.test(row.id))
    .sort((a, b) => b.required_level - a.required_level || (a.id < b.id ? -1 : 1));
  const index = rows.findIndex(row => row.id === mod.id);
  return { tiers: rows, tier: index < 0 ? null : index + 1, count: rows.length, scope: 'unfiltered_type' };
}

// Bench options for an item class: crafted mod id -> recipes.
function benchMods(cat, itemClass) {
  const result = new Map();
  for (const recipe of cat.recipes.values()) {
    const id = recipe.actions?.add_explicit_mod;
    if (!id || !recipe.item_classes.includes(itemClass)) continue;
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(recipe);
  }
  return result;
}
function craftedTiers(cat, bench, mod) {
  const rows = [...bench.keys()].map(id => cat.mods.get(id)).filter(row => row && row.type === mod.type && row.generation_type === mod.generation_type)
    .sort((a, b) => b.required_level - a.required_level || (a.id < b.id ? -1 : 1));
  const index = rows.findIndex(row => row.id === mod.id);
  return { tiers: rows, tier: index < 0 ? null : index + 1, count: rows.length, scope: 'bench_class' };
}

// Resolve a natural/crafted/implicit spec to one RePoE mod.
function resolveMod(cat, ctx, spec, kind) {
  const { ref, tier } = spec;
  const direct = cat.mods.get(ref);
  if (direct) {
    if (tier !== null) {
      const info = kind === 'crafted' ? craftedTiers(cat, ctx.bench, direct) : tiersFor(cat, ctx.item, direct, ctx.tags);
      if (info.tier !== tier) throw new Error(`${ref} is T${info.tier ?? '?'} here, not T${tier}; omit :T with an exact id`);
    }
    return direct;
  }
  let candidates;
  if (kind === 'crafted') candidates = [...ctx.bench.keys()].map(id => cat.mods.get(id)).filter(Boolean);
  else if (kind === 'implicit') candidates = [...cat.mods.values()].filter(mod => !isAffix(mod) && mod.domain === ctx.base.domain && !/Royale/.test(mod.id));
  else {
    const legal = craftPool(cat, ctx.item, { ignore_capacity: true }).rows.map(row => cat.mods.get(row.id));
    candidates = legal;
    if (!candidates.some(mod => textScore(cat, mod, ref) > 0)) candidates = (cat.candidates.get(ctx.base.domain + ':affix') ?? []).filter(mod => !/Royale/.test(mod.id));
  }
  const scored = candidates.map(mod => ({ mod, score: textScore(cat, mod, ref) })).filter(row => row.score > 0);
  if (!scored.length) throw new Error(`No ${kind} modifier matches "${ref}" for ${ctx.base.name}`);
  const top = Math.max(...scored.map(row => row.score));
  const best = scored.filter(row => row.score === top).map(row => row.mod);
  const types = [...new Set(best.map(mod => `${mod.generation_type}|${mod.type}`))];
  if (types.length > 1) {
    const sample = types.slice(0, 12).map(key => { const mod = best.find(m => `${m.generation_type}|${m.type}` === key); return `${mod.type} (${mod.generation_type}): ${modTemplate(cat, mod).replace(/\n/g, ' / ')}`; });
    throw new Error(`Ambiguous ${kind} modifier "${ref}"; use the type name or a mod id:\n  ${sample.join('\n  ')}`);
  }
  const info = kind === 'crafted' ? craftedTiers(cat, ctx.bench, best[0]) : tiersFor(cat, ctx.item, best[0], ctx.tags);
  const wanted = tier ?? 1;
  const chosen = info.tiers[wanted - 1];
  if (!chosen) throw new Error(`${best[0].type} has ${info.count} tier(s) here; T${wanted} does not exist`);
  return chosen;
}

function chooseValues(mod, spec, policy, violations) {
  if (spec.values) {
    if (spec.values.length !== mod.stats.length) throw new Error(`${mod.id} needs ${mod.stats.length} value(s), got ${spec.values.length}`);
    spec.values.forEach((value, index) => {
      const stat = mod.stats[index], low = Math.min(stat.min, stat.max), high = Math.max(stat.min, stat.max);
      if (!Number.isSafeInteger(value)) throw new Error(`Values must be integers in RePoE units: ${mod.id}`);
      if (value < low || value > high) violations.push({ code: 'value_out_of_range', mod: mod.id, detail: `${stat.id}=${value} outside ${low}..${high}` });
    });
    return { values: spec.values, source: 'explicit' };
  }
  return { values: mod.stats.map(stat => {
    const low = Math.min(stat.min, stat.max), high = Math.max(stat.min, stat.max);
    return policy === 'min' ? low : policy === 'mid' ? Math.round((low + high) / 2) : high;
  }), source: `${policy}_of_range` };
}

// Some RePoE translation groups pair a stat with a companion the mod never carries (local weapon mods:
// local_physical_damage_+% + local_weapon_no_physical_damage). The companion is absent = 0, so the roll is
// rendered against a copy of the mod that lists those companions with value 0.
export function companionStats(cat, mod) {
  const own = new Set(mod.stats.map(stat => stat.id)), extra = new Set();
  for (const group of cat.translations) if (group.ids.some(id => own.has(id))) for (const id of group.ids) if (!own.has(id)) extra.add(id);
  return [...extra];
}
function renderLines(cat, roll, violations) {
  try { return renderRoll(cat, roll); }
  catch (error) {
    const mod = cat.mods.get(roll.id), extra = mod ? companionStats(cat, mod) : [];
    if (extra.length) {
      const padded = { ...mod, stats: [...mod.stats, ...extra.map(id => ({ id, min: 0, max: 0 }))] };
      try { return renderRoll({ ...cat, mods: new Map([[mod.id, padded]]) }, { ...roll, values: [...roll.values, ...extra.map(() => 0)] }); } catch {}
    }
    violations.push({ code: 'untranslated_stat', mod: roll.id, detail: error.message }); return [];
  }
}

// ---------- public builder
// input: { base, item_level, rarity, quality, influences[], name, sockets, roll, implicits: [spec]|null, mods: [spec], crafted: [spec], allow_illegal }
// spec: string "REF[:Tn][=v]" or { ref|id, tier, values }.
export function buildItem(input, cat = catalog()) {
  const policy = input.roll ?? 'max';
  if (!ROLL_POLICIES.includes(policy)) throw new Error(`roll must be ${ROLL_POLICIES.join('/')}`);
  const violations = [], warnings = [];
  const { base, item } = makeItem(cat, input);
  if (base.domain !== 'item') warnings.push({ code: 'non_equipment_domain', detail: `Base domain ${base.domain}: only equipment export is verified` });
  const quality = input.quality ?? 0;
  if (!Number.isSafeInteger(quality) || quality < 0 || quality > 30) throw new Error('Quality must be an integer 0..30');
  if (quality > 20) warnings.push({ code: 'quality_above_20', detail: 'Quality above 20 needs a special source' });
  if (item.influences.length > 2 || new Set(item.influences).size !== item.influences.length) violations.push({ code: 'influence_count', mod: null, detail: 'At most two distinct influences' });
  for (const influence of item.influences) {
    if (!influenceSuffix[influence]) throw new Error(`Unknown influence ${influence}; use ${Object.keys(influenceSuffix).join('/')}`);
    try { influenceTag(cat, base, influence); } catch (error) { violations.push({ code: 'influence_not_supported', mod: null, detail: error.message }); }
  }
  if (item.influences.length && item.rarity !== 'rare') warnings.push({ code: 'influence_on_non_rare', detail: 'Influence is kept, but influenced mods usually come from rare crafting' });
  const toSpec = entry => typeof entry === 'string' ? parseModSpec(entry) : { ref: entry.ref ?? entry.id, tier: entry.tier ?? null, values: entry.values ?? null };

  // Implicits: base implicits by default, or an explicit replacement list.
  const implicitRolls = [];
  const implicitSpecs = input.implicits == null ? base.implicits.map(id => ({ ref: id, tier: null, values: null })) : input.implicits.map(toSpec);
  const ctx = { base, item, tags: null, bench: benchMods(cat, base.item_class) };
  ctx.tags = itemTags(cat, item);
  for (const spec of implicitSpecs) {
    const mod = resolveMod(cat, ctx, spec, 'implicit');
    if (isAffix(mod)) throw new Error(`${mod.id} is an explicit affix, not an implicit`);
    if (input.implicits != null && !base.implicits.includes(mod.id)) warnings.push({ code: 'non_base_implicit', mod: mod.id, detail: 'Implicit is not the base implicit; its source (corruption, Eldritch, synthesis...) is not validated' });
    const chosen = chooseValues(mod, spec, policy, violations);
    implicitRolls.push({ id: mod.id, kind: 'implicit', fractured: false, values: chosen.values, value_source: chosen.source });
  }
  item.implicits = implicitRolls.map(({ value_source, ...roll }) => roll);
  ctx.tags = itemTags(cat, item);

  // Explicit natural and crafted mods.
  const entries = [];
  for (const [kind, list] of [['natural', input.mods ?? []], ['crafted', input.crafted ?? []]]) for (const raw of list) {
    const spec = toSpec(raw), mod = resolveMod(cat, ctx, spec, kind);
    const chosen = chooseValues(mod, spec, policy, violations);
    entries.push({ mod, kind, values: chosen.values, value_source: chosen.source });
  }
  item.mods = entries.map(entry => ({ id: entry.mod.id, kind: entry.kind, fractured: false, values: entry.values }));
  ctx.tags = itemTags(cat, item);

  // Per-mod legality.
  const seenGroups = new Map();
  const restrictions = meta(cat, item);
  const described = entries.map(entry => {
    const { mod, kind } = entry;
    const note = { id: mod.id, kind, side: mod.generation_type, type: mod.type, groups: mod.groups, required_level: mod.required_level, values: entry.values,
      ranges: mod.stats.map(stat => ({ stat: stat.id, min: stat.min, max: stat.max })), value_source: entry.value_source, tier: null, tier_count: null, tier_scope: null, weight: null, recipe: null };
    if (!isAffix(mod)) violations.push({ code: 'not_affix', mod: mod.id, detail: `generation_type ${mod.generation_type} is not prefix/suffix` });
    if (kind === 'crafted') {
      if (mod.domain !== 'crafted') violations.push({ code: 'not_bench_mod', mod: mod.id, detail: `domain ${mod.domain}; crafted mods must come from the bench` });
      const recipes = ctx.bench.get(mod.id) ?? [];
      if (!recipes.length) violations.push({ code: 'no_bench_recipe', mod: mod.id, detail: `No bench recipe adds this mod to ${base.item_class}` });
      else {
        const recipe = recipes[0];
        note.recipe = { id: recipe.id, master: recipe.master ?? null, bench_tier: recipe.bench_tier ?? null, cost: Object.fromEntries(Object.entries(recipe.cost).map(([id, n]) => [cat.allBases.get(id)?.name ?? id, n])) };
      }
      const info = craftedTiers(cat, ctx.bench, mod); Object.assign(note, { tier: info.tier, tier_count: info.count, tier_scope: info.scope });
    } else {
      if (mod.domain !== base.domain) violations.push({ code: 'wrong_domain', mod: mod.id, detail: `mod domain ${mod.domain}, base domain ${base.domain}` });
      const weight = weightOn(mod, ctx.tags); note.weight = weight;
      if (weight <= 0) violations.push({ code: 'not_in_pool', mod: mod.id, detail: `spawn weight 0 for tags ${[...ctx.tags].sort().join(',')}` });
      if (mod.required_level > item.item_level) violations.push({ code: 'item_level_too_low', mod: mod.id, detail: `requires ilvl ${mod.required_level}, item is ${item.item_level}` });
      if (mod.is_essence_only) warnings.push({ code: 'essence_only', mod: mod.id, detail: 'Only obtainable from an Essence; not in the natural pool' });
      const info = tiersFor(cat, item, mod, ctx.tags); Object.assign(note, { tier: info.tier, tier_count: info.count, tier_scope: info.scope });
    }
    if ((restrictions.attack && mod.implicit_tags.includes('attack')) || (restrictions.caster && mod.implicit_tags.includes('caster')))
      violations.push({ code: 'blocked_by_meta', mod: mod.id, detail: 'Blocked by "cannot roll attack/caster modifiers"' });
    for (const group of mod.groups) {
      if (seenGroups.has(group)) violations.push({ code: 'group_conflict', mod: mod.id, detail: `group ${group} already used by ${seenGroups.get(group)}` });
      else seenGroups.set(group, mod.id);
    }
    return note;
  });

  // Capacity and bench rules.
  const max = capacity(cat, item), n = isAffixList(cat, item) ? count(cat, item) : { prefix: 0, suffix: 0 };
  for (const side of ['prefix', 'suffix']) if (n[side] > max[side]) violations.push({ code: `too_many_${side}es`, mod: null, detail: `${n[side]} ${side}es, ${item.rarity} ${base.item_class} allows ${max[side]}` });
  if (item.mods.length > max.total) violations.push({ code: 'too_many_affixes', mod: null, detail: `${item.mods.length} affixes, limit ${max.total}` });
  const craftedCount = entries.filter(entry => entry.kind === 'crafted').length;
  if (craftedCount > restrictions.crafted_limit) violations.push({ code: 'too_many_crafted', mod: null, detail: `${craftedCount} crafted mods; limit ${restrictions.crafted_limit} (more needs "Can have up to 3 Crafted Modifiers")` });
  if (craftedCount) warnings.push({ code: 'bench_unlock_assumed', detail: 'Bench recipe unlock and cost affordability are not verified' });

  // Text.
  const name = input.name ?? 'Item Builder Rare';
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error('Item name must be printable ASCII');
  const lines = [`Rarity: ${item.rarity.toUpperCase()}`];
  if (item.rarity === 'rare') lines.push(name);
  lines.push(base.name);
  if (input.sockets) {
    if (!/^[RGBWAD]([- ][RGBWAD]){0,5}$/.test(input.sockets)) throw new Error('Sockets must look like R-G-B B (max 6)');
    lines.push(`Sockets: ${input.sockets}`);
  }
  lines.push(`Item Level: ${item.item_level}`);
  if (quality) lines.push(`Quality: ${quality}`);
  const pobInfluence = { Shaper: 'Shaper', Elder: 'Elder', Crusader: 'Crusader', Redeemer: 'Redeemer', Hunter: 'Hunter', Warlord: 'Warlord' };
  for (const influence of item.influences) lines.push(`${pobInfluence[influence]} Item`);
  const implicitText = implicitRolls.map(roll => ({ roll, lines: renderLines(cat, roll, violations) }));
  // PoB line flags for eldritch implicits ({exarch}/{eater}); other implicits are plain lines.
  const lineFlag = roll => ({ searing_exarch_implicit: '{exarch}', eater_of_worlds_implicit: '{eater}' })[cat.mods.get(roll.id)?.generation_type] ?? '';
  lines.push(`Implicits: ${implicitText.reduce((sum, row) => sum + row.lines.length, 0)}`, ...implicitText.flatMap(row => row.lines.map(line => lineFlag(row.roll) + line)));
  const modText = entries.map((entry, index) => ({ entry, lines: renderLines(cat, item.mods[index], violations) }));
  // PoB shows prefixes before suffixes; order does not change the calculation.
  for (const row of [...modText.filter(r => r.entry.mod.generation_type === 'prefix'), ...modText.filter(r => r.entry.mod.generation_type !== 'prefix')])
    lines.push(...row.lines.map(line => (row.entry.kind === 'crafted' ? '{crafted}' : '') + line));
  described.forEach((note, index) => { note.lines = modText[index].lines; });
  const text = lines.join('\n');
  if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) violations.push({ code: 'non_ascii_text', mod: null, detail: 'Rendered text contains non-ASCII characters' });

  const legal = violations.length === 0, allow = !!input.allow_illegal;
  if (!legal && allow) warnings.unshift({ code: 'hypothetical_item', detail: `Item violates ${violations.length} rule(s); built anyway because allow_illegal is set` });
  const slot = input.slot ?? null;
  return {
    game: 'poe1', patch: '3.30', format: 'pob-item-text', legal, hypothetical: !legal && allow,
    item: { base: base.name, base_id: base.id, item_class: base.item_class, item_level: item.item_level, rarity: item.rarity, quality, influences: item.influences,
      capacity: max, used: n, crafted_limit: restrictions.crafted_limit,
      implicits: implicitRolls.map((roll, index) => ({ id: roll.id, values: roll.values, value_source: roll.value_source, lines: implicitText[index].lines })), mods: described },
    violations, warnings,
    text: legal || allow ? text : null,
    changes: (legal || allow) && slot ? { replace_items: [{ slot, text }] } : null,
    default_slot: SLOT_BY_CLASS[base.item_class] ?? null,
    game_tested: false, scope: SCOPE,
  };
}
const isAffixList = (cat, item) => item.mods.every(roll => isAffix(cat.mods.get(roll.id)));

// Legal natural pool of a base at an item level, grouped by mod type with tiers.
export function itemPool(input, cat = catalog()) {
  const { base, item } = makeItem(cat, { rarity: 'rare', ...input });
  for (const influence of item.influences) influenceTag(cat, base, influence);
  const tags = itemTags(cat, item);
  const rows = craftPool(cat, item, { ignore_capacity: true }).rows;
  const byType = new Map();
  for (const row of rows) {
    const mod = cat.mods.get(row.id), key = `${mod.generation_type}|${mod.type}`;
    if (!byType.has(key)) byType.set(key, { type: mod.type, side: mod.generation_type, groups: mod.groups, tags: mod.implicit_tags, total_weight: 0, tiers: [] });
    byType.get(key).total_weight += row.weight;
  }
  const search = input.search ? String(input.search) : null;
  const side = input.side ?? null;
  let types = [...byType.values()].filter(type => !side || type.side === side);
  for (const type of types) {
    const sample = rows.map(row => cat.mods.get(row.id)).find(mod => mod.type === type.type && mod.generation_type === type.side);
    const info = tierInfo(cat, item, sample, tags);
    type.tiers = info.tiers.map((mod, index) => ({ tier: index + 1, id: mod.id, ilvl: mod.required_level, weight: weightOn(mod, tags), text: modTemplate(cat, mod) }));
  }
  if (search) types = types.map(type => ({ type, score: Math.max(...type.tiers.map(tier => textScore(cat, cat.mods.get(tier.id), search)), type.type.toLowerCase().includes(search.toLowerCase()) ? 1 : 0) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score).map(row => row.type);
  else types.sort((a, b) => a.side.localeCompare(b.side) || b.total_weight - a.total_weight);
  const limit = input.limit ?? 40;
  const bench = input.crafted ? [...benchMods(cat, base.item_class).entries()].map(([id, recipes]) => ({ id, mod: cat.mods.get(id) }))
    .filter(row => row.mod && (!search || textScore(cat, row.mod, search) > 0) && (!side || row.mod.generation_type === side))
    .map(row => ({ id: row.id, side: row.mod.generation_type, type: row.mod.type, text: modTemplate(cat, row.mod), recipe: ctxRecipe(cat, base, row.id) })) : undefined;
  return { game: 'poe1', patch: '3.30', base: base.name, item_class: base.item_class, item_level: item.item_level, influences: item.influences,
    tags: [...tags].sort(), type_count: types.length, truncated: types.length > limit,
    types: types.slice(0, limit).map(type => input.all_tiers ? type : { ...type, tiers: type.tiers.slice(0, input.tiers ?? 3), tier_count: type.tiers.length }),
    crafted: bench, notes: 'T1 = highest required level that can spawn on this base at this ilvl; weights are spawn*generation weights (tags include influences). Essence-only mods are excluded.' };
}
function ctxRecipe(cat, base, id) {
  const recipe = benchMods(cat, base.item_class).get(id)?.[0];
  return recipe ? { id: recipe.id, master: recipe.master ?? null, bench_tier: recipe.bench_tier ?? null } : null;
}

// Equip the built item in PoB and compare key stats with the unchanged build.
export function checkItem({ build, slot, text, scenario = 'imported', timeout } = {}) {
  if (!build) throw new Error('check needs a build XML');
  if (!slot) throw new Error('check needs --slot');
  if (!text) throw new Error('check needs item text (the item is illegal; use --allow-illegal to test a hypothetical item)');
  const input = fs.readFileSync(path.resolve(build)), changes = { replace_items: [{ slot, text }] };
  const before = runPob({ input, scenario, timeout }), after = runPob({ input, scenario, changes, timeout });
  const comparison = compareResults(before, after);
  const deltas = Object.fromEntries(KEY_STATS.map(stat => {
    const row = comparison.differences.find(d => d.stat === stat);
    const value = after.output?.[stat];
    return [stat, row ? { before: row.before, after: row.after, delta: row.delta } : value === undefined ? null : { before: value, after: value, delta: 0 }];
  }).filter(([, value]) => value !== null));
  const unparsedSlot = (after.unparsed_item_modifiers ?? []).filter(row => row.slot === slot);
  const baselineUnparsed = new Set((before.unparsed_item_modifiers ?? []).map(row => `${row.slot}|${row.line}`));
  return { scenario, slot, ok: unparsedSlot.length === 0, unparsed_item_modifiers: unparsedSlot,
    other_unparsed_new: (after.unparsed_item_modifiers ?? []).filter(row => row.slot !== slot && !baselineUnparsed.has(`${row.slot}|${row.line}`)),
    equipped: (after.equipped_items ?? []).find(row => row.slot === slot) ?? null, key_stats: deltas,
    engine_warnings: after.engine_warnings ?? [], calculation_ids: { before: before.calculation_id, after: after.calculation_id },
    interpretation: 'PoB engine estimate with the build configuration; not a game test. Requirements (level/attributes) are not enforced by the DPS number.' };
}

// ---------- CLI
const MULTI = ['mod', 'craft', 'implicit'];
function splitMulti(args) {
  const multi = Object.fromEntries(MULTI.map(key => [key, []])), rest = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : null;
    if (key && MULTI.includes(key)) {
      if (args[i + 1] == null || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
      multi[key].push(args[++i]); continue;
    }
    rest.push(args[i]);
  }
  return { multi, rest };
}
const int = (value, label) => { if (value == null) return undefined; const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error(`${label} must be an integer`); return n; };
const list = value => value == null ? [] : String(value).split(',').map(s => s.trim()).filter(Boolean);
const BUILD_OPTIONS = ['base', 'ilvl', 'rarity', 'quality', 'influence', 'name', 'sockets', 'roll', 'slot', 'scenario', 'check', 'format'];
const BUILD_SWITCHES = ['allow-illegal', 'no-implicits'];

function buildFromArgs(args) {
  const { multi, rest } = splitMulti(args);
  const { positional, options } = flags(rest, BUILD_OPTIONS, BUILD_SWITCHES);
  if (positional.length) throw new Error(`Unexpected argument: ${positional[0]}`);
  if (!options.base) throw new Error('--base is required');
  if (!options.ilvl) throw new Error('--ilvl is required');
  const base = baseOf(catalog(), options.base);
  const slot = options.slot ?? (options.check ? SLOT_BY_CLASS[base.item_class] : null) ?? null;
  const result = buildItem({ base: options.base, item_level: int(options.ilvl, '--ilvl'), rarity: options.rarity ?? 'rare', quality: int(options.quality, '--quality') ?? 0,
    influences: list(options.influence), name: options.name, sockets: options.sockets, roll: options.roll ?? 'max', slot,
    implicits: options['no-implicits'] ? [] : multi.implicit.length ? multi.implicit : null, mods: multi.mod, crafted: multi.craft, allow_illegal: !!options['allow-illegal'] });
  return { result, options, slot };
}
function illegal(result) {
  return new Error(`Illegal item: ${result.violations.length} violation(s); use --allow-illegal for a hypothetical item\n${result.violations.map(v => `- ${v.code}${v.mod ? ` [${v.mod}]` : ''}: ${v.detail}`).join('\n')}`);
}

export function itemCommand(rest) {
  const [operation = 'help', ...args] = rest;
  if (operation === 'help') return { usage: itemHelp };
  if (operation === 'pool') {
    const { positional, options } = flags(args, ['base', 'ilvl', 'influence', 'search', 'side', 'limit', 'tiers'], ['all-tiers', 'crafted']);
    if (positional.length) throw new Error(`Unexpected argument: ${positional[0]}`);
    if (!options.base || !options.ilvl) throw new Error('--base and --ilvl are required');
    if (options.side && !['prefix', 'suffix'].includes(options.side)) throw new Error('--side must be prefix or suffix');
    return itemPool({ base: options.base, item_level: int(options.ilvl, '--ilvl'), influences: list(options.influence), search: options.search, side: options.side,
      limit: int(options.limit, '--limit'), tiers: int(options.tiers, '--tiers'), all_tiers: !!options['all-tiers'], crafted: !!options.crafted });
  }
  if (operation === 'build' || operation === 'check') {
    const { result, options, slot } = buildFromArgs(args);
    if (!result.legal && !result.text) throw illegal(result);
    if (options.format === 'text') return result.text;
    if (operation === 'check' || options.check) {
      const build = options.check ?? null;
      if (!build) throw new Error('item check needs --check <build.xml>');
      if (!slot) throw new Error(`No default slot for ${result.item.item_class}; pass --slot`);
      result.check = checkItem({ build, slot, text: result.text, scenario: options.scenario ?? 'imported' });
    }
    return result;
  }
  throw new Error('Use item build | item pool | item check | item appraise | item help');
}

export const itemHelp = {
  'item build --base <name> --ilvl N [--rarity rare|magic|normal] [--mod REF[:Tn][=v,..]]... [--craft REF[:Tn][=v]]... [--implicit REF[=v]]... [--no-implicits] [--quality Q] [--influence Shaper,Elder] [--sockets B-B-B-B] [--name X] [--roll max|min|mid] [--slot Slot] [--allow-illegal] [--format text]':
    'Build an item from RePoE mods (REF = mod id, type name or stat text like "maximum Life"); validates pool/ilvl/prefix-suffix/group/bench rules and prints PoB item text plus changes {replace_items:[{slot,text}]}',
  'item pool --base <name> --ilvl N [--influence X,Y] [--search text] [--side prefix|suffix] [--tiers N|--all-tiers] [--crafted] [--limit N]':
    'Legal natural mods of a base at an item level, grouped by type with tiers (T1 = best at this ilvl), weights; --crafted adds bench options for the class',
  'item check <build args> --check <build.xml> [--slot Slot] [--scenario S]':
    'Build the item, equip it in PoB (runPob replace_items), report unparsed_item_modifiers for the slot and key stat deltas (Life, ES, resists, CombinedDPS) vs the unchanged build',
};
