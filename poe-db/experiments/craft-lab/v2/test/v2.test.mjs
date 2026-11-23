import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadCatalog } from '../catalog.mjs';
import { createSession, step, replay, observe, preview, meets } from '../session.mjs';
import { pool, tierInfo } from '../draw.mjs';
import { itemTags } from '../item.mjs';
import { exportPob } from '../export.mjs';
import { train } from '../training.mjs';
import { rules } from '../rules.mjs';
import { fossilWeight } from '../actions/crafts.mjs';
import { cli } from '../cli.mjs';

const catalog = loadCatalog();
const s0 = (item, extra = {}) => createSession(catalog, { item, seed: extra.seed ?? 7, unlocked_recipes: 'all_assumed', ...extra });
const run = (session, ...actions) => actions.reduce((s, a) => step(catalog, s, a), session);
const recipeFor = (modPattern, cls) => [...catalog.recipes.values()].find(r => r.actions.add_explicit_mod && new RegExp(modPattern).test(r.actions.add_explicit_mod) && r.item_classes.includes(cls)).id;
const sideCount = (s, side) => s.item.mods.filter(r => catalog.mods.get(r.id).generation_type === side).length;
const tryStep = (s, a) => { try { return step(catalog, s, a); } catch (e) { return e; } };

test('every rule id referenced in the code exists and Royale duplicates are not admitted bases', () => {
  const code = ['actions.mjs', 'actions/basic.mjs', 'actions/crafts.mjs', 'actions/special.mjs'].map(f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');
  const ids = [...code.matchAll(/'([a-z_0-9]+\.[a-z_0-9]+)'/g)].map(m => m[1]).filter(id => /^(pool|count|orb|meta|bench|essence|fossil|harvest|beast|influence|eldritch|veiled|corrupt|tainted|sockets|quality|strands|recomb|lock|tier)\./.test(id));
  for (const id of ids) assert.ok(rules[id], `missing rule ${id}`);
  assert.ok(![...catalog.bases.keys()].some(id => /Royale/.test(id)));
  assert.equal(createSession(catalog, { item: { base: 'Leather Belt', item_level: 80 }, seed: 1 }).item.base_id, 'Metadata/Items/Belts/Belt3');
  assert.ok(catalog.elevated.size > 100);
});

test('Alchemy affix counts follow 8:3:1 and Scouring leaves rare with two fractured mods', () => {
  const tally = { 4: 0, 5: 0, 6: 0 };
  for (let seed = 0; seed < 1200; seed++) tally[run(s0({ base: 'Vaal Regalia', item_level: 86 }, { seed }), 'Orb of Alchemy').item.mods.length]++;
  assert.ok(Math.abs(tally[4] / 1200 - 8 / 12) < 0.05 && Math.abs(tally[6] / 1200 - 1 / 12) < 0.03, JSON.stringify(tally));
  const s = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: [{ id: 'IncreasedLife10', fractured: true }, { id: 'FireResist6', fractured: true }, 'ColdResist6'] }), 'Orb of Scouring');
  assert.equal(s.item.rarity, 'rare'); assert.equal(s.item.mods.length, 2);
});

test('3.30 full lock costs come from the pinned data and counted locks protect exactly N mods', () => {
  const full = catalog.recipes.get(recipeFor('^StrMasterItemGenerationCannotChangePrefixesB$', 'Body Armour'));
  assert.deepEqual(Object.values(full.cost).sort(), [4, 4]);
  const start = s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10', 'LocalIncreasedEnergyShieldPercent6', 'FireResist6'] });
  const start3 = s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10', 'LocalIncreasedEnergyShield8', 'LocalIncreasedEnergyShieldPercent6', 'FireResist6'] });
  const locked = run(start, { type: 'bench', recipe: recipeFor('^DexMasterItemGenerationCannotChangeOneSuffixes', 'Body Armour') });
  for (let seed = 0; seed < 40; seed++) {
    const s = createSession(catalog, { ...locked.initial, seed });
    const after = run(run(s, ...locked.history.map(h => h.action)), 'Chaos Orb');
    assert.ok(after.item.mods.some(r => r.id === 'FireResist6'), 'the only non-metamod suffix must survive a Chaos Orb under a 1-suffix lock');
  }
  const full2 = run(start3, { type: 'bench', recipe: recipeFor('^StrMasterItemGenerationCannotChangePrefixesB$', 'Body Armour') }, 'Orb of Scouring');
  assert.equal(sideCount(full2, 'prefix'), 3); assert.equal(sideCount(full2, 'suffix'), 0);
});

