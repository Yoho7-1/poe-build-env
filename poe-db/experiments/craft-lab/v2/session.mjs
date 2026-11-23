import { digest, baseOf } from './catalog.mjs';
import { keys, integer, random } from '../engine.mjs';
import { createItem, validateItem, definition, valuesOf, count, capacity, requireThat, itemTags } from './item.mjs';
import { tierInfo, influenceModOf } from './draw.mjs';
import { normalizeAction, costOf, apply, currencyActions } from './actions.mjs';
import { currency } from './actions/basic.mjs';
import { rules, ruleValue } from './rules.mjs';

export const model = Object.freeze({ id: 'craft-lab-v2', game: 'poe1', patch: '3.30', status: 'experimental', game_validated: false,
  principle: 'Every step reports the rule ids it used; rules with confidence model/coe/measured are declared approximations, not server facts.' });

export function resources(value, label) {
  keys(value, Object.keys(value ?? {}), label);
  for (const [name, amount] of Object.entries(value)) requireThat(name.length > 0 && name.length <= 180 && !['__proto__', 'prototype', 'constructor'].includes(name) && Number.isSafeInteger(amount) && amount >= 0 && amount <= 1000000000, `Invalid ${label} amount: ${name}`);
  return value;
}
const CONDITION_FIELDS = ['all', 'any', 'not', 'mods', 'groups', 'stats', 'rarity', 'open_prefixes', 'open_suffixes', 'crafted', 'offers', 'corrupted', 'fractured', 'influences', 'implicits', 'min_tier', 'links', 'sockets', 'colours', 'quality', 'memory_strands', 'status', 'mod_count'];
export function validateCondition(catalog, condition, depth = 0) {
  requireThat(depth <= 16, 'Condition nesting limit exceeded');
  keys(condition, CONDITION_FIELDS, 'condition');
  requireThat(Object.keys(condition).length > 0, 'Empty conditions are forbidden; omit when for an unconditional rule');
  for (const field of ['all', 'any']) if (condition[field] !== undefined) {
    requireThat(Array.isArray(condition[field]) && condition[field].length > 0 && condition[field].length <= 100, `Invalid condition ${field}`);
    condition[field].forEach(value => validateCondition(catalog, value, depth + 1));
  }
  if (condition.not !== undefined) validateCondition(catalog, condition.not, depth + 1);
  if (condition.rarity !== undefined) requireThat(['normal', 'magic', 'rare'].includes(condition.rarity), 'Invalid condition rarity');
  if (condition.status !== undefined) requireThat(['active', 'destroyed', 'unique_outcome'].includes(condition.status), 'Invalid condition status');
  for (const field of ['mods', 'groups', 'implicits', 'fractured']) if (condition[field] !== undefined) {
    requireThat(Array.isArray(condition[field]) && condition[field].length > 0, `Invalid condition ${field}`);
    for (const id of condition[field]) requireThat(field === 'groups' ? catalog.groups.has(id) : catalog.mods.has(id), `Unknown ${field}: ${id}`);
  }
  if (condition.influences !== undefined) requireThat(Array.isArray(condition.influences), 'Invalid influences');
  if (condition.min_tier !== undefined) {
    requireThat(Array.isArray(condition.min_tier) && condition.min_tier.length > 0, 'min_tier needs [{group|type, tier}]');
    for (const entry of condition.min_tier) { keys(entry, ['group', 'type', 'tier'], 'min_tier entry'); integer(entry.tier, 1, 30, 'tier'); requireThat(!!entry.group !== !!entry.type, 'min_tier entry needs group or type'); }
  }
  for (const field of ['open_prefixes', 'open_suffixes', 'links', 'sockets', 'quality', 'memory_strands', 'mod_count']) if (condition[field] !== undefined) {
    const value = condition[field];
    if (typeof value === 'number') integer(value, 0, 100, field); else { keys(value, ['min', 'max'], field); }
  }
  if (condition.colours !== undefined) { keys(condition.colours, ['R', 'G', 'B', 'W'], 'colours'); }
  for (const field of ['crafted', 'offers', 'corrupted']) if (condition[field] !== undefined) requireThat(typeof condition[field] === 'boolean', `Invalid condition ${field}`);
  if (condition.stats !== undefined) {
    requireThat(Array.isArray(condition.stats) && condition.stats.length > 0 && condition.stats.length <= 100, 'Invalid stats condition');
    for (const stat of condition.stats) {
      keys(stat, ['id', 'min', 'max', 'scope'], 'stat condition');
      requireThat(catalog.statIds.has(stat.id), `Unknown stat: ${stat.id}`);
      requireThat(stat.min !== undefined || stat.max !== undefined, 'Stat condition needs min or max');
      requireThat(stat.scope === undefined || ['explicit', 'implicit', 'all', 'catalysed'].includes(stat.scope), 'Stat scope: explicit|implicit|all|catalysed');
      if (stat.min !== undefined && stat.max !== undefined) requireThat(stat.min <= stat.max, 'Inverted stat range');
    }
  }
  return condition;
}
const range = (value, actual) => typeof value === 'number' ? actual >= value : (value.min === undefined || actual >= value.min) && (value.max === undefined || actual <= value.max);
// Catalyst scaling (rule quality.catalyst): matching mods scaled by (100+q)/100, floored.
export function catalysedValues(catalog, item) {
  const types = ruleValue('quality.catalyst'), result = new Map();
  const tagsFor = types[item.quality_type];
  for (const roll of [...item.implicits, ...item.mods]) {
    const mod = definition(catalog, roll);
    const scaled = item.quality > 0 && tagsFor && (tagsFor[0] === 'prefix' || tagsFor[0] === 'suffix' ? mod.generation_type === tagsFor[0] : mod.implicit_tags.some(tag => tagsFor.includes(tag)));
    mod.stats.forEach((stat, i) => result.set(stat.id, (result.get(stat.id) ?? 0) + (scaled ? Math.floor(roll.values[i] * (100 + item.quality) / 100) : roll.values[i])));
  }
  return result;
}
export function meets(catalog, session, condition) {
  const item = session.item, n = count(catalog, item), max = capacity(catalog, item);
  if (condition.status !== undefined) return session.status === condition.status && (Object.keys(condition).length === 1 || meetsRest(catalog, session, { ...condition, status: undefined }));
  if (session.status !== 'active') return false;
  return meetsRest(catalog, session, condition, n, max);
}
function meetsRest(catalog, session, condition, n = count(catalog, session.item), max = capacity(catalog, session.item)) {
  const item = session.item;
  if (condition.all && !condition.all.every(value => meets(catalog, session, value))) return false;
  if (condition.any && !condition.any.some(value => meets(catalog, session, value))) return false;
  if (condition.not && meets(catalog, session, condition.not)) return false;
  if (condition.rarity !== undefined && condition.rarity !== item.rarity) return false;
  if (condition.mods && !condition.mods.every(id => item.mods.some(roll => roll.id === id))) return false;
  if (condition.fractured && !condition.fractured.every(id => item.mods.some(roll => roll.id === id && roll.fractured))) return false;
  if (condition.implicits && !condition.implicits.every(id => item.implicits.some(roll => roll.id === id))) return false;
  if (condition.groups && !condition.groups.every(group => item.mods.some(roll => definition(catalog, roll).groups.includes(group)))) return false;
  if (condition.influences && !condition.influences.every(name => item.influences.includes(name))) return false;
  if (condition.open_prefixes !== undefined && !range(condition.open_prefixes, max.prefix - n.prefix)) return false;
  if (condition.open_suffixes !== undefined && !range(condition.open_suffixes, max.suffix - n.suffix)) return false;
  if (condition.mod_count !== undefined && !range(condition.mod_count, item.mods.length)) return false;
  if (condition.crafted !== undefined && item.mods.some(roll => roll.kind === 'crafted') !== condition.crafted) return false;
  if (condition.offers !== undefined && (session.offers !== null) !== condition.offers) return false;
  if (condition.corrupted !== undefined && item.corrupted !== condition.corrupted) return false;
  if (condition.links !== undefined && !range(condition.links, Math.max(0, ...item.sockets.links))) return false;
  if (condition.sockets !== undefined && !range(condition.sockets, item.sockets.colours.length)) return false;
  if (condition.quality !== undefined && !range(condition.quality, item.quality)) return false;
  if (condition.memory_strands !== undefined && !range(condition.memory_strands, item.memory_strands)) return false;
  if (condition.colours && !Object.entries(condition.colours).every(([c, k]) => item.sockets.colours.filter(x => x === c).length >= k)) return false;
  if (condition.min_tier) {
    const tags = itemTags(catalog, item);
    for (const entry of condition.min_tier) {
      const ok = item.mods.some(roll => { const mod = definition(catalog, roll); if (entry.group ? !mod.groups.includes(entry.group) : mod.type !== entry.type) return false; const t = tierInfo(catalog, item, mod, tags, 100).tier; return t !== null && t <= entry.tier; });
      if (!ok) return false;
    }
  }
  if (condition.stats) {
    const sources = { explicit: valuesOf(catalog, item.mods), implicit: valuesOf(catalog, item.implicits), all: valuesOf(catalog, [...item.implicits, ...item.mods]), catalysed: catalysedValues(catalog, item) };
    if (!condition.stats.every(stat => { const v = sources[stat.scope ?? 'explicit'].get(stat.id) ?? 0; return (stat.min === undefined || v >= stat.min) && (stat.max === undefined || v <= stat.max); })) return false;
  }
  return true;
}
const SCENARIO = ['item', 'inventory', 'seed', 'budget', 'target', 'unlocked_recipes', 'start_cost'];
export function createSession(catalog, input) {
  keys(input, SCENARIO, 'scenario');
  integer(input.seed, 0, 0xffffffff, 'seed');
  const rng = random(input.seed), item = createItem(catalog, input.item, rng);
  const inventory = {};
  if (input.inventory != null) { keys(input.inventory, Object.keys(input.inventory), 'inventory'); for (const [id, spec] of Object.entries(input.inventory)) { requireThat(/^[a-z0-9-]{1,32}$/.test(id), 'Inventory ids: lowercase, digits, hyphens'); inventory[id] = createItem(catalog, spec, rng); } }
  const initial = structuredClone({ ...input, inventory: input.inventory ?? null, budget: input.budget == null ? null : resources(input.budget, 'budget'),
    target: input.target == null ? null : validateCondition(catalog, input.target), unlocked_recipes: input.unlocked_recipes ?? null,
    start_cost: input.start_cost == null ? null : resources(input.start_cost, 'start cost') });
  if (initial.unlocked_recipes !== null && initial.unlocked_recipes !== 'all_assumed') requireThat(Array.isArray(initial.unlocked_recipes) && initial.unlocked_recipes.every(id => catalog.recipes.has(id)), 'Invalid recipe unlock list');
  const spent = structuredClone(initial.start_cost ?? {});
  if (initial.budget !== null) for (const [name, amount] of Object.entries(spent)) requireThat(amount <= (initial.budget[name] ?? 0), `Starting acquisition exceeds budget: ${name}`);
  return { schema_version: 3, model_id: model.id, contract: catalog.contract, initial, revision: 0, rng_state: rng.state, status: 'active', item, inventory, spent, imprint: null, offers: null, history: [] };
}
const SESSION = ['schema_version', 'model_id', 'contract', 'initial', 'revision', 'rng_state', 'status', 'item', 'inventory', 'spent', 'imprint', 'offers', 'history'];
export function validateSession(catalog, session) {
  keys(session, SESSION, 'session');
  requireThat(session.schema_version === 3 && session.model_id === model.id && session.contract === catalog.contract, 'Session version/contract mismatch; do not silently migrate');
  integer(session.revision, 0, 100000, 'revision'); integer(session.rng_state, 0, 0xffffffff, 'RNG state');
  requireThat(['active', 'destroyed', 'unique_outcome'].includes(session.status), 'Invalid status');
  requireThat(Array.isArray(session.history) && session.history.length === session.revision, 'History/revision mismatch');
  validateItem(catalog, session.item); resources(session.spent, 'spent');
  for (const item of Object.values(session.inventory)) validateItem(catalog, item);
  if (session.imprint !== null) validateItem(catalog, session.imprint);
  if (session.offers !== null) {
    keys(session.offers, ['placeholder', 'ids'], 'offers');
    requireThat(session.item.mods.some(roll => roll.id === session.offers.placeholder && roll.kind === 'veiled'), 'Missing unveil placeholder');
    requireThat(Array.isArray(session.offers.ids) && session.offers.ids.length >= 1 && session.offers.ids.length <= 3 && session.offers.ids.every(id => catalog.mods.get(id)?.domain === 'unveiled'), 'Invalid unveil offers');
  }
  return session;
}
const stateHash = session => digest({ item: session.item, inventory: session.inventory, imprint: session.imprint, offers: session.offers, status: session.status });
export function step(catalog, session, input, { validate = true } = {}) {
  if (validate) validateSession(catalog, session);
  requireThat(session.revision < 100000, 'Episode step limit reached');
  const action = normalizeAction(input), cost = costOf(catalog, action, session.item);
  const budget = session.initial.budget;
  if (budget !== null) for (const [name, amount] of Object.entries(cost)) requireThat((session.spent[name] ?? 0) + amount <= (budget[name] ?? 0), `Budget exhausted: ${name}`);
  const next = structuredClone(session), rng = random(session.rng_state);
  const { used, notes } = apply(catalog, next, action, rng);
  validateItem(catalog, next.item);
  for (const [name, amount] of Object.entries(cost)) next.spent[name] = (next.spent[name] ?? 0) + amount;
  next.revision++; next.rng_state = rng.state;
  next.history.push({ revision: next.revision, action, cost, rules: used, notes, before: stateHash(session), after: stateHash(next) });
  return next;
}
// Hinekora preview: the outcome of a previewable currency on a foreseeing item, without changing the session.
export function preview(catalog, session, input) {
  validateSession(catalog, session);
  const action = normalizeAction(input);
  requireThat(session.item.foreseeing && action.type === 'currency' && currency[action.name].previewable, 'Preview needs a Hinekora-locked item and a previewable currency');
  const next = step(catalog, { ...session, initial: { ...session.initial, budget: null } }, action, { validate: false });
  return next.item;
}
export function replay(catalog, saved) {
  validateSession(catalog, saved); let next = createSession(catalog, saved.initial);
  for (const event of saved.history) next = step(catalog, next, event.action, { validate: false });
  requireThat(digest(next) === digest(saved), 'Replay mismatch: item, RNG, ledger or history was altered'); return next;
}
export function describeItem(catalog, item) {
  const tags = itemTags(catalog, item);
  return { ...item, name: baseOf(catalog, item.base_id).name, item_class: baseOf(catalog, item.base_id).item_class,
    mods: item.mods.map(roll => { const mod = definition(catalog, roll), info = tierInfo(catalog, item, mod, tags);
      return { ...roll, side: mod.generation_type, group: mod.groups, type: mod.type, tier: info.tier, tiers_on_base: info.count, influence: influenceModOf(catalog, item, mod, tags),
        source_text: mod.text ?? null, stats: mod.stats.map((stat, i) => ({ id: stat.id, value: roll.values[i], range: [stat.min, stat.max] })) }; }),
    implicits: item.implicits.map(roll => ({ ...roll, source_text: definition(catalog, roll).text ?? null })) };
}
export function observe(catalog, session, { includeActions = true } = {}) {
  validateSession(catalog, session);
  const used = [...new Set(session.history.flatMap(event => event.rules))];
  return structuredClone({ model, contract: session.contract, revision: session.revision, status: session.status,
    item: describeItem(catalog, session.item), inventory: Object.fromEntries(Object.entries(session.inventory).map(([id, item]) => [id, { name: baseOf(catalog, item.base_id).name, rarity: item.rarity, influences: item.influences, mods: item.mods.map(roll => roll.id) }])),
    capacity: capacity(catalog, session.item), counts: count(catalog, session.item), spent: session.spent, budget: session.initial.budget,
    target_met: session.initial.target === null ? null : meets(catalog, session, session.initial.target),
    acquisition_cost_included: session.initial.start_cost !== null, imprint_available: session.imprint !== null, unveil_offers: session.offers,
    approximations_used: used.filter(id => !['data', 'official'].includes(rules[id].conf)).map(id => ({ id, confidence: rules[id].conf, statement: rules[id].s })),
    ...(includeActions && session.status === 'active' ? { actions: currencyActions.filter(name => !(currency[name].params ?? []).includes('assume')).map(name => {
      try { step(catalog, session, name, { validate: false }); return { action: name, legal: true }; }
      catch (error) { return { action: name, legal: false, reason: error.message }; }
    }) } : {}) });
}
