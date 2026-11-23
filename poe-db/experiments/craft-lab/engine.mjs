import { digest, findBase } from './catalog.mjs';

export const model = Object.freeze({
  id: 'ordinary-affixes-v0', game: 'poe1', patch: '3.30', status: 'experimental',
  game_validated: false, acquisition_verified: false,
  assumptions: [
    'Single added modifier is sampled proportionally to eligible spawn weight times the first matching generation multiplier.',
    'Annulment samples existing explicit modifiers uniformly.',
    'Each numeric stat is sampled uniformly and independently over its source integer range; server correlations are unverified.',
    'Initial explicit modifiers and base ownership are scenario assumptions, not a demonstrated acquisition process.',
  ],
  unsupported: [
    'Transmutation/Alteration/Alchemy/Chaos and other random-affix-count operations',
    'Essences, Fossils, Harvest, Bestiary, bench crafts and metamods',
    'Fractured, influenced, synthesised, corrupted, mirrored or otherwise special items',
    'Catalysts, quality effects, sockets, implicit rolling, PoB export and trade acquisition',
  ],
});
export const actions = Object.freeze(['Orb of Augmentation', 'Regal Orb', 'Exalted Orb', 'Orb of Annulment', 'Orb of Scouring', 'Divine Orb']);

export function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
}
export function integer(value, low, high, label) {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new Error(`Invalid ${label}: expected integer ${low}..${high}`);
  return value;
}
function requireThat(condition, message) { if (!condition) throw new Error(message); }
const affix = mod => mod?.domain === 'item' && ['prefix', 'suffix'].includes(mod.generation_type) && !mod.is_essence_only;
export const firstWeight = (weights, tags, fallback) => weights.find(entry => tags.has(entry.tag))?.weight ?? fallback;

// Mulberry32 with rejection sampling for unbiased bounded integers. Seed 0 is valid.
export function random(seed) {
  let state = integer(seed, 0, 0xffffffff, 'RNG state');
  return {
    get state() { return state; },
    int(count) {
      integer(count, 1, 0x100000000, 'random bound');
      const ceiling = Math.floor(0x100000000 / count) * count;
      let result;
      do {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        result = (t ^ (t >>> 14)) >>> 0;
      } while (result >= ceiling);
      return result % count;
    },
  };
}

function used(catalog, item) { return item.mods.map(roll => catalog.mods.get(roll.id)); }
export function counts(catalog, item) {
  const definitions = used(catalog, item);
  return { prefix: definitions.filter(mod => mod.generation_type === 'prefix').length, suffix: definitions.filter(mod => mod.generation_type === 'suffix').length };
}
function context(catalog, item) {
  const base = findBase(catalog, item.base_id);
  const definitions = used(catalog, item);
  const implicitMods = base.implicits.map(id => {
    const mod = catalog.mods.get(id);
    requireThat(mod, `Missing implicit definition: ${id}`);
    return mod;
  });
  const tags = new Set([...base.tags, ...implicitMods.flatMap(mod => mod.adds_tags), ...definitions.flatMap(mod => mod.adds_tags)]);
  return { base, tags, groups: new Set(definitions.flatMap(mod => mod.groups)), counts: counts(catalog, item) };
}

