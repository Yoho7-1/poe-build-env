import test from 'node:test';
import assert from 'node:assert/strict';
import { itemFacts, coverageOf } from '../scripts/analysis-coverage.mjs';

test('item facts read sockets, abyss sockets, quality, open affixes, eldritch and anoint', () => {
  const f = itemFacts('Rarity: RARE\nX\nVaal Regalia\nPrefix: {range:0.5}IncreasedLife7\nPrefix: None\nSuffix: None\nQuality: 12\nSockets: B-B-B A\n{exarch}+1 to Level of Socketed Gems');
  assert.equal(f.sockets, 3); assert.equal(f.abyss_sockets, 1); assert.equal(f.quality, 12);
  assert.equal(f.open_prefixes, 1); assert.equal(f.open_suffixes, 1); assert.equal(f.eldritch, true); assert.equal(f.crafted, false);
  assert.equal(itemFacts('Rarity: RARE\nA\nOnyx Amulet\n{crafted}Allocates Whispers of Doom').anoint, 'Whispers of Doom');
});

test('coverage lists unused layers with the command that values them', () => {
  const tree = { nodes: new Map([[1, { id: 1, name: 'Life Mastery', type: 'mastery' }], [2, { id: 2, name: 'Jewel', type: 'jewel_socket' }], [3, { id: 3, name: 'Fire Mastery', type: 'mastery' }]]) };
  const slots = new Map([['Weapon 1', 'Rarity: RARE\nA\nVoid Sceptre\nSockets: B-B-B'], ['Body Armour', 'Rarity: RARE\nB\nVaal Regalia\nQuality: 20\nSockets: B-B-B-B-B-B\nPrefix: None'],
    ['Amulet', 'Rarity: RARE\nC\nOnyx Amulet'], ['Flask 1', 'Rarity: MAGIC\nDivine Life Flask']]);
  const build = { allocated: new Set(['1', '2', '3']), masteries: [{ node: 3, effect: 9 }], slots,
    groups: [{ index: 1, enabled: true, slot: 'Body Armour', source: null, gems: [{ name: 'Vortex', skill_id: 'Vortex', level: 20, quality: 20, enabled: true }, { name: 'Efficacy', skill_id: 'SupportEfficacy', level: 18, quality: 0, enabled: true }] }] };
  const gems = new Map([['Vortex', { tags: { spell: true } }], ['SupportEfficacy', { tags: { support: true } }]]);
  const r = coverageOf({ build, sockets: [], result: { output: { Mana: 2000, ManaUnreserved: 1500, ManaPerSecondCost: 10 }, budget: { passive_available: 120, passive_used: 117, ascendancy_available: 8, ascendancy_used: 8 } }, tree, gems, config: { pantheonMajorGod: 'Solaris' } });
  const codes = new Set(r.findings.map(f => f.code));
  for (const c of ['unspent_passive_points', 'mastery_without_effect', 'empty_jewel_socket', 'empty_slot', 'empty_flask_slot', 'no_anoint', 'open_affix_no_craft', 'empty_gem_sockets', 'gem_below_20_20', 'no_curse', 'unreserved_mana', 'no_minor_pantheon', 'no_movement_skill'])
    assert.ok(codes.has(c), c);
  assert.ok(!codes.has('no_major_pantheon'));
  assert.ok(r.findings.find(f => f.code === 'empty_slot' && f.detail.startsWith('Helmet')));
  assert.equal(r.used.masteries, 1);
  assert.ok(r.summary.gaps >= 8);
});
