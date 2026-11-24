import test from 'node:test';
import assert from 'node:assert/strict';
import { manaProfile, lifeProfile, attributeProfile, eldritchOf, clustersOf, anointOf, foundationOf, FOUNDATION_SCHEMA } from '../scripts/build-foundation.mjs';

test('mana profile names the largest recovery source and the sustain balance', () => {
  const regen = manaProfile({ ManaPerSecondCost: 130, ManaRegenRecovery: 16, ManaLeechGainRate: 0 });
  assert.equal(regen.primary, 'regen'); assert.equal(regen.sustain_per_s, -114); assert.equal(regen.applies, true);
  const leech = manaProfile({ ManaPerSecondCost: 100, ManaRegenRecovery: 40, ManaLeechGainRate: 250 });
  assert.equal(leech.primary, 'leech'); assert.deepEqual(leech.sources, ['leech', 'regen']); assert.equal(leech.leech_share, 2.5);
  assert.equal(manaProfile({ ManaPerSecondCost: 50, ManaRegenRecovery: 10 }, { keystones: ['Eldritch Battery'] }).primary, 'eldritch_battery');
  assert.equal(manaProfile({ ManaPerSecondCost: 0, LifePerSecondCost: 300 }).primary, 'life_cost');
  assert.equal(manaProfile({ ManaPerSecondCost: 0 }).primary, 'no_cost');
  assert.equal(manaProfile({ ManaPerSecondCost: 80, ManaRegenRecovery: 0 }).primary, 'none');
  assert.equal(manaProfile({ ManaPerSecondCost: 80 }, { scope: 'minion' }).applies, false);
});

test('life profile and attribute headroom come from PoB output only', () => {
  const l = lifeProfile({ Life: 5000, LifeRegenRecovery: 500, LifeLeechGainRate: 1000, LifeRecoup: 12 });
  assert.equal(l.primary, 'leech'); assert.deepEqual(l.sources, ['leech', 'regen', 'recoup']); assert.equal(l.regen_pct, 10);
  assert.equal(lifeProfile({ Life: 5000, LifeRecoup: 8 }).primary, 'recoup');
  const a = attributeProfile({ Str: 250, ReqStr: 155, Dex: 100, ReqDex: 111, Int: 300, ReqInt: 0 });
  assert.equal(a.str.slack, 95); assert.deepEqual(a.unmet, ['dex']); assert.equal(a.slack_total, 395); assert.equal(a.max_slack, 300);
  const unknown = attributeProfile({ Str: 100 });
  assert.equal(unknown.requirements_known, false); assert.equal(unknown.str.slack, null); assert.equal(unknown.slack_total, null);
  const omni = attributeProfile({ Omni: 600, ReqOmni: 400 });
  assert.equal(omni.omniscience, true); assert.equal(omni.slack_total, 200);
});

test('eldritch implicits, clusters and anoint are read from item text', () => {
  const slots = new Map([
    ['Helmet', 'Rarity: RARE\nX\nHubris Circlet\n{exarch}+1 to Level of Socketed AoE Gems\n{eater}10% increased Damage'],
    ['Gloves', 'Rarity: RARE\nY\nSorcerer Gloves\n{eater}Spell Damage'],
    ['Body Armour', 'Rarity: UNIQUE\nZ\nVaal Regalia'],
    ['Amulet', 'Rarity: RARE\nA\nAmulet\n{crafted}{enchant}Allocates Frost Walker\n+30 to Intelligence']]);
  assert.deepEqual(eldritchOf(slots), { items: 2, slots: ['Helmet', 'Gloves'], exarch: 1, eater: 2 });
  assert.equal(anointOf(slots), 'Frost Walker');
  assert.equal(anointOf(new Map()), null);
  const c = clustersOf([{ slot: 'Jewel 1', base: 'Large Cluster Jewel' }, { slot: 'Jewel 2', base: 'Medium Cluster Jewel' }, { slot: 'Jewel 3', base: 'Small Cluster Jewel' }, { slot: 'Weapon 1 Swap', base: 'Large Cluster Jewel' }, { slot: 'Jewel 4', base: 'Cobalt Jewel' }]);
  assert.deepEqual(c, { large: 1, medium: 1, small: 1, total: 3 });
});

test('foundation joins the parts, resolves mastery text and counts automatic flasks', () => {
  const tree = { nodes: new Map([[100, { name: 'Mana Mastery', mastery_effects: [{ effect: 7, stats: ['1% of Damage Leeched as Mana'] }] }]]) };
  const build = { masteries: [{ node: 100, effect: 7 }], slots: new Map([['Flask 1', 'Rarity: MAGIC\nDivine Life Flask'], ['Flask 2', 'Rarity: MAGIC\nQuicksilver Flask\nUsed when you start Moving']]) };
  const equipped = [{ slot: 'Flask 1', name: 'Divine Life Flask', base: 'Divine Life Flask', rarity: 'MAGIC' }, { slot: 'Flask 2', name: 'Quicksilver Flask', base: 'Quicksilver Flask', rarity: 'MAGIC' }];
  const f = foundationOf({ build, output: { ManaPerSecondCost: 10, ManaLeechGainRate: 20 }, equipped, tree, keystones: ['Mind Over Matter'] });
  assert.equal(f.schema, FOUNDATION_SCHEMA);
  assert.equal(f.masteries.count, 1); assert.equal(f.masteries.effects[0].text, '1% of Damage Leeched as Mana');
  assert.deepEqual(f.flasks, { count: 2, auto: 1, manual: 0, reactive: 1 });
  assert.equal(f.mana.primary, 'leech'); assert.deepEqual(f.keystones, ['Mind Over Matter']);
});