export function validateItem(catalog, item) {
  keys(item, ['base_id', 'item_level', 'rarity', 'mods'], 'item');
  findBase(catalog, item.base_id);
  integer(item.item_level, 1, 100, 'item level');
  requireThat(['normal', 'magic', 'rare'].includes(item.rarity), 'Rarity must be normal/magic/rare');
  requireThat(Array.isArray(item.mods) && item.mods.length <= 6, 'mods must be an array of at most six modifiers');
  const ids = new Set(), groups = new Set();
  const base = findBase(catalog, item.base_id);
  const baseTags = new Set([...base.tags, ...base.implicits.flatMap(id => catalog.mods.get(id)?.adds_tags ?? [])]);
  for (const roll of item.mods) {
    keys(roll, ['id', 'stats'], 'modifier');
    const mod = catalog.mods.get(roll.id);
    requireThat(affix(mod), `Unsupported ordinary explicit modifier: ${roll.id}`);
    requireThat(mod.required_level <= item.item_level, `Item level too low for ${roll.id}`);
    requireThat(firstWeight(mod.spawn_weights, baseTags, 0) > 0, `Modifier not eligible on base: ${roll.id}`);
    requireThat(!ids.has(roll.id) && !mod.groups.some(group => groups.has(group)), `Conflicting modifier groups: ${roll.id}`);
    ids.add(roll.id); mod.groups.forEach(group => groups.add(group));
    requireThat(Array.isArray(roll.stats) && roll.stats.length === mod.stats.length, `Incomplete stat rolls: ${roll.id}`);
    for (let i = 0; i < mod.stats.length; i++) {
      keys(roll.stats[i], ['id', 'value'], 'stat roll');
      const source = mod.stats[i];
      requireThat(roll.stats[i].id === source.id, `Stat identity mismatch: ${roll.id}`);
      integer(roll.stats[i].value, source.min, source.max, `stat ${source.id}`);
    }
  }
  const n = counts(catalog, item);
  const limit = item.rarity === 'magic' ? 1 : 3;
  requireThat(n.prefix <= limit && n.suffix <= limit, 'Affix capacity exceeded');
  requireThat(item.rarity !== 'normal' || !item.mods.length, 'Normal item cannot have explicit modifiers');
  return item;
}

export function pool(catalog, item, { rarity = item.rarity } = {}) {
  validateItem(catalog, item);
  requireThat(['magic', 'rare'].includes(rarity), 'Addition pool requires magic or rare rarity');
  const ctx = context(catalog, item), limit = rarity === 'magic' ? 1 : 3;
  const rows = [];
  for (const mod of catalog.ordinaryMods ?? catalog.mods.values()) {
    if (!affix(mod) || mod.required_level > item.item_level || ctx.counts[mod.generation_type] >= limit || mod.groups.some(group => ctx.groups.has(group))) continue;
    const spawn = firstWeight(mod.spawn_weights, ctx.tags, 0);
    const multiplier = firstWeight(mod.generation_weights, ctx.tags, 100);
    const units = spawn * multiplier; // All weights use the same denominator 100.
    if (units <= 0) continue;
    integer(units, 1, Number.MAX_SAFE_INTEGER, `weight ${mod.id}`);
    rows.push({ id: mod.id, generation_type: mod.generation_type, text: mod.text ?? null, groups: mod.groups,
      required_level: mod.required_level, spawn_weight: spawn, generation_multiplier: multiplier, weight_units: units });
  }
  const total = rows.reduce((sum, row) => sum + row.weight_units, 0);
  integer(total, 0, 0x100000000, 'pool weight');
  return { rows, total_weight_units: total, weight_denominator: 100, tags: [...ctx.tags].sort() };
}

function rollMod(mod, rng) {
  return { id: mod.id, stats: mod.stats.map(stat => ({ id: stat.id, value: stat.min + rng.int(stat.max - stat.min + 1) })) };
}
function add(catalog, item, rng) {
  const candidates = pool(catalog, item);
  requireThat(candidates.rows.length, 'No eligible modifier');
  let ticket = rng.int(candidates.total_weight_units);
  const choice = candidates.rows.find(row => { ticket -= row.weight_units; return ticket < 0; });
  item.mods.push(rollMod(catalog.mods.get(choice.id), rng));
  return { added_mod: choice.id, weight_units: choice.weight_units, total_weight_units: candidates.total_weight_units };
}

