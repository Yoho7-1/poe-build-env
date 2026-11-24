import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModCache, buildTaxonomy, ruleCover, coverOf, cardIndex } from '../scripts/mechanic-taxonomy.mjs';

const sample = [
  'local c = {}',
  'c["+1 Life per 4 Dexterity"]={{[1]={[1]={div=4,stat="Dex",type="PerStat"},flags=0,keywordFlags=0,name="Life",type="BASE",value=1}},nil}',
  'c["+1 Life per 2% Item Rarity"]={{[1]={flags=0,keywordFlags=0,name="Life",type="BASE",value=1}},"  per 2% Item Rarity "}',
  'c["10% increased Damage while you have Onslaught"]={{[1]={[1]={type="Condition",var="Onslaught"},flags=0,keywordFlags=0,name="Damage",type="INC",value=10}},nil}',
  'c["Your hits summon a ghost"]={nil,"Your hits summon a ghost "}',
  'c["(10-15)% increased Energy Shield Recharge Rate"]={nil,"(10-15)% increased Energy Shield Recharge Rate "}'
].join('\n');

test('ModCache lines parse into mod names, condition variables, unparsed and partial lines', () => {
  const e = parseModCache(sample);
  assert.equal(e.length, 5);
  assert.deepEqual(e[0].mods, [{ name: 'Life', type: 'BASE' }]);
  assert.deepEqual(e[0].vars, [{ type: 'PerStat', var: 'Dex' }]);
  assert.equal(e[1].leftover, 'per 2% Item Rarity');
  assert.deepEqual(e[2].vars, [{ type: 'Condition', var: 'Onslaught' }]);
  assert.equal(e[3].unparsed, true);
  const t = buildTaxonomy({ entries: e, cards: [{ id: 'recovery', aliases: ['life'], title: 'Life recovery' }], gaps: [] });
  assert.equal(t.summary.mod_names, 2);
  assert.equal(t.summary.unparsed_lines, 1, 'ranged template lines are not counted as unparsed');
  assert.equal(t.summary.partial_lines, 1);
  assert.deepEqual(t.mod_names.find(m => m.name === 'Life').covered_by, ['card:recovery']);
  assert.ok(t.mod_names.find(m => m.name === 'Damage').covered_by.includes('card:increased-more'));
});

test('name rules place generic stats; keyword index covers the rest', () => {
  assert.deepEqual(ruleCover('ColdMin'), ['card:added-damage', 'card:increased-more']);
  assert.deepEqual(ruleCover('LootRarity'), ['non_combat']);
  assert.equal(ruleCover('ImpaleChance'), null);
  assert.deepEqual(coverOf('ImpaleChance', cardIndex([{ id: 'impale', aliases: [], title: 'Impale' }])), ['card:impale']);
});
