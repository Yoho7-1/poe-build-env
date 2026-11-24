import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDisjoint, combinationVariants, treeChanges, valuesFromDeltas, chooseUpgrade, acceptApplied } from '../scripts/design-optimize.mjs';

const swap = (rem, removed, rp, add, path, ap, gain) => ({ remove: { node: rem, removed, points: rp }, add: { node: add, path, points: ap }, gain });

test('disjoint swaps: no shared removed or path nodes, points within freed + unspent', () => {
  const scored = [
    swap(1, [1, 2], 2, 10, [9, 10], 2, 5),
    swap(1, [1], 1, 11, [11], 1, 4),        // same removal as the first
    swap(3, [3], 1, 12, [9, 12], 2, 3),     // path shares node 9 with the first
    swap(4, [4], 1, 13, [2, 13], 1, 2.5),   // path through a node removed by the first
    swap(5, [5], 1, 14, [14], 1, 2),
    swap(6, [6], 1, 15, [15, 16], 3, 1.5)   // needs 3 points, only 1 freed
  ];
  assert.deepEqual(pickDisjoint(scored).map(s => s.add.node), [10, 14]);
  assert.deepEqual(pickDisjoint(scored, { unspent: 2, maxSwaps: 5 }).map(s => s.add.node), [10, 14, 15]);
  assert.deepEqual(pickDisjoint(scored, { maxSwaps: 1 }).map(s => s.add.node), [10]);
});

test('combination variants are prefixes of the chosen swaps; tree changes list every edit', () => {
  const chosen = [swap(1, [1, 2], 2, 10, [9, 10], 2, 5), swap(5, [5], 1, 14, [14], 1, 2), swap(7, [7], 1, 17, [17], 1, 1)];
  chosen[0].remove.with_dependents = true;
  const v = combinationVariants(chosen);
  assert.deepEqual(v.map(x => x.id), ['cb:2', 'cb:3']);
  assert.deepEqual(v[0], { id: 'cb:2', remove_nodes: [{ node: 1, with_dependents: true }, { node: 5 }], add_nodes: [10, 14] });
  assert.deepEqual(treeChanges(chosen), { tree: { deallocate: [1, 5, 7], allocate: [10, 14, 17] } });
  assert.deepEqual(combinationVariants(chosen.slice(0, 1)), []);
});

test('upgrade rows: deltas scaled onto the base, best feasible candidate by objective', () => {
  const base = { dps: 1000, ehp: 5000, maxhit: 2000, mana: 3 }, start = base;
  const d = (dps, ehp, maxhit = 2000, mana = 3) => ({ dps: { before: 900, after: 900 * dps / 1000 }, ehp: { before: 5000, after: ehp }, maxhit: { before: 2000, after: maxhit }, mana_sustain: { before: 3, after: mana } });
  assert.deepEqual(valuesFromDeltas(base, d(1100, 5000)), { dps: 1100, ehp: 5000, maxhit: 2000, mana: 3 });
  assert.equal(valuesFromDeltas(base, { dps: { before: 900, after: null } }).dps, 0, 'a vanished DPS counts as zero');
  const rows = [
    { id: 'a', label: 'big dps, low ehp', deltas: d(1500, 4000) },
    { id: 'b', label: 'mana deficit', deltas: d(1300, 5000, 2000, -1) },
    { id: 'c', label: 'requirement', deltas: d(1250, 5000), new_warnings: ['You do not meet the Strength requirement'] },
    { id: 'd', label: 'expensive', deltas: d(1200, 5000), price: { chaos: 500 } },
    { id: 'e', label: 'ok', deltas: d(1100, 5100) },
    { id: 'anoint-control', label: 'control', deltas: d(1150, 5000) },
    { id: 'f', label: 'custom mods', deltas: d(1180, 5000) }
  ];
  const changesById = new Map(['a', 'b', 'c', 'd', 'e', 'anoint-control'].map(id => [id, { replace_items: [{ slot: 'Amulet', text: id }] }]).concat([['f', { custom_mods: 'Allocates X' }]]));
  const pick = chooseUpgrade(rows, { base, start, maxChaos: 100, changesById });
  assert.equal(pick.best.row.id, 'e');
  assert.equal(pick.top_blocked.id, 'a');
  assert.match(pick.top_blocked.blocked[0], /EHP/);
  assert.equal(chooseUpgrade(rows.slice(4, 5), { base, start, requirePrice: true, changesById }).best, null, 'uniques need an observed price');
  const trig = [{ ...rows[4], generated: { support: 'Cast when Stunned' } }];
  assert.equal(chooseUpgrade(trig, { base, start, changesById, blockedSupports: new Set(['Cast when Stunned']) }).best, null, 'trigger supports are blocked');
  assert.equal(chooseUpgrade(trig, { base, start, changesById }).best.row.id, 'e');
  const awakened = [{ ...rows[4], generated: { support: 'Awakened Empower', exceptional: true }, price: { chaos: 50 } }];
  assert.equal(chooseUpgrade(awakened, { base, start, changesById }).best, null, 'exceptional gems need a price limit');
  assert.equal(chooseUpgrade(awakened, { base, start, changesById, maxChaos: 100 }).best.row.id, 'e');
});

test('applied edit is re-checked: budget, new unmet requirements, gain, constraints', () => {
  const base = { dps: 1000, ehp: 5000, maxhit: 2000, mana: 3 };
  const ok = { v: { dps: 1100, ehp: 5000, maxhit: 2000, mana: 3 }, base, start: base, run: { budget: { passive_used: 100, passive_available: 100 }, engine_warnings: ['old'] }, baseRun: { engine_warnings: ['old'] } };
  assert.deepEqual(acceptApplied(ok), []);
  assert.equal(acceptApplied({ ...ok, run: { budget: { passive_used: 101, passive_available: 100 } } }).length, 1);
  assert.match(acceptApplied({ ...ok, run: { engine_warnings: ['You do not meet the Intelligence requirement'] } })[0], /new warning/);
  assert.match(acceptApplied({ ...ok, v: base })[0], /no gain/);
  assert.ok(acceptApplied({ ...ok, v: { ...ok.v, dps: 2000, maxhit: 1900 } }).some(w => /max hit/.test(w)), 'gain does not buy a constraint');
});