export function validateBudget(budget) {
  keys(budget, actions, 'budget');
  for (const [currency, amount] of Object.entries(budget)) integer(amount, 0, 1000000000, `budget ${currency}`);
  return budget;
}
export function validateTarget(catalog, target) {
  keys(target, ['all_mods', 'any_mods', 'stats', 'rarity'], 'target');
  requireThat(Object.keys(target).length > 0, 'Target cannot be empty');
  if (target.rarity !== undefined) requireThat(['normal', 'magic', 'rare'].includes(target.rarity), 'Invalid target rarity');
  for (const key of ['all_mods', 'any_mods']) if (target[key] !== undefined) {
    requireThat(Array.isArray(target[key]) && target[key].length > 0 && target[key].length <= 100, `Invalid target ${key}`);
    for (const id of target[key]) requireThat(affix(catalog.mods.get(id)), `Unknown target modifier: ${id}`);
  }
  if (target.stats !== undefined) {
    requireThat(Array.isArray(target.stats) && target.stats.length > 0 && target.stats.length <= 100, 'Invalid target stats');
    const known = catalog.statIds ?? new Set([...catalog.mods.values()].filter(affix).flatMap(mod => mod.stats.map(stat => stat.id)));
    for (const condition of target.stats) {
      keys(condition, ['id', 'min'], 'target stat');
      requireThat(known.has(condition.id) && Number.isFinite(condition.min), `Invalid target stat: ${condition.id}`);
    }
  }
  return target;
}
export function targetResult(item, target) {
  if (target === null) return { met: null, checks: [], scope: 'explicit_stats_only' };
  const ids = new Set(item.mods.map(mod => mod.id)), stats = new Map();
  for (const roll of item.mods) for (const stat of roll.stats) stats.set(stat.id, (stats.get(stat.id) ?? 0) + stat.value);
  const checks = [];
  if (target.rarity !== undefined) checks.push({ kind: 'rarity', met: item.rarity === target.rarity });
  for (const id of target.all_mods ?? []) checks.push({ kind: 'mod', id, met: ids.has(id) });
  if (target.any_mods) checks.push({ kind: 'any_mods', met: target.any_mods.some(id => ids.has(id)) });
  for (const condition of target.stats ?? []) checks.push({ kind: 'stat', ...condition, actual: stats.get(condition.id) ?? 0, met: (stats.get(condition.id) ?? 0) >= condition.min });
  return { met: checks.every(check => check.met), checks, scope: 'explicit_stats_only' };
}

export function createSession(catalog, input) {
  keys(input, ['base', 'item_level', 'rarity', 'mods', 'seed', 'budget', 'target'], 'scenario');
  const base = findBase(catalog, input.base);
  integer(input.item_level, 1, 100, 'item level');
  requireThat(['normal', 'magic', 'rare'].includes(input.rarity), 'Explicit initial rarity required');
  integer(input.seed, 0, 0xffffffff, 'seed');
  const rng = random(input.seed);
  const modIds = input.mods ?? [];
  requireThat(Array.isArray(modIds) && modIds.length <= 6, 'Initial mods must be an array of at most six IDs');
  const mods = modIds.map(id => { const mod = catalog.mods.get(id); requireThat(affix(mod), `Unsupported initial modifier: ${id}`); return rollMod(mod, rng); });
  const budget = input.budget == null ? null : validateBudget(input.budget);
  const target = input.target == null ? null : validateTarget(catalog, input.target);
  const initial = structuredClone({ ...input, base: base.id, mods: modIds, budget, target });
  const item = validateItem(catalog, { base_id: base.id, item_level: input.item_level, rarity: input.rarity, mods });
  return { schema_version: 1, model_id: model.id, contract: catalog.contract, initial, revision: 0, item, rng_state: rng.state, spent: {}, history: [] };
}

