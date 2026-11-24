import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildItem, itemPool, parseModSpec, itemCommand, itemHelp, checkItem } from '../scripts/item-builder.mjs';

const cacheReady = fs.existsSync(fileURLToPath(new URL('../cache/knowledge/mods.json', import.meta.url)));
const engineReady = process.platform === 'win32' && fs.existsSync(fileURLToPath(new URL('../vendor/pob/src/Classes/Item.lua', import.meta.url)));
const fixture = fileURLToPath(new URL('../fixtures/fireball-control.xml', import.meta.url));
const codes = result => result.violations.map(v => v.code);

test('mod spec parser reads ref, tier and values', () => {
  assert.deepEqual(parseModSpec('maximum Life:T1'), { ref: 'maximum Life', tier: 1, values: null });
  assert.deepEqual(parseModSpec('IncreasedLife10=150'), { ref: 'IncreasedLife10', tier: null, values: [150] });
  assert.deepEqual(parseModSpec('Adds # to # Fire Damage:T2=10, 20'), { ref: 'Adds # to # Fire Damage', tier: 2, values: [10, 20] });
  assert.ok(itemHelp['item pool --base <name> --ilvl N [--influence X,Y] [--search text] [--side prefix|suffix] [--tiers N|--all-tiers] [--crafted] [--limit N]']);
});

test('pool respects base tags and item level; tiers are per base and ilvl', { skip: !cacheReady }, () => {
  const pool = itemPool({ base: 'Hubris Circlet', item_level: 86, search: 'maximum Life' });
  const life = pool.types.find(type => type.type === 'IncreasedLife');
  assert.ok(life && life.side === 'prefix');
  assert.ok(!life.tiers.some(tier => tier.id === 'IncreasedLife10'), 'body-armour-only tier must not be in a helmet pool');
  const low = itemPool({ base: 'Hubris Circlet', item_level: 30, search: 'IncreasedLife', all_tiers: true }).types.find(type => type.type === 'IncreasedLife');
  assert.ok(low.tiers.every(tier => tier.ilvl <= 30));
  const built = buildItem({ base: 'Hubris Circlet', item_level: 86, mods: ['IncreasedLife10'] });
  assert.equal(built.legal, false);
  assert.ok(codes(built).includes('not_in_pool'));
  assert.equal(built.text, null);
  const lowIlvl = buildItem({ base: 'Hubris Circlet', item_level: 50, mods: ['IncreasedLife9'] });
  assert.ok(codes(lowIlvl).includes('item_level_too_low'));
  const t1 = buildItem({ base: 'Hubris Circlet', item_level: 86, mods: ['maximum Life:T1'] });
  assert.equal(t1.legal, true);
  assert.equal(t1.item.mods[0].tier, 1);
  assert.equal(t1.item.mods[0].values[0], t1.item.mods[0].ranges[0].max);
});

test('prefix/suffix limits, magic limits and group conflicts are reported', { skip: !cacheReady }, () => {
  const tooMany = buildItem({ base: 'Hubris Circlet', item_level: 86, mods: ['Fire Resistance', 'Cold Resistance', 'Lightning Resistance', 'Chaos Resistance'] });
  assert.ok(codes(tooMany).includes('too_many_suffixes'));
  const magic = buildItem({ base: 'Hubris Circlet', item_level: 86, rarity: 'magic', mods: ['Fire Resistance', 'Cold Resistance'] });
  assert.ok(codes(magic).includes('too_many_suffixes'));
  const conflict = buildItem({ base: 'Hubris Circlet', item_level: 86, mods: ['IncreasedLife9', 'IncreasedLife8'] });
  assert.ok(codes(conflict).includes('group_conflict'));
  const crafted = buildItem({ base: 'Hubris Circlet', item_level: 86, mods: ['maximum Life'], crafted: ['Strength', 'Dexterity'] });
  assert.ok(codes(crafted).includes('too_many_crafted'));
  const hypothetical = buildItem({ base: 'Hubris Circlet', item_level: 86, mods: ['IncreasedLife9', 'IncreasedLife8'], allow_illegal: true, slot: 'Helmet' });
  assert.equal(hypothetical.hypothetical, true);
  assert.equal(hypothetical.warnings[0].code, 'hypothetical_item');
  assert.equal(hypothetical.changes.replace_items[0].slot, 'Helmet');
  assert.throws(() => itemCommand(['build', '--base', 'Hubris Circlet', '--ilvl', '86', '--mod', 'IncreasedLife9', '--mod', 'IncreasedLife8']), /group_conflict/);
  const outOfRange = buildItem({ base: 'Hubris Circlet', item_level: 86, mods: ['IncreasedLife9=200'] });
  assert.ok(codes(outOfRange).includes('value_out_of_range'));
});

