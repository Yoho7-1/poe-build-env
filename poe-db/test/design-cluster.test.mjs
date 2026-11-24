// Cluster jewels for prototypes (design-cluster.mjs): the legal space comes from the PoB data, picks respect shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterData, legalNotables, pickNotables, clusterCandidates, clusterText, CLUSTER_SHAPE } from '../scripts/design-cluster.mjs';

test('cluster data: every size, enchant and notable from PoB; legality by enchant tag', () => {
  const d = clusterData();
  for (const size of ['Large', 'Medium', 'Small']) assert.ok(d.enchants.filter(e => e.size === size).length >= 10, size);
  assert.ok(d.notables.length >= 250);
  const cold = d.enchants.find(e => e.tag === 'affliction_cold_damage');
  const names = legalNotables(cold).map(n => n.name);
  assert.ok(names.includes('Prismatic Heart') && names.includes('Widespread Destruction'));
  assert.ok(!names.includes('Renewal'), 'minion notable is not legal on a cold damage cluster');
});

test('pickNotables keeps the shape limits and only positive values', () => {
  const rows = [{ name: 'A', side: 'prefix', value: 5 }, { name: 'B', side: 'prefix', value: 4 }, { name: 'C', side: 'prefix', value: 3 },
    { name: 'D', side: 'suffix', value: 2 }, { name: 'E', side: 'suffix', value: 1 }, { name: 'F', side: 'prefix', value: 0 }];
  assert.deepEqual(pickNotables(rows, CLUSTER_SHAPE.Large).map(r => r.name), ['A', 'B', 'D']);
  assert.deepEqual(pickNotables(rows, CLUSTER_SHAPE.Small).map(r => r.name), ['A']);
});

test('candidates per size and PoB item text', () => {
  const valueOf = stats => stats.join(' ').includes('Fire') ? 2 : 0;
  const c = clusterCandidates({ valueOf, notableStats: () => ['10% increased Fire Damage'], perSize: { Large: 1, Medium: 1 } });
  assert.deepEqual(c.map(x => x.size), ['Large', 'Medium']);
  const text = clusterText(c[0]);
  assert.match(text, /^Rarity: RARE\nKit Cluster\nLarge Cluster Jewel\nCluster Jewel Skill: affliction_/);
  assert.match(text, /\{crafted\}Adds 8 Passive Skills\n\{crafted\}2 Added Passive Skills are Jewel Sockets/);
  assert.equal(text.match(/1 Added Passive Skill is /g).length, c[0].notables.length);
});