test('3.30 Annulment ignores Cannot roll Caster Modifiers while Exalted respects it', () => {
  const caster = recipeFor('CannotRollCasterAffixes', 'Wand');
  const s = run(s0({ base: 'Imbued Wand', item_level: 85, rarity: 'rare', mods: ['GlobalSpellGemsLevel1', 'IncreasedCastSpeed3'] }), { type: 'bench', recipe: caster });
  const removed = new Set();
  for (let seed = 0; seed < 60; seed++) { const t = run(createSession(catalog, { ...s.initial, seed }), ...s.history.map(h => h.action), 'Orb of Annulment'); ['GlobalSpellGemsLevel1', 'IncreasedCastSpeed3'].forEach(id => { if (!t.item.mods.some(r => r.id === id)) removed.add(id); }); }
  assert.equal(removed.size, 2);
  const rows = pool(catalog, s.item).rows; assert.ok(rows.every(row => !catalog.mods.get(row.id).implicit_tags.includes('caster')));
});

test('essences: Rune Dagger mapping, tier gate, Trickery/Desolation and fractured clash', () => {
  const rd = run(s0({ base: 'Boot Blade', item_level: 84 }), { type: 'essence', essence: 'Deafening Essence of Anger' });
  assert.equal(rd.item.rarity, 'rare'); assert.ok(rd.item.mods.some(r => r.kind === 'essence'));
  const weeping = tryStep(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), { type: 'essence', essence: 'Weeping Essence of Greed' });
  assert.match(weeping.message, /rarity\/tier/);
  const belt = run(s0({ base: 'Leather Belt', item_level: 86 }), { type: 'essence', essence: 'Essence of Trickery' });
  assert.ok(belt.item.mods.some(r => r.id === 'PlayerIsDeliriousEssence1'));
  const clash = tryStep(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: [{ id: 'IncreasedLife10', fractured: true }, 'FireResist6', 'ColdResist6', 'LightningResist6'] }), { type: 'essence', essence: 'Deafening Essence of Greed' });
  assert.match(clash.message, /fractured/);
});

test('fossils: blocks, additive boosts, Sanctified lucky, Hollow forced, Fractured, Bloodstained and Gilded', () => {
  const fossil = name => [...catalog.fossils.values()].find(f => f.name === name);
  const cold = catalog.mods.get('ColdResist6'), life = catalog.mods.get('IncreasedLife10');
  assert.equal(fossilWeight([fossil('Scorched Fossil')], cold), 0);
  assert.equal(fossilWeight([fossil('Pristine Fossil')], life), 10);
  const s = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), { type: 'fossils', fossils: ['Scorched Fossil', 'Hollow Fossil'] });
  assert.ok(s.item.mods.some(r => r.id === 'DelveAbyssJewelSocket1'));
  assert.ok(s.item.mods.every(r => !catalog.mods.get(r.id).implicit_tags.includes('cold')));
  const fr = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), { type: 'fossils', fossils: ['Fractured Fossil', 'Pristine Fossil'] });
  assert.equal(fr.item.mods.filter(r => r.fractured).length, 1);
  const bl = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), { type: 'fossils', fossils: ['Bloodstained Fossil', 'Gilded Fossil'] });
  assert.ok(bl.item.corrupted && bl.item.implicits.length === 1 && bl.item.implicits[0].kind === 'corrupted');
  const gi = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), { type: 'fossils', fossils: ['Gilded Fossil'] });
  assert.ok(!gi.item.corrupted && gi.item.implicits.some(r => r.kind === 'sell'));
  const meta = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), { type: 'bench', recipe: recipeFor('CannotRollAttackAffixes', 'Body Armour') });
  assert.match(tryStep(meta, { type: 'fossils', fossils: ['Pristine Fossil'] }).message, /metamods/);
});

