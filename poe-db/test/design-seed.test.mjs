import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cardFamily, seedScore, seedsFor, weaponClassOf, weaponCompatible, slotItemText } from '../scripts/design-seed.mjs';

const card = (file, { asc = 'Occultist', skill = 'Vortex', tags = ['spell', 'cold', 'area'], form = 'skill_dot', type = 'Cold', level = 95, scope = 'player', group = 2 } = {}) =>
  ({ _card: `${file}.json`, signature: file, identity: { file: `${file}.xml`, level }, features: { ascendancy: asc, main_skill: skill, primary_type: type },
    skills: { main: { tags }, main_selection: { chosen_group: group } }, damage: { primary_form: form, scope } });

test('card family maps corpus forms onto generator forms', () => {
  assert.equal(cardFamily(card('a')), 'damage_over_time');
  assert.equal(cardFamily(card('b', { tags: ['attack', 'melee'], form: 'hit' })), 'attack_hit');
  assert.equal(cardFamily(card('c', { tags: ['spell'], form: 'hit' })), 'spell_hit');
  assert.equal(cardFamily(card('d', { scope: 'minion' })), 'minion');
  assert.equal(cardFamily(card('e', { tags: ['attack', 'bleed'], form: 'bleed' })), 'attack_hit');
});

test('seed score prefers the same skill, then form, tags and damage type; attack vs spell is penalised', () => {
  const want = { skill: 'Vortex', form: 'damage_over_time', damageTypes: ['Cold'], tags: ['spell', 'cold', 'area'] };
  const same = seedScore(card('a'), want), other = seedScore(card('b', { skill: 'Cold Snap' }), want), attack = seedScore(card('c', { skill: 'Cyclone', tags: ['attack'], form: 'hit', type: 'Physical' }), want);
  assert.ok(same.score > other.score && other.score > 0);
  assert.ok(attack.score < 0);
  assert.ok(same.reasons.includes('same_skill'));
});

test('seeds come from quality-filtered cards of the ascendancy with an existing XML', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  fs.mkdirSync(path.join(dir, 'xml'));
  for (const f of ['a', 'b', 'low']) fs.writeFileSync(path.join(dir, 'xml', `${f}.xml`), '<PathOfBuilding/>');
  const cards = [card('a', { skill: 'Cold Snap' }), card('b'), card('low', { level: 50 }), card('gone'), card('chief', { asc: 'Chieftain' })];
  const gem = { name: 'Vortex', tags: ['spell', 'cold', 'area'] };
  const seeds = seedsFor({ ascendancy: 'Occultist', form: 'damage_over_time', damage_types: ['Cold'] }, gem, { cards, top: 5, directory: dir });
  assert.deepEqual(seeds.map(s => s.file), ['b', 'a']);
  assert.equal(seeds[0].main_group, 2);
});

test('unique cost floor sums the cheapest known variant and demotes seeds over budget', async () => {
  const { uniqueCostFloor } = await import('../scripts/design-seed.mjs');
  const prices = { 'Kalandra\'s Touch': 20, 'Eye of Malice': 0.2 };
  const c = uniqueCostFloor(['Kalandra\'s Touch', 'Eye of Malice', 'Unknown Thing'], n => prices[n] ?? null);
  assert.equal(c.divine_floor, 20.2); assert.deepEqual(c.unknown, ['Unknown Thing']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedb-'));
  fs.mkdirSync(path.join(dir, 'xml'));
  for (const f of ['rich', 'poor']) fs.writeFileSync(path.join(dir, 'xml', `${f}.xml`), '<PathOfBuilding/>');
  const rich = card('rich'); rich.features.uniques = ['Kalandra\'s Touch'];
  const poor = card('poor', { skill: 'Cold Snap' }); poor.features.uniques = [];
  const gem = { name: 'Vortex', tags: ['spell', 'cold', 'area'] };
  const row = { ascendancy: 'Occultist', form: 'damage_over_time', damage_types: ['Cold'] };
  assert.equal(seedsFor(row, gem, { cards: [rich, poor], directory: dir })[0].file, 'rich');
  const s = seedsFor(row, gem, { cards: [rich, poor], directory: dir, budgetDivine: 10, lookup: n => prices[n] ?? null, top: 2 });
  assert.equal(s[0].file, 'poor');
  assert.ok(s[1].reasons.some(r => r.startsWith('over_budget')));
});

test('seed weapon must satisfy the skill weapon restrictions', () => {
  const xml = '<Slot itemId="0" name="Weapon 1 Swap"/><Slot itemId="18" itemPbURL="" name="Weapon 1"/><Item id="18">\n\tRarity: RARE\nArmageddon Slicer\nReaver Sword\nQuality: 0\n</Item>';
  const t = slotItemText(xml);
  assert.equal(weaponClassOf(t), 'Sword');
  assert.equal(weaponCompatible(t, ['One Hand Mace', 'Staff']).ok, false);
  assert.equal(weaponCompatible(t, ['One Hand Sword']).ok, true);
  assert.equal(weaponCompatible(t, []).ok, true);
  assert.equal(slotItemText('<Slot itemId="0" name="Weapon 1"/>'), null);
});
