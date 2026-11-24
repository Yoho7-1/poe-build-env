import test from 'node:test';
import assert from 'node:assert/strict';
import { objective, feasible, swapPairs } from '../scripts/design-optimize.mjs';

test('objective weighs DPS fully and defence by half in balanced mode', () => {
  const base = { dps: 100, ehp: 1000, maxhit: 500 };
  assert.equal(Math.round(objective({ dps: 110, ehp: 1000, maxhit: 500 }, base) * 1e6) / 1e6, 10);
  assert.equal(Math.round(objective({ dps: 100, ehp: 1100, maxhit: 550 }, base) * 1e6) / 1e6, 10);
  assert.equal(Math.round(objective({ dps: 120, ehp: 900, maxhit: 500 }, base, "dps")), 20);
});

test('feasibility keeps defence and mana sustain', () => {
  const start = { ehp: 1000, maxhit: 500, mana: 5 };
  assert.deepEqual(feasible({ ehp: 980, maxhit: 490, mana: 1 }, start), []);
  assert.equal(feasible({ ehp: 900, maxhit: 500, mana: 1 }, start).length, 1);
  assert.match(feasible({ ehp: 1000, maxhit: 500, mana: -2 }, start)[0], /mana/);
  assert.deepEqual(feasible({ ehp: 1000, maxhit: 500, mana: -2 }, { ...start, mana: -10 }), [], 'a build already in deficit is not blocked by it');
});

test('swap pairs fit freed points plus unspent and avoid paths through removed nodes', () => {
  const removals = [{ node: 1, points: 2, removed: [1, 2], loss_per_point: 0.1 }, { node: 3, points: 1, removed: [3], loss_per_point: 5 }];
  const additions = [{ node: 10, points: 2, path: [9, 10], gain_per_point: 3 }, { node: 11, points: 3, path: [2, 11], gain_per_point: 4 }, { node: 12, points: 1, path: [12], gain_per_point: -1 }];
  const pairs = swapPairs(removals, additions);
  assert.deepEqual(pairs.map(p => `${p.remove.node}->${p.add.node}`), ['1->10']);
  assert.deepEqual(swapPairs(removals, additions, { unspent: 2 }).map(p => `${p.remove.node}->${p.add.node}`), ['1->10', '3->11', '3->10']);
});
