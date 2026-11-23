import { createHash } from 'node:crypto';
import { actions, createSession, step, keys, integer, targetResult, model } from './engine.mjs';

export function episodeSeed(seed, index) {
  return createHash('sha256').update(`craft-lab-v0:${seed}:${index}`).digest().readUInt32LE(0);
}

// A fixed action list is deliberately limited; an LLM can choose freely via step().
export function practice(catalog, exercise, { episodes = 100, seed = 1 } = {}) {
  keys(exercise, ['start', 'actions', 'stop_on_target'], 'exercise');
  integer(episodes, 1, 10000, 'episodes');
  integer(seed, 0, 0xffffffff, 'batch seed');
  if (!Array.isArray(exercise.actions) || !exercise.actions.length || exercise.actions.length > 1000 || exercise.actions.some(action => !actions.includes(action))) throw new Error('Exercise needs 1..1000 supported actions');
  if (exercise.stop_on_target !== undefined && typeof exercise.stop_on_target !== 'boolean') throw new Error('stop_on_target must be boolean');
  // Validate the entire starting scenario before starting any episodes.
  const initial = createSession(catalog, { ...exercise.start, seed });
  if (initial.initial.target === null) throw new Error('Practice requires an explicit target');
  const totals = Object.fromEntries(actions.map(action => [action, 0]));
  const outcomes = { success: 0, plan_exhausted: 0, action_rejected: 0 };
  const rejections = new Map();
  const steps = [];
  for (let index = 0; index < episodes; index++) {
    let session = createSession(catalog, { ...exercise.start, seed: episodeSeed(seed, index) });
    let rejected = false;
    for (const action of exercise.actions) {
      if (exercise.stop_on_target !== false && targetResult(session.item, session.initial.target).met) break;
      try { session = step(catalog, session, action); }
      catch (error) { rejected = true; rejections.set(error.message, (rejections.get(error.message) ?? 0) + 1); break; }
    }
    const met = targetResult(session.item, session.initial.target).met;
    outcomes[rejected ? 'action_rejected' : met ? 'success' : 'plan_exhausted']++;
    for (const [currency, amount] of Object.entries(session.spent)) totals[currency] += amount;
    steps.push(session.revision);
  }
  const p = outcomes.success / episodes, z = 1.959963984540054;
  const denominator = 1 + z * z / episodes;
  const center = (p + z * z / (2 * episodes)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / episodes + z * z / (4 * episodes * episodes)) / denominator;
  steps.sort((a, b) => a - b);
  return { model, contract: catalog.contract, batch_seed: seed, episodes, outcomes,
    success_rate: p, success_rate_wilson_95: [Math.max(0, center - half), Math.min(1, center + half)],
    steps_per_episode: { mean: steps.reduce((a, b) => a + b, 0) / episodes, p50: steps[Math.ceil(episodes * 0.5) - 1], p95: steps[Math.ceil(episodes * 0.95) - 1] },
    currency_spent_total: totals, currency_spent_mean_per_episode: Object.fromEntries(Object.entries(totals).map(([currency, amount]) => [currency, amount / episodes])),
    rejected_actions: [...rejections].map(([reason, count]) => ({ reason, count })),
    interpretation: 'Conditional simulation from the assumed starting item. Includes failures in spending. No market conversion, expected cost to eventual success, or independent game validation.' };
}
