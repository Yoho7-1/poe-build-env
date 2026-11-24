import test from 'node:test';
import assert from 'node:assert/strict';
import { componentsFromItem, makeVariant, priceVariant, selectInBudget, gainOf } from '../scripts/design-variants.mjs';
import { PRIOR_RULES, keystonePlan, trimOrder } from '../scripts/design-priors.mjs';

const priced = (id, { chaos = null, est = null, unknown = false, gain = 10, key = id, required = false, free = false }) => ({
  ...makeVariant({ id, source: 't', resource: { kind: free ? 'points' : 'slot', key }, gain: gainOf(gain, 0), required }),
  price: { cost_class: free ? 'none' : unknown ? 'unknown' : est != null ? 'estimated' : 'exact', exact_chaos: chaos, estimated_chaos: est, estimated_range: est != null ? [est / 2, est * 2] : null, unknown: unknown ? [`${id}: no data`] : [], quotes: [] },
});

test('variant model: item parsing keeps eldritch/anoint unknown and never prices them as free', () => {
  const text = 'Rarity: RARE\nX\nLion Pelt\nItem Level: 84\nImplicits: 2\n{exarch}11% increased Cast Speed\n{eater}24% increased Spell Damage\n+107 to maximum Life\n+39% to Fire Resistance\n{crafted}Allocates Revenge of the Hunted';
  const comps = componentsFromItem('Helmet', text);
  assert.deepEqual(comps.map(c => c.kind), ['rare', 'eldritch', 'anoint']);
  assert.equal(comps[0].base, 'Lion Pelt');
  assert.equal(comps[0].affixes.count, 2);
  const v = priceVariant(makeVariant({ id: 'h', resource: { kind: 'slot', key: 'slot:Helmet' }, components: comps.slice(1) }), null);
  assert.equal(v.price.cost_class, 'unknown');
  assert.equal(v.price.exact_chaos, null);
  assert.equal(v.price.unknown.length, 2);
});

test('budget selection: gain per chaos, exclusive resource, unknown listed, next tier; no budget is explicitly unpriced', () => {
  const vs = [priced('base', { chaos: 100, required: true, gain: 0 }), priced('a', { chaos: 50, gain: 10, key: 'slot:Ring' }), priced('a2', { chaos: 400, gain: 12, key: 'slot:Ring' }),
    priced('b', { est: 200, gain: 30 }), priced('c', { chaos: 900, gain: 40 }), priced('u', { unknown: true, gain: 50 }), priced('m', { free: true, gain: 5 })];
  const s = selectInBudget(vs, { budget: { amount: 400, currency: 'chaos' } });
  assert.equal(s.mode, 'budget');
  assert.deepEqual(s.chosen.map(x => x.id).sort(), ['a', 'b', 'm']);
  assert.equal(s.spent.exact_chaos, 150);
  assert.equal(s.spent.estimated_chaos, 200);
  assert.deepEqual(s.needs_price.map(x => x.id), ['u']);
  assert.equal(s.next_tier.adds[0].id, 'c');
  assert.equal(s.next_tier.budget_chaos, 1250);
  const n = selectInBudget(vs, {});
  assert.equal(n.mode, 'unpriced_comparison');
  assert.equal(n.budget_applied, false);
  assert.equal(n.chosen[0].id, 'u');
});

test('priors: prune or let through keystones by context, order belt last in leech builds', () => {
  const priors = Object.entries(PRIOR_RULES).map(([id, r]) => ({ id, ...r, active: true }));
  const low = keystonePlan(priors, { family: 'spell', str: 300, hit: true, minion: false });
  assert.deepEqual(low.map(k => `${k.node}:${k.action}`), ['Iron Will:prune', 'Mind Over Matter:probe']);
  assert.deepEqual(keystonePlan(priors, { family: 'spell', str: 900, hit: false, minion: false }).map(k => k.action), ['probe', 'prune']);
  assert.deepEqual(keystonePlan(priors.map(p => ({ ...p, active: false })), { family: 'spell', str: 900, hit: true }), []);
  assert.deepEqual(trimOrder(priors, ['Belt', 'Helmet', 'Ring 1'], { leech: true }).order, ['Helmet', 'Ring 1', 'Belt']);
});
