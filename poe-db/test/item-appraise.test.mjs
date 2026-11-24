import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseItemText, pseudoTotals, appraiseItem, appraiseCommand, appraiseHelp } from '../scripts/item-appraise.mjs';
import { buildItem } from '../scripts/item-builder.mjs';
import { agent } from '../scripts/agent.mjs';

const cacheReady = fs.existsSync(fileURLToPath(new URL('../cache/knowledge/mods.json', import.meta.url)));
const engineReady = process.platform === 'win32' && fs.existsSync(fileURLToPath(new URL('../vendor/pob/src/Classes/Item.lua', import.meta.url)));
const fixture = fileURLToPath(new URL('../fixtures/fireball-control.xml', import.meta.url));

const GAME_RING = `Item Class: Rings
Rarity: Rare
Doom Loop
Two-Stone Ring
--------
Requirements:
Level: 64
--------
Item Level: 84
--------
+14% to Cold and Lightning Resistances (implicit)
--------
+68 to maximum Life
+42% to Fire Resistance
+40 to Strength
+25% to Lightning Resistance (crafted)
--------
Shaper Item
Corrupted`;

const ADVANCED_HELMET = `Item Class: Helmets
Rarity: Rare
Grim Crown
Hubris Circlet
--------
Quality: +20% (augmented)
Energy Shield: 250 (augmented)
--------
Sockets: B-B-B-B
--------
Item Level: 86
--------
{ Prefix Modifier "Fecund" (Tier: 1) — Life }
+95(90-99) to maximum Life
{ Suffix Modifier "of the Ice" (Tier: 3) — Elemental, Cold, Resistance }
+33(30-35)% to Cold Resistance
{ Master Crafted Suffix Modifier "of Craft" (Rank: 2) — Elemental, Fire, Resistance }
+23(21-28)% to Fire Resistance (crafted)`;

test('parser reads game text: header, sections, markers, influences and flags', () => {
  const item = parseItemText(GAME_RING);
  assert.equal(item.format, 'game');
  assert.deepEqual([item.rarity, item.name, item.base_line, item.item_level], ['rare', 'Doom Loop', 'Two-Stone Ring', 84]);
  assert.deepEqual(item.implicits.map(row => row.text), ['+14% to Cold and Lightning Resistances']);
  assert.deepEqual(item.mods.map(row => [row.text, row.marker]), [['+68 to maximum Life', null], ['+42% to Fire Resistance', null], ['+40 to Strength', null], ['+25% to Lightning Resistance', 'crafted']]);
  assert.deepEqual(item.influences, ['Shaper']);
  assert.deepEqual(item.flags, ['Corrupted']);
  assert.ok(item.skipped.includes('Level: 64'), 'requirement lines are not mods');
});

test('parser reads advanced copy headers, strips value ranges and keeps {crafted} PoB markers', () => {
  const item = parseItemText(ADVANCED_HELMET);
  assert.equal(item.advanced, true);
  assert.equal(item.quality, 20);
  assert.equal(item.sockets, 'B-B-B-B');
  assert.deepEqual(item.mods.map(row => row.text), ['+95 to maximum Life', '+33% to Cold Resistance', '+23% to Fire Resistance']);
  assert.deepEqual(item.mods.map(row => [row.header.side, row.header.tier]), [['prefix', 1], ['suffix', 3], ['suffix', null]]);
  assert.equal(item.mods[2].marker, 'crafted');
  const pob = parseItemText('Rarity: RARE\nX\nHubris Circlet\nItem Level: 86\nImplicits: 0\n+90 to maximum Life\n{crafted}+30% to Fire Resistance');
  assert.equal(pob.format, 'pob');
  assert.deepEqual(pob.mods.map(row => [row.text, row.marker]), [['+90 to maximum Life', null], ['+30% to Fire Resistance', 'crafted']]);
  assert.throws(() => parseItemText('no item here'), /Rarity/);
});

test('pseudo totals follow trade conventions (dual/all resistances, strength to life)', () => {
  const pseudo = pseudoTotals(['+14% to Cold and Lightning Resistances', '+10% to all Elemental Resistances', '+60 to maximum Life', '+40 to Strength',
    '+20 to all Attributes', '+13% to Chaos Resistance', '+10% to maximum Fire Resistance', '25% increased Movement Speed']);
  assert.equal(pseudo.cold_res, 24);
  assert.equal(pseudo.fire_res, 10, 'maximum resistance lines are not resistances');
  assert.equal(pseudo.total_elemental_resistance, 10 + 24 + 24);
  assert.equal(pseudo.total_resistance, 58 + 13);
  assert.equal(pseudo.strength, 60);
  assert.equal(pseudo.total_life_with_strength, 90);
  assert.equal(pseudo.movement_speed, 25);
});

