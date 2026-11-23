import { createHash } from 'node:crypto';
import { keys, integer } from '../engine.mjs';
import { createSession, step, meets, validateCondition, model } from './session.mjs';
import { normalizeAction } from './actions.mjs';
import { requireThat } from './item.mjs';

export function train(catalog, exercise, { episodes = 100, seed = 1, max_steps = 100 } = {}) {
  keys(exercise, ['start', 'policy'], 'exercise');
  integer(episodes, 1, 10000, 'episodes'); integer(seed, 0, 0xffffffff, 'seed'); integer(max_steps, 1, 10000, 'max steps');
  requireThat(episodes * max_steps <= 1000000, 'Batch limit is one million total possible steps');
  requireThat(Array.isArray(exercise.policy) && exercise.policy.length > 0 && exercise.policy.length <= 100, 'Policy needs 1..100 rules');
  for (const rule of exercise.policy) { keys(rule, ['when', 'action', 'stop'], 'policy rule');
    requireThat(rule.stop === true ? rule.action === undefined : rule.stop === undefined && rule.action !== undefined, 'Policy rule must contain action or stop:true');
    if (rule.when !== undefined) validateCondition(catalog, rule.when);
    if (rule.action !== undefined) normalizeAction(rule.action);
  }
  const probe = createSession(catalog, { ...exercise.start, seed });
  requireThat(probe.initial.target !== null, 'Training needs an explicit target');
  const outcomes = { success: 0, step_limit: 0, policy_stopped: 0, no_rule: 0, action_rejected: 0, budget_exhausted: 0, destroyed: 0, unique_outcome: 0 };
  const rejected = new Map(), spends = new Map(), steps = [];
  for (let i = 0; i < episodes; i++) {
    const episodeSeed = createHash('sha256').update(`craft-lab-v2:${seed}:${i}`).digest().readUInt32LE(0);
    let session = createSession(catalog, { ...exercise.start, seed: episodeSeed }), outcome = 'step_limit';
    for (let j = 0; j < max_steps; j++) {
      if (meets(catalog, session, session.initial.target)) { outcome = 'success'; break; }
      const rule = exercise.policy.find(rule => rule.when === undefined || meets(catalog, session, rule.when));
      if (!rule) { outcome = 'no_rule'; break; }
      if (rule.stop) { outcome = 'policy_stopped'; break; }
      try { session = step(catalog, session, rule.action, { validate: false }); }
      catch (error) { outcome = error.message.startsWith('Budget exhausted:') ? 'budget_exhausted' : 'action_rejected'; rejected.set(error.message, (rejected.get(error.message) ?? 0) + 1); break; }
      if (session.status !== 'active') { outcome = session.status; break; }
    }
    if (meets(catalog, session, session.initial.target)) outcome = 'success';
    outcomes[outcome]++; steps.push(session.revision);
    for (const [resource, amount] of Object.entries(session.spent)) spends.set(resource, (spends.get(resource) ?? 0) + amount);
  }
  steps.sort((a, b) => a - b);
  const p = outcomes.success / episodes, z = 1.959963984540054, d = 1 + z * z / episodes;
  const c = (p + z * z / (2 * episodes)) / d, h = z * Math.sqrt(p * (1 - p) / episodes + z * z / (4 * episodes * episodes)) / d;
  return { model, contract: catalog.contract, seed, episodes, max_steps, outcomes, success_rate: p, wilson_95: [Math.max(0, c - h), Math.min(1, c + h)],
    steps: { mean: steps.reduce((a, b) => a + b, 0) / episodes, p50: steps[Math.ceil(episodes * 0.5) - 1], p95: steps[Math.ceil(episodes * 0.95) - 1] },
    total_spent: Object.fromEntries(spends), mean_spent_all_attempts: Object.fromEntries([...spends].map(([resource, amount]) => [resource, amount / episodes])),
    rejections: [...rejected].map(([reason, count]) => ({ reason, count })), acquisition_cost_included: probe.initial.start_cost !== null,
    interpretation: 'Conditional Monte Carlo under the declared model. Failed and censored episodes are included in spending. No market currency conversion or eventual-success cost is inferred.' };
}
