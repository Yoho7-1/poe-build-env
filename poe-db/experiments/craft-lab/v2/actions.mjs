import { named, digest } from './catalog.mjs';
import { keys, random } from '../engine.mjs';
import { requireThat } from './item.mjs';
import { currency } from './actions/basic.mjs';
import { bench, benchCost, essence, fossils, fossilCost, harvest, harvestCost, beast, beastCost, unveil } from './actions/crafts.mjs';
import { awakener, recombinator, altar } from './actions/special.mjs';
import { ruleValue } from './rules.mjs';

export const currencyActions = Object.freeze(Object.keys(currency));
const FIELDS = {
  currency: ['type', 'name', 'omen', 'assume'], bench: ['type', 'recipe', 'assume'], essence: ['type', 'essence'], fossils: ['type', 'fossils', 'resonator'],
  harvest: ['type', 'method', 'tag', 'from', 'to', 'kind', 'cost'], beast: ['type', 'method', 'beast_level', 'aspect', 'level', 'count', 'influence'],
  unveil: ['type'], choose_unveil: ['type', 'index'], awakener: ['type', 'donor'], recombinator: ['type', 'other'], altar: ['type'],
};
// Non-currency actions are never previewed by Hinekora's Lock (rule lock.hinekora).
const HANDLERS = { bench, essence: ctx => { ctx.used.push('essence.class_mod', 'essence.normal_alch_rare_chaos', 'essence.level_cap', 'meta.blocks_essence_fossil', 'count.rare'); essence(ctx); },
  fossils: ctx => { ctx.used.push('fossil.stacking', 'fossil.resonator', 'meta.blocks_essence_fossil', 'harvest.no_strands'); fossils(ctx); }, harvest, beast, unveil, choose_unveil: unveil, awakener, recombinator, altar };
const STRANDS = { essence: 'essence', awakener: 'awakener' };

export function normalizeAction(input) {
  const action = typeof input === 'string' ? { type: 'currency', name: input } : structuredClone(input);
  requireThat(action && Object.hasOwn(FIELDS, action.type), `Unsupported action type: ${action?.type}`);
  keys(action, FIELDS[action.type], 'action');
  if (action.type === 'currency') {
    requireThat(Object.hasOwn(currency, action.name), `Unimplemented currency: ${action.name}`);
    for (const field of ['omen', 'assume']) if (action[field] !== undefined) requireThat((currency[action.name].params ?? []).includes(field), `${action.name} does not take ${field}`);
  }
  return action;
}
export function costOf(catalog, action, item) {
  if (action.type === 'currency') return { [action.name]: 1, ...(action.omen ? { [action.omen]: 1 } : {}) };
  if (action.type === 'bench') return benchCost(catalog, action, item);
  if (action.type === 'essence') return { [named(catalog.essences, action.essence, 'essence').name]: 1 };
  if (action.type === 'fossils') return fossilCost(catalog, action);
  if (action.type === 'harvest') return harvestCost(catalog, action);
  if (action.type === 'beast') return beastCost(action);
  if (action.type === 'awakener') return { "Awakener's Orb": 1 };
  if (action.type === 'altar') return {};
  return {};
}
export function rulesOf(action) {
  if (action.type === 'currency') return [...currency[action.name].rules];
  return [];
}
// Applies one action to a cloned session. Returns the rule ids used and notes.
export function apply(catalog, session, action, rng) {
  requireThat(session.status === 'active', `Episode ended: ${session.status}`);
  requireThat(!session.offers || action.type === 'choose_unveil', 'Choose an unveiled modifier before another action');
  const entry = action.type === 'currency' ? currency[action.name] : null;
  const before = structuredClone(session.item);
  const locked = session.item.foreseeing;
  // Under a Lock a previewable currency outcome depends only on the Lock seed and this currency (preview == result).
  const actionRng = locked && entry?.previewable ? random(parseInt(digest({ seed: locked.seed, name: action.name, omen: action.omen ?? null, assume: action.assume ?? null }).slice(0, 8), 16)) : rng;
  const ctx = { catalog, session, item: session.item, action, rng: actionRng, used: rulesOf(action), notes: [], keep_foresight: false };
  if (entry) entry.apply(ctx); else HANDLERS[action.type](ctx);
  const item = session.item;
  if (session.status === 'active') {
    const key = entry ? entry.strands : STRANDS[action.type];
    if (key && before.memory_strands > 0) {
      const ceiling = typeof key === 'function' ? key(before) : ruleValue('strands.spend')[key];
      const spent = actionRng.int(ceiling + 1); item.memory_strands = Math.max(0, item.memory_strands - spent);
      ctx.used.push('strands.spend'); ctx.notes.push(`Memory Strands spent: ${Math.min(spent, before.memory_strands)}`);
    }
    if (!ctx.keep_foresight) item.foreseeing = null;
    if (locked) ctx.used.push('lock.hinekora');
  }
  ctx.used.push('pool.first_match', 'pool.values_uniform');
  return { used: [...new Set(ctx.used)], notes: ctx.notes };
}