test('PoB text: header, implicits, crafted marker and negated stat rendering', { skip: !cacheReady }, () => {
  const rare = buildItem({ base: 'Hubris Circlet', item_level: 86, quality: 20, mods: ['maximum Life:T1=140', 'Fire Resistance:T1'], crafted: ['Lightning Resistance'], slot: 'Helmet' });
  assert.equal(rare.legal, true, JSON.stringify(rare.violations));
  const lines = rare.text.split('\n');
  assert.deepEqual(lines.slice(0, 6), ['Rarity: RARE', 'Item Builder Rare', 'Hubris Circlet', 'Item Level: 86', 'Quality: 20', 'Implicits: 0']);
  assert.ok(lines.includes('+140 to maximum Life'));
  assert.ok(lines.some(line => /^\{crafted\}\+\d+% to Lightning Resistance$/.test(line)));
  assert.deepEqual(rare.changes, { replace_items: [{ slot: 'Helmet', text: rare.text }] });
  // Belt: base implicit is rendered and counted; a negative RePoE value renders through the negate handler as "reduced".
  const belt = buildItem({ base: 'Leather Belt', item_level: 86, rarity: 'magic', mods: ['BeltReducedFlaskChargesUsed1=-20'] });
  assert.equal(belt.legal, true, JSON.stringify(belt.violations));
  const beltLines = belt.text.split('\n');
  assert.deepEqual(beltLines.slice(0, 4), ['Rarity: MAGIC', 'Leather Belt', 'Item Level: 86', 'Implicits: 1']);
  assert.match(beltLines[4], /^\+\d+ to maximum Life$/);
  assert.equal(beltLines[5], '20% reduced Flask Charges used');
  assert.ok(!belt.text.includes('-20'));
});

test('engine: built helmet equips in the control build without unparsed modifiers', { skip: !cacheReady || !engineReady, timeout: 300000 }, () => {
  const built = buildItem({ base: 'Hubris Circlet', item_level: 86, mods: ['maximum Life:T1', 'maximum Energy Shield', 'Fire Resistance', 'Cold Resistance'], crafted: ['Lightning Resistance'] });
  assert.equal(built.legal, true);
  const check = checkItem({ build: fixture, slot: 'Helmet', text: built.text });
  assert.equal(check.ok, true);
  assert.deepEqual(check.unparsed_item_modifiers, []);
  assert.equal(check.equipped.base, 'Hubris Circlet');
  assert.ok(check.key_stats.Life.delta > 0);
  assert.ok(check.key_stats.LightningResist.delta > 0);
});

test('local weapon mods export: translation groups with an absent companion stat render as 0', { skip: !cacheReady }, () => {
  const r = buildItem({ base: 'Jewelled Foil', item_level: 84, mods: ['LocalPhysicalDamagePercent', 'LocalPhysicalDamage', 'LocalIncreasedPhysicalDamagePercentAndAccuracyRating'] });
  assert.equal(r.legal, true, JSON.stringify(r.violations));
  const lines = r.text.split('\n');
  assert.ok(lines.includes('179% increased Physical Damage'));
  assert.ok(lines.includes('79% increased Physical Damage') && lines.includes('+200 to Accuracy Rating'));
  assert.ok(!lines.some(l => /No Physical Damage/.test(l)));
});

test('eldritch implicits carry the PoB line flags', { skip: !cacheReady }, () => {
  const r = buildItem({ base: 'Hubris Circlet', item_level: 84, implicits: ['SpellAddedFireDamageEldritchImplicit4', 'SpellDamageEldritchImplicit4'], mods: ['IncreasedLife'] });
  assert.equal(r.legal, true, JSON.stringify(r.violations));
  const lines = r.text.split('\n');
  assert.ok(lines.includes('Implicits: 2'));
  assert.ok(lines.some(l => /^\{exarch\}Adds \d+ to \d+ Fire Damage to Spells$/.test(l)));
  assert.ok(lines.some(l => /^\{eater\}2\d% increased Spell Damage$/.test(l)));
});