test('Harvest: tagged reforge guarantee, more-likely count, swap keeps tier and validates 3.30 cost', () => {
  for (let seed = 0; seed < 20; seed++) {
    const s = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['FireResist6'] }, { seed }), { type: 'harvest', method: 'reforge', tag: 'chaos' });
    assert.ok(s.item.mods.some(r => catalog.mods.get(r.id).implicit_tags.includes('chaos')));
  }
  const start = s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['FireResist6', 'IncreasedLife10'] });
  const swap = run(start, { type: 'harvest', method: 'swap', kind: 'resistance', from: 'fire', to: 'cold', cost: { 'Wild Crystallised Lifeforce': 300, 'Vivid Crystallised Lifeforce': 300 } });
  const cold = swap.item.mods.find(r => /ColdResist/.test(r.id)); assert.ok(cold);
  const tags = itemTags(catalog, swap.item);
  assert.equal(tierInfo(catalog, swap.item, catalog.mods.get(cold.id), tags, 100).tier, tierInfo(catalog, start.item, catalog.mods.get('FireResist6'), tags, 100).tier);
  assert.match(tryStep(start, { type: 'harvest', method: 'swap', kind: 'resistance', from: 'fire', to: 'cold', cost: { 'Vivid Crystallised Lifeforce': 500 } }).message, /300 of two/);
  const more = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['FireResist6', 'IncreasedLife10', 'ColdResist6', 'LightningResist6', 'LocalIncreasedEnergyShield8'] }), { type: 'harvest', method: 'more_likely' });
  assert.ok(more.item.mods.length >= 5);
});

test('Bestiary: side swap, metamod, aspect, imprint and restore', () => {
  const start = s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['FireResist6', 'ColdResist6', 'IncreasedLife10'] });
  const sw = run(start, { type: 'beast', method: 'add_prefix_remove_suffix', beast_level: 83 });
  assert.equal(sideCount(sw, 'prefix'), 2); assert.equal(sideCount(sw, 'suffix'), 1);
  const mm = run(start, { type: 'beast', method: 'metamod' }); assert.equal(mm.item.mods.filter(r => r.kind === 'crafted').length, 1);
  const asp = run(start, { type: 'beast', method: 'aspect', aspect: 'cat', level: 30 }); assert.ok(asp.item.mods.some(r => r.id === 'GrantsCatAspectCrafted30'));
  const magic = s0({ base: 'Leather Belt', item_level: 86, rarity: 'magic', mods: ['IncreasedLife7'] });
  const restored = run(magic, { type: 'beast', method: 'imprint' }, 'Regal Orb', { type: 'beast', method: 'restore_imprint' });
  assert.equal(restored.item.rarity, 'magic'); assert.deepEqual(restored.item.mods, magic.item.mods);
});

