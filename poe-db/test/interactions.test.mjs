import test from 'node:test';
import assert from 'node:assert/strict';
import { combinations, combine, interactionOf, classifyInteraction, pickMetric, selectComponents } from '../scripts/analysis-interactions.mjs';
import { planConfigAblation, mergeChanges, planAblation } from '../scripts/analysis-ablation.mjs';

test('interaction = joint ratio over product of single ratios', () => {
  // Independent multipliers: 0.7 * 0.8 = 0.56 -> 0
  assert.equal(interactionOf([0.7, 0.8], 0.56).interaction, 0);
  // Synergy: joint loss larger than independent product
  const syn = interactionOf([0.8, 0.8], 0.5);
  assert.equal(syn.expected, 0.64); assert.equal(classifyInteraction(syn), 'synergy');
  // Overlap: two sources of the same capped stat, losing both costs about as much as one
  assert.equal(classifyInteraction(interactionOf([0.8, 0.8], 0.78)), 'overlap');
  assert.equal(classifyInteraction(interactionOf([0.9, 0.9], 0.81 * 1.01)), 'independent');
  assert.equal(interactionOf([0, 0.5], 0).interaction, null);
  assert.equal(interactionOf([null, 0.5], 0.4), null);
  assert.equal(classifyInteraction(null), 'undefined');
});

test('the judged metric is the one the components move', () => {
  const per = { dps: { expected: 1, interaction: 0 }, ehp: { expected: 0.6, interaction: 0.2 }, maxhit: { expected: 0.9, interaction: 0 } };
  assert.equal(pickMetric(per), 'ehp');
  assert.equal(pickMetric({ dps: { expected: 0.995, interaction: 0 } }), null);
});

test('combinations and combined changes', () => {
  assert.deepEqual(combinations([1, 2, 3], 2), [[1, 2], [1, 3], [2, 3]]);
  assert.equal(combinations([1, 2, 3, 4], 3).length, 4);
  const merged = combine([{ changes: { skills: { groups: [{ group: 1, remove_gems: [2] }] } } }, { changes: { skills: { groups: [{ group: 1, remove_gems: [4] }] } } },
    { changes: { config: { a: false } } }, { changes: { custom_mods: 'x' } }], { custom_mods: 'base' });
  assert.deepEqual(merged.skills.groups, [{ group: 1, remove_gems: [4, 2] }]);
  assert.deepEqual(merged.config, { a: false });
  assert.equal(merged.custom_mods, 'base\nx');
  assert.deepEqual(mergeChanges({ config: { a: 1 } }, { config: { b: 2 } }).config, { a: 1, b: 2 });
});

test('selection takes the strongest core/major rows with their removal changes', () => {
  const planned = [{ id: 'a', changes: { x: 1 } }, { id: 'b', changes: { x: 2 } }, { id: 'c', changes: { x: 3 } }, { id: 'node:5', changes: { tree: {} } }];
  const report = { rows: [
    { id: 'a', tier: 'core', offense_loss_pct: 30, label: 'A', kind: 'items' }, { id: 'b', tier: 'major', defense_loss_pct: 40, label: 'B', kind: 'items' },
    { id: 'c', tier: 'minor', offense_loss_pct: 5, label: 'C', kind: 'items' }, { id: 'node:5', tier: 'core', offense_loss_pct: 50, kind: 'tree', label: 'N', target: { node: 5 } }] };
  assert.deepEqual(selectComponents(report, planned, { top: 5 }).map(c => c.id), ['node:5', 'b', 'a']);
  assert.deepEqual(selectComponents(report, planned, { top: 2 }).map(c => c.changes), [{ tree: {} }, { x: 2 }]);
});

test('config ablation resets only build assumptions that differ from the default', () => {
  const config = { conditionEnemyChilled: true, usePowerCharges: true, overridePowerCharges: 2, pantheonMajorGod: 'Solaris', enemyIsBoss: 'Boss', enemyLevel: 84,
    buffOnslaught: false, multiplierKilledRecently: 0, raiseSpectreEnableBuffs: true, resistancePenalty: -60 };
  const defaults = { pantheonMajorGod: 'None', enemyIsBoss: 'Pinnacle', raiseSpectreEnableBuffs: true, resistancePenalty: -60 };
  const plan = planConfigAblation(config, defaults);
  assert.deepEqual(plan.map(p => p.id), ['config:conditionEnemyChilled', 'config:overridePowerCharges', 'config:pantheonMajorGod', 'config:usePowerCharges']);
  assert.deepEqual(plan.find(p => p.id === 'config:pantheonMajorGod').target, { key: 'pantheonMajorGod', value: 'Solaris', reset: 'None' });
  assert.equal(plan.find(p => p.id === 'config:overridePowerCharges').target.reset, 0);
  const build = { main_socket_group: 1, groups: [], allocated: new Set() };
  const { components, skipped } = planAblation({ build, kinds: ['config'], isSupport: () => false, config, defaults, base: { config: { enemyIsBoss: 'Pinnacle' } } });
  assert.deepEqual(components[0].changes, { config: { enemyIsBoss: 'Pinnacle', conditionEnemyChilled: false } });
  assert.equal(planAblation({ build, kinds: ['config'], isSupport: () => false }).skipped[0].id, 'config');
  assert.equal(skipped.length, 0);
});
