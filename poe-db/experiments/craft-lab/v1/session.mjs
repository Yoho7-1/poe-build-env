import { digest, baseOf } from './catalog.mjs';
import { keys, integer, random } from '../engine.mjs';
import { createItem, validateItem, definition, valuesOf, count, capacity, requireThat } from './state.mjs';
import { normalizeAction, costOf, apply, currencyActions } from './operations.mjs';

export const model = Object.freeze({ id: 'craft-lab-expanded-v1', game: 'poe1', patch: '3.30', status: 'experimental', complete: false, game_validated: false,
  assumptions: ['Affix counts: magic 1/2 equally, rare equipment 4/5/6 at 8:3:1, rare jewels 3/4 at 65:35; reference implementation, not a new 3.30 experiment.',
    'Integer stat ranges are sampled independently and uniformly. Weighted choices have 32-bit PRNG resolution.',
    'Counted metamods select protected non-fractured affixes uniformly for each action; interaction requires independent game validation.',
    'Unveil offers are weighted without replacement by group, and available sides of a Veiled Exalted Orb are equiprobable.',
    'Harvest/Beast resource costs and recipe unlocks must be explicitly supplied; ownership of the starting item is a scenario assumption.'] });

export function resources(value, label) {
  keys(value, Object.keys(value ?? {}), label);
  for (const [name, amount] of Object.entries(value)) requireThat(name.length > 0 && name.length <= 180 && !Object.hasOwn(Object.prototype, name) && !['__proto__', 'prototype'].includes(name) && Number.isSafeInteger(amount) && amount >= 0 && amount <= 1000000000, `Invalid ${label} amount: ${name}`);
  return value;
}
export function validateCondition(catalog, condition, depth = 0) {
  requireThat(depth <= 16, 'Condition nesting limit exceeded');
  keys(condition, ['all', 'any', 'not', 'mods', 'groups', 'stats', 'rarity', 'open_prefixes', 'open_suffixes', 'crafted', 'offers', 'corrupted'], 'condition');
  requireThat(Object.keys(condition).length > 0, 'Empty conditions are forbidden; omit when for an unconditional rule');
  for (const field of ['all', 'any']) if (condition[field] !== undefined) {
    requireThat(Array.isArray(condition[field]) && condition[field].length > 0 && condition[field].length <= 100, `Invalid condition ${field}`);
    condition[field].forEach(value => validateCondition(catalog, value, depth + 1));
  }
  if (condition.not !== undefined) validateCondition(catalog, condition.not, depth + 1);
  if (condition.rarity !== undefined) requireThat(['normal', 'magic', 'rare'].includes(condition.rarity), 'Invalid condition rarity');
  for (const field of ['mods', 'groups']) if (condition[field] !== undefined) {
    requireThat(Array.isArray(condition[field]) && condition[field].length > 0, `Invalid condition ${field}`);
    for (const id of condition[field]) requireThat(field === 'mods' ? catalog.mods.has(id) : catalog.groups.has(id), `Unknown ${field}: ${id}`);
  }
  for (const field of ['open_prefixes', 'open_suffixes']) if (condition[field] !== undefined) integer(condition[field], 0, 6, field);
  for (const field of ['crafted', 'offers', 'corrupted']) if (condition[field] !== undefined) requireThat(typeof condition[field] === 'boolean', `Invalid condition ${field}`);
  if (condition.stats !== undefined) {
    requireThat(Array.isArray(condition.stats) && condition.stats.length > 0 && condition.stats.length <= 100, 'Invalid stats condition');
    for (const stat of condition.stats) {
      keys(stat, ['id', 'min', 'max'], 'stat condition');
      requireThat(catalog.statIds.has(stat.id), `Unknown stat: ${stat.id}`);
      requireThat(stat.min !== undefined || stat.max !== undefined, 'Stat condition needs min or max');
      for (const field of ['min', 'max']) if (stat[field] !== undefined) requireThat(Number.isFinite(stat[field]), 'Stat threshold must be finite');
      if (stat.min !== undefined && stat.max !== undefined) requireThat(stat.min <= stat.max, 'Inverted stat range');
    }
  }
  return condition;
}
export function meets(catalog, session, condition) {
  const item = session.item, n = count(catalog, item), max = capacity(catalog, item);
  if (condition.all && !condition.all.every(value => meets(catalog, session, value))) return false;
  if (condition.any && !condition.any.some(value => meets(catalog, session, value))) return false;
  if (condition.not && meets(catalog, session, condition.not)) return false;
  if (condition.rarity !== undefined && condition.rarity !== item.rarity) return false;
  if (condition.mods && !condition.mods.every(id => item.mods.some(roll => roll.id === id))) return false;
  if (condition.groups && !condition.groups.every(group => item.mods.some(roll => definition(catalog, roll).groups.includes(group)))) return false;
  if (condition.open_prefixes !== undefined && max.prefix - n.prefix < condition.open_prefixes) return false;
  if (condition.open_suffixes !== undefined && max.suffix - n.suffix < condition.open_suffixes) return false;
  if (condition.crafted !== undefined && item.mods.some(roll => roll.kind === 'crafted') !== condition.crafted) return false;
  if (condition.offers !== undefined && (session.offers !== null) !== condition.offers) return false;
  if (condition.corrupted !== undefined && item.corrupted !== condition.corrupted) return false;
  const stats = valuesOf(catalog, item.mods);
  if (condition.stats && !condition.stats.every(stat => (stat.min === undefined || (stats.get(stat.id) ?? 0) >= stat.min) && (stat.max === undefined || (stats.get(stat.id) ?? 0) <= stat.max))) return false;
  return true;
}
export function createSession(catalog, input) {
  keys(input, ['item', 'seed', 'budget', 'target', 'unlocked_recipes', 'start_cost'], 'scenario');
  integer(input.seed, 0, 0xffffffff, 'seed');
  const rng = random(input.seed), item = createItem(catalog, input.item, rng);
  const initial = structuredClone({ ...input, budget: input.budget == null ? null : resources(input.budget, 'budget'),
    target: input.target == null ? null : validateCondition(catalog, input.target), unlocked_recipes: input.unlocked_recipes ?? null,
    start_cost: input.start_cost == null ? null : resources(input.start_cost, 'start cost') });
  if (initial.unlocked_recipes !== null && initial.unlocked_recipes !== 'all_assumed') {
    requireThat(Array.isArray(initial.unlocked_recipes) && initial.unlocked_recipes.every(id => catalog.recipes.has(id)), 'Invalid recipe unlock list');
  }
  const spent = structuredClone(initial.start_cost ?? {});
  if (initial.budget !== null) for (const [name, amount] of Object.entries(spent)) requireThat(amount <= (initial.budget[name] ?? 0), `Starting acquisition exceeds budget: ${name}`);
  return { schema_version: 2, model_id: model.id, contract: catalog.contract, initial, revision: 0, rng_state: rng.state, item, spent,
    imprint: null, offers: null, history: [] };
}
export function validateSession(catalog, session) {
  keys(session, ['schema_version', 'model_id', 'contract', 'initial', 'revision', 'rng_state', 'item', 'spent', 'imprint', 'offers', 'history'], 'session');
  requireThat(session.schema_version === 2 && session.model_id === model.id && session.contract === catalog.contract, 'Session version/contract mismatch; do not silently migrate');
  integer(session.revision, 0, 10000, 'revision'); integer(session.rng_state, 0, 0xffffffff, 'RNG state');
  requireThat(Array.isArray(session.history) && session.history.length === session.revision, 'History/revision mismatch');
  validateItem(catalog, session.item); resources(session.spent, 'spent');
  if (session.imprint !== null) validateItem(catalog, session.imprint);
  if (session.offers !== null) {
    keys(session.offers, ['placeholder', 'ids'], 'offers');
    requireThat(session.item.mods.some(roll => roll.id === session.offers.placeholder && roll.kind === 'veiled'), 'Missing unveil placeholder');
    requireThat(Array.isArray(session.offers.ids) && session.offers.ids.length >= 1 && session.offers.ids.length <= 3 && session.offers.ids.every(id => catalog.mods.get(id)?.domain === 'unveiled'), 'Invalid unveil offers');
  }
  return session;
}
const stateHash = session => digest({ item: session.item, imprint: session.imprint, offers: session.offers });
export function step(catalog, session, input) {
  validateSession(catalog, session);
  requireThat(session.revision < 10000, 'Episode step limit reached');
  const action = normalizeAction(input), cost = costOf(catalog, action);
  const budget = session.initial.budget;
  if (budget !== null) for (const [name, amount] of Object.entries(cost)) requireThat((session.spent[name] ?? 0) + amount <= (budget[name] ?? 0), `Budget exhausted: ${name}`);
  const next = structuredClone(session), rng = random(session.rng_state);
  apply(catalog, next, action, rng);
  validateItem(catalog, next.item);
  for (const [name, amount] of Object.entries(cost)) next.spent[name] = (next.spent[name] ?? 0) + amount;
  next.revision++; next.rng_state = rng.state;
  next.history.push({ revision: next.revision, action, cost, before: stateHash(session), after: stateHash(next) });
  return next;
}
export function replay(catalog, saved) {
  validateSession(catalog, saved); let next = createSession(catalog, saved.initial);
  for (const event of saved.history) next = step(catalog, next, event.action);
  requireThat(digest(next) === digest(saved), 'Replay mismatch: item, RNG, ledger or history was altered'); return next;
}
export function observe(catalog, session, { includeActions = true } = {}) {
  validateSession(catalog, session);
  return structuredClone({ model, contract: session.contract, revision: session.revision,
    item: { ...session.item, name: baseOf(catalog, session.item.base_id).name,
      mods: session.item.mods.map(roll => ({ ...roll, side: definition(catalog, roll).generation_type, source_text: definition(catalog, roll).text ?? null,
        stats: definition(catalog, roll).stats.map((stat, i) => ({ id: stat.id, value: roll.values[i] })) })) },
    capacity: capacity(catalog, session.item), counts: count(catalog, session.item), spent: session.spent, budget: session.initial.budget,
    target_met: session.initial.target === null ? null : meets(catalog, session, session.initial.target), target_scope: 'raw_explicit_stats',
    acquisition_cost_included: session.initial.start_cost !== null, imprint_available: session.imprint !== null, unveil_offers: session.offers,
    ...(includeActions ? { actions: currencyActions.map(name => {
      try { step(catalog, session, name); return { action: name, legal: true }; }
      catch (error) { return { action: name, legal: false, reason: error.message }; }
    }) } : {}) });
}