test('influence: Exalted adds influence, Awakener merges a donor, Dominance upgrades', () => {
  const ex = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), "Shaper's Exalted Orb");
  assert.deepEqual(ex.item.influences, ['Shaper']); assert.equal(ex.item.mods.length, 2);
  const tags = itemTags(catalog, ex.item), shaperMod = ex.item.mods.find(r => r.id !== 'IncreasedLife10');
  assert.ok(catalog.mods.get(shaperMod.id).spawn_weights.find(w => tags.has(w.tag)).tag.endsWith('_shaper'));
  assert.match(tryStep(ex, "Elder's Exalted Orb").message, /Invalid influence-orb target/);
  const el = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['FireResist6'] }, { seed: 11 }), "Elder's Exalted Orb");
  const elderMod = el.item.mods.find(r => r.id !== 'FireResist6');
  const aw = createSession(catalog, { item: { base: 'Vaal Regalia', item_level: 86, rarity: 'rare', influences: ['Shaper'], mods: [shaperMod.id] },
    inventory: { donor: { base: 'Vaal Regalia', item_level: 86, rarity: 'rare', influences: ['Elder'], mods: [elderMod.id] } }, seed: 4 });
  const merged = run(aw, { type: 'awakener', donor: 'donor' });
  assert.deepEqual([...merged.item.influences].sort(), ['Elder', 'Shaper']); assert.equal(Object.keys(merged.inventory).length, 0);
  assert.ok(merged.item.mods.some(r => r.id === shaperMod.id));
  const t2 = itemTags(catalog, merged.item);
  const infl = merged.item.mods.filter(r => { const e = catalog.mods.get(r.id).spawn_weights.find(w => t2.has(w.tag)); return e && /_(shaper|elder)$/.test(e.tag); }).length;
  if (infl >= 2) { const dom = run(merged, 'Orb of Dominance'); assert.equal(dom.item.mods.length, merged.item.mods.length - 1); }
});

test('Eldritch implicits, dominant side, Conflict', () => {
  let s = run(s0({ base: 'Sorcerer Boots', item_level: 86, rarity: 'rare', mods: ['IncreasedLife7', 'FireResist6'] }), 'Exceptional Eldritch Ember', 'Lesser Eldritch Ichor');
  assert.equal(s.item.eldritch.exarch.tier, 4); assert.equal(s.item.eldritch.eater.tier, 1);
  const before = s.item.mods.find(r => r.id === 'FireResist6');
  s = run(s, 'Eldritch Chaos Orb'); assert.ok(s.item.mods.some(r => r.id === 'FireResist6') && before);
  const c = run(s, 'Orb of Conflict'); assert.equal(c.item.eldritch.exarch.tier + (c.item.eldritch.eater?.tier ?? 0), 5);
});

test('Veiled Exalted, unveil and explicit choice; Veiled Chaos guarantees a veiled mod', () => {
  let s = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10', 'FireResist6'] }), 'Veiled Exalted Orb', { type: 'unveil' });
  assert.ok(s.offers.ids.length >= 1);
  s = run(s, { type: 'choose_unveil', index: 0 }); assert.ok(s.item.mods.some(r => r.kind === 'unveiled'));
  const vc = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), 'Veiled Chaos Orb');
  assert.equal(vc.item.mods.filter(r => r.kind === 'veiled').length, 1);
});

test('Memory Strands: cut removes low tiers, Foulborn cuts without strands, spend and Unravelling', () => {
  const plain = s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare' }), stranded = s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', memory_strands: 100 });
  const ids = p => new Set(p.rows.map(r => r.id));
  const a = ids(pool(catalog, plain.item)), b = ids(pool(catalog, stranded.item, { cut: 'strands' })), f = ids(pool(catalog, plain.item, { cut: 'foulborn' }));
  assert.ok(a.has('IncreasedLife1') && !b.has('IncreasedLife1') && !f.has('IncreasedLife1') && b.has('IncreasedLife12'));
  const spent = run(s0({ base: 'Vaal Regalia', item_level: 86, memory_strands: 60 }), 'Orb of Alchemy');
  assert.ok(spent.item.memory_strands <= 60 && spent.item.memory_strands >= 10);
  const un = run(spent, 'Orb of Unravelling'); assert.equal(un.item.memory_strands, 0);
  const rem = run(s0({ base: 'Vaal Regalia', item_level: 86 }), 'Orb of Remembrance'); assert.ok(rem.item.memory_strands >= 10 && rem.item.memory_strands <= 100);
});

