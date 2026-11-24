import test from 'node:test';
import assert from 'node:assert/strict';
import { masteryCandidates, pickMasteries } from '../scripts/design-generate.mjs';

test('mastery candidates come from groups of allocated nodes only', () => {
  const t = { nodes: new Map([
    [1, { id: 1, type: 'notable', group: 10 }], [2, { id: 2, type: 'mastery', group: 10, name: 'Life Mastery', mastery_effects: [{ effect: 100, stats: ['+50 to maximum Life'] }, { effect: 101, stats: ['10% increased maximum Life'] }] }],
    [3, { id: 3, type: 'mastery', group: 20, name: 'Mana Mastery', mastery_effects: [{ effect: 200, stats: ['Mana regen'] }] }],
    [4, { id: 4, type: 'mastery', group: 10, name: 'Asc', ascendancy: 'Occultist', mastery_effects: [{ effect: 300, stats: ['x'] }] }]]) };
  const c = masteryCandidates(t, new Set(['1']));
  assert.deepEqual(c.map(x => `${x.node}:${x.effect}`), ['2:100', '2:101']);
});

test('pick masteries greedily: one effect per node, each effect once, only positive value', () => {
  const rows = [{ node: 1, effect: 10, value: 5 }, { node: 1, effect: 11, value: 9 }, { node: 2, effect: 11, value: 8 }, { node: 2, effect: 12, value: 3 }, { node: 3, effect: 13, value: 0 }, { node: 4, effect: 14, value: 1 }];
  assert.deepEqual(pickMasteries(rows, 5).map(r => `${r.node}:${r.effect}`), ['1:11', '2:12', '4:14']);
  assert.equal(pickMasteries(rows, 1).length, 1);
});

test('node value ignores minion lines for player axes and weapon-limited lines for another weapon', async () => {
  const { nodeValue } = await import('../scripts/design-blueprint.mjs');
  const spell = [{ axis: 'spell_damage', pattern: /spell damage|cast speed/i, weight: 1 }, { axis: 'life', pattern: /maximum life/i, weight: 1.3 }];
  assert.equal(nodeValue(['Minions have 10% increased Attack and Cast Speed'], spell).value, 0);
  assert.equal(nodeValue(['Minions have 15% increased maximum Life'], spell).value, 0);
  assert.equal(nodeValue(['20% increased Spell Damage while wielding a Staff'], spell, { family: 'Sceptre' }).value, 0);
  assert.equal(nodeValue(['20% increased Spell Damage while wielding a Staff'], spell, { family: 'Staff' }).value, 1);
  assert.equal(nodeValue(['20% increased Spell Damage'], spell, { family: 'Sceptre' }).value, 1);
  assert.equal(nodeValue(['Minions have 15% increased maximum Life'], [{ axis: 'minion_life', pattern: /minions have .*maximum life/i, weight: 0.3 }]).value, 0.3);
});