test('appraisal recovers mod ids, tiers and roll quality of a built item (round trip)', { skip: !cacheReady }, () => {
  const built = buildItem({ base: 'Hubris Circlet', item_level: 86, name: 'Round Trip', roll: 'max', mods: ['maximum Life:T1', 'Cold Resistance:T2', 'Intelligence:T3'], crafted: ['Fire Resistance'] });
  assert.equal(built.legal, true, JSON.stringify(built.violations));
  const result = appraiseItem(built.text);
  const natural = result.mods.filter(row => row.kind === 'natural');
  assert.deepEqual(natural.map(row => row.id).sort(), built.item.mods.filter(row => row.kind === 'natural').map(row => row.id).sort());
  assert.deepEqual(natural.map(row => row.tier).sort(), [1, 2, 3]);
  assert.ok(natural.every(row => row.roll_quality === 1), 'max rolls have quality 1');
  assert.equal(result.mods.find(row => row.kind === 'crafted').id, built.item.mods.find(row => row.kind === 'crafted').id);
  assert.deepEqual(result.summary.affixes.open, { prefix: 2, suffix: 0 });
  assert.equal(result.unmatched_mods.length, 0);
  assert.equal(result.market.offline_price_available, false);
  assert.ok(result.market.trade_search.filters.some(row => row.filter.includes('total maximum Life')));
});

test('ambiguous bases, advanced grouping, corruption and merged lines are reported', { skip: !cacheReady }, () => {
  const ring = appraiseItem(GAME_RING);
  assert.equal(ring.item.base_id, 'Metadata/Items/Rings/Ring13', 'Two-Stone Ring variant chosen by its implicit');
  assert.equal(ring.summary.modifiable, false);
  assert.equal(ring.summary.bench_craft_possible, false);
  assert.ok(ring.pob_text.includes('Shaper Item') && ring.pob_text.endsWith('Corrupted'));
  const helmet = appraiseItem(ADVANCED_HELMET);
  assert.equal(helmet.advanced_copy, true);
  assert.deepEqual(helmet.mods.map(row => row.side), ['prefix', 'suffix', 'suffix']);
  assert.equal(helmet.mods[0].game_tier, 1);
  // 137 + 31 life summed into one line by the game (normal copy): no single mod has that range.
  const merged = appraiseItem('Rarity: Rare\nX\nHubris Circlet\n--------\nItem Level: 86\n--------\n+400 to maximum Life');
  assert.equal(merged.unmatched_mods[0].possibly_merged, true);
  assert.ok(merged.warnings.some(row => row.code === 'merged_lines_possible'));
  const unique = appraiseItem('Rarity: Unique\nGoldrim\nLeather Cap\n--------\nItem Level: 80');
  assert.match(unique.note, /price get Goldrim/);
  assert.throws(() => appraiseItem('Rarity: Rare\nUnidentified\nHubris Circlet\n--------\nUnidentified'), /Unidentified/);
});

test('CLI is registered under item appraise', { skip: !cacheReady }, () => {
  assert.ok(Object.keys(appraiseHelp)[0].startsWith('item appraise'));
  assert.ok(Object.keys(agent(['help', '--full']).commands).some(key => key.startsWith('item appraise')));
  const result = agent(['item', 'appraise', '--text', GAME_RING, '--brief']);
  assert.equal(result.item.base, 'Two-Stone Ring');
  assert.equal(result.pob_text, undefined);
  assert.throws(() => appraiseCommand([]), /--file/);
});

test('--check measures build value in PoB', { skip: !cacheReady || !engineReady }, () => {
  const built = buildItem({ base: 'Hubris Circlet', item_level: 86, name: 'Check Me', mods: ['maximum Life:T1'] });
  const result = appraiseCommand(['--text', built.text, '--check', fixture]);
  assert.equal(result.build_value.slot, 'Helmet');
  assert.equal(result.build_value.ok, true);
  assert.ok(result.build_value.key_stats.Life.delta > 0);
});