function validateSession(catalog, session) {
  keys(session, ['schema_version', 'model_id', 'contract', 'initial', 'revision', 'item', 'rng_state', 'spent', 'history'], 'session');
  requireThat(session.schema_version === 1 && session.model_id === model.id && session.contract === catalog.contract, 'Simulation contract mismatch; replay with the original code/data');
  integer(session.revision, 0, 1000, 'revision');
  requireThat(Array.isArray(session.history) && session.history.length === session.revision, 'History/revision mismatch');
  integer(session.rng_state, 0, 0xffffffff, 'RNG state');
  validateItem(catalog, session.item);
  validateBudget(session.spent);
  if (session.initial.budget !== null) validateBudget(session.initial.budget);
  if (session.initial.target !== null) validateTarget(catalog, session.initial.target);
}

export function step(catalog, session, action) {
  validateSession(catalog, session);
  requireThat(actions.includes(action), `Unsupported action: ${action}`);
  requireThat(session.revision < 1000, 'Episode step limit reached');
  const spent = session.spent[action] ?? 0;
  if (session.initial.budget !== null) requireThat(spent < (session.initial.budget[action] ?? 0), `Currency budget exhausted: ${action}`);
  const next = structuredClone(session), item = next.item, rng = random(next.rng_state);
  let effect = {};
  if (action === 'Orb of Augmentation') {
    requireThat(item.rarity === 'magic' && item.mods.length < 2, 'Augmentation requires a magic item with an open affix');
    effect = add(catalog, item, rng);
  } else if (action === 'Regal Orb') {
    requireThat(item.rarity === 'magic', 'Regal requires a magic item');
    item.rarity = 'rare'; effect = add(catalog, item, rng);
  } else if (action === 'Exalted Orb') {
    requireThat(item.rarity === 'rare' && item.mods.length < 6, 'Exalted requires a rare item with an open affix');
    effect = add(catalog, item, rng);
  } else if (action === 'Orb of Annulment') {
    requireThat(['magic', 'rare'].includes(item.rarity) && item.mods.length > 0, 'Annulment requires a nonempty magic or rare item');
    const [removed] = item.mods.splice(rng.int(item.mods.length), 1);
    effect = { removed_mod: removed.id };
  } else if (action === 'Orb of Scouring') {
    requireThat(['magic', 'rare'].includes(item.rarity), 'Scouring requires a magic or rare item');
    effect = { removed_mods: item.mods.map(mod => mod.id) };
    item.mods = []; item.rarity = 'normal';
  } else if (action === 'Divine Orb') {
    requireThat(['magic', 'rare'].includes(item.rarity) && item.mods.some(roll => catalog.mods.get(roll.id).stats.some(stat => stat.min < stat.max)), 'Divine requires a variable explicit stat on a magic or rare item');
    item.mods = item.mods.map(roll => rollMod(catalog.mods.get(roll.id), rng));
    effect = { rerolled_mods: item.mods.map(mod => mod.id) };
  }
  validateItem(catalog, item);
  next.rng_state = rng.state; next.revision++;
  next.spent[action] = spent + 1;
  next.history.push({ revision: next.revision, action, before_sha256: digest(session.item), after_sha256: digest(item), effect });
  return next;
}

export function observe(catalog, session) {
  validateSession(catalog, session);
  const legal = actions.map(action => {
    try { step(catalog, session, action); return { action, legal: true }; }
    catch (error) { return { action, legal: false, reason: error.message }; }
  });
  return structuredClone({ model, contract: session.contract, revision: session.revision,
    item: { ...session.item, base_name: findBase(catalog, session.item.base_id).name,
      mods: session.item.mods.map(roll => ({ ...roll, affix: catalog.mods.get(roll.id).generation_type, source_text: catalog.mods.get(roll.id).text ?? null })) },
    counts: counts(catalog, session.item), spent: session.spent, budget: session.initial.budget,
    target: targetResult(session.item, session.initial.target), actions: legal });
}

export function replay(catalog, saved) {
  validateSession(catalog, saved);
  let result = createSession(catalog, saved.initial);
  for (const event of saved.history) result = step(catalog, result, event.action);
  requireThat(digest(result) === digest(saved), 'Replay mismatch: state, rolls, spend or history were changed');
  return result;
}