test('corruption: Vaal outcomes, Altar twice-corruption with destroy branch, Tainted currency', () => {
  const outcomes = new Set();
  for (let seed = 0; seed < 40; seed++) { const s = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'], sockets: { colours: ['W', 'W'], links: [2] } }, { seed }), 'Vaal Orb'); outcomes.add(s.history[0].notes[0]); assert.ok(s.item.corrupted); }
  assert.equal(outcomes.size, 4);
  const statuses = new Set();
  for (let seed = 0; seed < 40; seed++) { const s = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'], corrupted: true }, { seed }), { type: 'altar' }); statuses.add(s.status); if (s.status === 'active') assert.ok(s.item.twice_corrupted); }
  assert.deepEqual([...statuses].sort(), ['active', 'destroyed']);
  assert.match(tryStep(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'], corrupted: true }), 'Chaos Orb').message, /uncorrupted/);
  const t = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10', 'FireResist6'], corrupted: true }), 'Tainted Exalted Orb', 'Tainted Divine Teardrop', 'Tainted Chaos Orb');
  assert.ok(t.item.corrupted);
});

test('sockets, omens and bench socket crafts', () => {
  const s = s0({ base: 'Vaal Regalia', item_level: 86, sockets: { colours: ['W', 'W', 'W'], links: [1, 1, 1] } });
  const j = run(s, "Jeweller's Orb"); assert.notEqual(j.item.sockets.colours.length, 3);
  const o = run(s, { type: 'currency', name: "Jeweller's Orb", omen: 'Omen of the Jeweller' }); assert.equal(o.item.sockets.colours.length, 6);
  const link = [...catalog.recipes.values()].find(r => r.actions.link_sockets === 3).id;
  assert.deepEqual(run(s, { type: 'bench', recipe: link }).item.sockets.links, [3]);
  const ch = run(s, 'Chromatic Orb'); assert.notDeepEqual(ch.item.sockets.colours, ['W', 'W', 'W']);
  const tri = run(s, { type: 'currency', name: 'Chromatic Orb', omen: 'Omen of Trichromatism' }); assert.deepEqual([...tri.item.sockets.colours].sort(), ['B', 'G', 'R']);
  const white = [...catalog.recipes.values()].find(r => r.actions.color_sockets === 'w').id;
  assert.deepEqual(run(ch, { type: 'bench', recipe: white }).item.sockets.colours, ['W', 'W', 'W']);
  const corrupted = s0({ base: 'Vaal Regalia', item_level: 86, corrupted: true, sockets: { colours: ['W', 'W', 'W'], links: [1, 1, 1] } });
  const vaalCost = run(corrupted, { type: 'bench', recipe: link }).history[0].cost; assert.equal(vaalCost['Vaal Orb'], 3);
});

test('catalysts scale matching mods for catalysed targets', () => {
  const life = catalog.mods.get('IncreasedLife5'), top = life.stats[0].max;
  let s = s0({ base: 'Amber Amulet', item_level: 50, rarity: 'rare', mods: [{ id: 'IncreasedLife5', values: [top] }] }, { target: { stats: [{ id: 'base_maximum_life', min: Math.floor(top * 1.2), scope: 'catalysed' }] } });
  for (let i = 0; i < 20 && s.item.quality < 20; i++) s = run(s, 'Fertile Catalyst');
  assert.equal(s.item.quality, 20); assert.equal(s.item.quality_type, 'fertile');
  assert.equal(observe(catalog, s, { includeActions: false }).target_met, true);
  s = run(s, 'Prismatic Catalyst'); assert.ok(s.item.quality < 20);
});

test("Hinekora's Lock preview equals the applied result; bench removes foresight", () => {
  const s = run(s0({ base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'] }), "Hinekora's Lock");
  const seen = preview(catalog, s, 'Chaos Orb');
  assert.deepEqual(preview(catalog, s, 'Chaos Orb'), seen);
  assert.deepEqual(run(s, 'Chaos Orb').item.mods, seen.mods);
  const benched = run(s, { type: 'bench', recipe: recipeFor('ColdResist', 'Body Armour') });
  assert.equal(benched.item.foreseeing, null);
});

test('recombinator combines two inventory items into one output and enforces 3.30 refusals', () => {
  const s = createSession(catalog, { item: { base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10', 'FireResist6'] },
    inventory: { b: { base: 'Vaal Regalia', item_level: 75, rarity: 'rare', mods: ['LocalIncreasedEnergyShield8', 'ColdResist6'] } }, seed: 5 });
  const out = run(s, { type: 'recombinator', other: 'b' });
  assert.equal(Object.keys(out.inventory).length, 0); assert.ok([86, 75].includes(out.item.item_level));
  const bad = createSession(catalog, { item: { base: 'Vaal Regalia', item_level: 86, rarity: 'rare', mods: ['IncreasedLife10'], corrupted: true }, inventory: { b: { base: 'Vaal Regalia', item_level: 75, rarity: 'rare', mods: ['ColdResist6'] } }, seed: 5 });
  assert.match(tryStep(bad, { type: 'recombinator', other: 'b' }).message, /corrupted/);
});

test('unpublished odds require explicit assumptions; failures are atomic; replay detects tampering', () => {
  const s = s0({ base: 'Vaal Regalia', item_level: 86 });
  assert.match(tryStep(s, 'Orb of Chance').message, /assume/);
  const c = run(s, { type: 'currency', name: 'Orb of Chance', assume: { magic: 1, rare: 0, unique: 0 } }); assert.equal(c.item.rarity, 'magic');
  const budget = createSession(catalog, { item: { base: 'Vaal Regalia', item_level: 86 }, seed: 1, budget: { 'Orb of Alchemy': 1 } });
  const once = run(budget, 'Orb of Alchemy'); assert.match(tryStep(once, 'Chaos Orb').message, /Budget/);
  const tampered = structuredClone(once); tampered.item.mods[0].values[0] = catalog.mods.get(tampered.item.mods[0].id).stats[0].max;
  if (JSON.stringify(tampered) !== JSON.stringify(once)) assert.throws(() => replay(catalog, tampered), /Replay mismatch/);
  assert.ok(once.history[0].rules.includes('count.rare'));
  assert.ok(observe(catalog, once, { includeActions: false }).approximations_used.length > 0);
});

test('PoB export, training and CLI', () => {
  const s = run(s0({ base: 'Vaal Regalia', item_level: 86, sockets: { colours: ['W', 'W'], links: [2] } }), 'Orb of Alchemy');
  try { const out = exportPob(catalog, s.item); assert.match(out.text, /Vaal Regalia/); } catch (e) { assert.match(e.message, /Cannot safely export|handler/); }
  const result = train(catalog, { start: { item: { base: 'Leather Belt', item_level: 86 }, target: { stats: [{ id: 'base_maximum_life', min: 70 }] } },
    policy: [{ when: { rarity: 'normal' }, action: 'Orb of Transmutation' }, { when: { open_prefixes: 1 }, action: 'Orb of Augmentation' }, { action: 'Orb of Alteration' }] }, { episodes: 20, max_steps: 60, seed: 2 });
  assert.equal(result.episodes, 20); assert.ok(result.outcomes.success > 0);
  assert.equal(cli(['tiers', '--base', 'Vaal Regalia', '--ilvl', '86', '--match', 'IncreasedLife', '--limit', '1']).rows[0].tiers[0].id, 'IncreasedLife12');
  assert.ok(cli(['rules', '--match', '3.30']));
});

test('agent.mjs exposes the simulator as craftsim and doctor checks it', async () => {
  const { agent } = await import('../../../../scripts/agent.mjs');
  assert.equal(agent(['craftsim', 'status']).model.id, 'craft-lab-v2');
  assert.ok(agent(['help']).commands[Object.keys(agent(['help']).commands).find(k => k.startsWith('craftsim'))]);
  const s = agent(['craftsim', 'new', '--file', (await import('node:url')).fileURLToPath(new URL('../examples/body-life-es.json', import.meta.url))]);
  assert.equal(s.session.revision, 0);
});
