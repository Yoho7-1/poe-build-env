import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, digest, root } from '../catalog.mjs';
import { createSession, step, replay, observe, meets } from '../session.mjs';
import { count, capacity, pool, meta } from '../state.mjs';
import { drawCount } from '../operations.mjs';
import { train } from '../training.mjs';
import { exportPob, renderRoll } from '../export.mjs';
import { cli, save } from '../cli.mjs';
import { random } from '../../engine.mjs';

const c = loadCatalog();
const start = (item = {}, extra = {}) => createSession(c, { item: { base: 'Amber Amulet', item_level: 86, ...item }, seed: 42, ...extra });
function recipeFor(modId, itemClass = 'Amulet') {
  return [...c.recipes.values()].find(row => row.actions.add_explicit_mod === modId && row.item_classes.includes(itemClass));
}

test('v1 has broad data coverage while v0 files and sessions remain separate', () => {
  assert.equal(c.bases.size, 1720); assert.equal(c.mods.size, 41336); assert.equal(c.recipes.size, 782);
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'baseline.json')));
  assert.ok(baseline.files.some(row => row.file.endsWith('craft-lab/engine.mjs')));
  assert.throws(() => start({ base: 'Mageblood' }), /not admitted/);
  assert.throws(() => start({ typo: true }), /Unsupported/);
});

test('normal-to-magic-to-rare works across equipment, jewels, flasks and tinctures', () => {
  for (const base of ['Amber Amulet', 'Vaal Regalia', 'Cobalt Jewel', 'Ghastly Eye Jewel', 'Quicksilver Flask', 'Prismatic Tincture']) {
    let s = start({ base }); s = step(c, s, 'Orb of Transmutation'); s = step(c, s, 'Orb of Alteration');
    assert.ok(s.item.mods.length >= 1 && s.item.mods.length <= 2);
    if (['Quicksilver Flask', 'Prismatic Tincture'].includes(base)) assert.throws(() => step(c, s, 'Regal Orb'), /cannot be rare/);
    else { s = step(c, s, 'Regal Orb'); s = step(c, s, 'Chaos Orb'); assert.equal(s.item.rarity, 'rare'); }
    assert.deepEqual(replay(c, s), s);
  }
});

test('rare counts follow the declared reference 8:3:1 and jewel capacity model', () => {
  const s = start({ rarity: 'rare' }), rng = random(123), seen = { 4: 0, 5: 0, 6: 0 };
  for (let i = 0; i < 12000; i++) seen[drawCount(c, s.item, rng)]++;
  for (const [n, expected] of [[4, 8 / 12], [5, 3 / 12], [6, 1 / 12]]) assert.ok(Math.abs(seen[n] / 12000 - expected) < 0.02);
  assert.equal(capacity(c, start({ base: 'Cobalt Jewel', rarity: 'rare' }).item).total, 4);
});

test('experimental implicit capacities and cluster skill tags are part of the pool context', () => {
  const focused = start({ base: 'Focused Amulet', rarity: 'rare' });
  assert.deepEqual(capacity(c, focused.item), { prefix: 2, suffix: 1, total: 3 });
  let cluster = start({ base: 'Large Cluster Jewel', cluster: { skill: 'affliction_axe_and_sword_damage', passives: 8 } });
  cluster = step(c, cluster, 'Orb of Alchemy');
  assert.ok(cluster.item.mods.length >= 3 && cluster.item.mods.length <= 4);
  assert.throws(() => start({ base: 'Large Cluster Jewel' }), /needs explicit/);
});

test('bench respects unlocks, class, conflicts, source costs and crafted limits', () => {
  const row = [...c.recipes.values()].find(row => row.actions.add_explicit_mod && row.item_classes.includes('Amulet') && c.mods.get(row.actions.add_explicit_mod)?.stats.some(stat => stat.id === 'base_maximum_life'));
  assert.ok(row);
  assert.throws(() => step(c, start(), { type: 'bench', recipe: row.id }), /unlock/);
  const s = step(c, start({}, { unlocked_recipes: [row.id] }), { type: 'bench', recipe: row.id });
  assert.equal(s.item.rarity, 'magic'); assert.equal(s.item.mods[0].kind, 'crafted'); assert.ok(Object.keys(s.spent).length);
  assert.throws(() => step(c, s, { type: 'bench', recipe: row.id }), /limit|conflict/);
  assert.throws(() => step(c, start({ base: 'Quicksilver Flask' }, { unlocked_recipes: [row.id] }), { type: 'bench', recipe: row.id }), /item class/);
});

test('full and counted 3.30 locks survive on the correct side and use current multi-currency costs', () => {
  const lock = recipeFor('StrMasterItemGenerationCannotChangePrefixesC'); assert.ok(lock);
  let s = start({ rarity: 'rare', mods: ['IncreasedLife5', 'Strength1'] }, { unlocked_recipes: [lock.id] });
  s = step(c, s, { type: 'bench', recipe: lock.id });
  assert.equal(s.spent['Divine Orb'], 4); assert.equal(s.spent['Exalted Orb'], 8);
  s = step(c, s, 'Orb of Scouring');
  assert.deepEqual(s.item.mods.map(roll => roll.id), ['IncreasedLife5']); assert.equal(s.item.rarity, 'magic');
  const counted = recipeFor('StrMasterItemGenerationCannotChangeOnePrefixesC');
  s = start({ rarity: 'rare', mods: ['IncreasedLife5', 'IncreasedMana5'] }, { unlocked_recipes: [counted.id] });
  s = step(c, s, { type: 'bench', recipe: counted.id }); s = step(c, s, 'Orb of Scouring');
  assert.equal(s.item.mods.length, 1);
});

test('3.30 Annulment ignores Cannot roll Caster/Attack filters', () => {
  const caster = [...c.mods.values()].find(mod => mod.domain === 'item' && mod.generation_type === 'prefix' && mod.implicit_tags.includes('caster') && mod.spawn_weights.some(w => w.tag === 'amulet' && w.weight > 0)); assert.ok(caster);
  let removedCaster = false;
  for (let seed = 0; seed < 20; seed++) {
    let s = createSession(c, { item: { base: 'Amber Amulet', item_level: 100, rarity: 'rare', mods: [caster.id, { id: 'StrDexMasterItemGenerationCannotRollCasterAffixes', kind: 'crafted' }] }, seed });
    assert.ok(meta(c, s.item).caster); s = step(c, s, 'Orb of Annulment');
    removedCaster ||= !s.item.mods.some(roll => roll.id === caster.id);
  }
  assert.equal(removedCaster, true);
});

test('fractured modifiers and their exact rolls survive rerolls and Scouring', () => {
  let s = start({ rarity: 'rare', mods: [{ id: 'IncreasedLife5', fractured: true, values: [81] }, 'Strength1'] });
  s = step(c, s, 'Chaos Orb'); assert.equal(s.item.mods.find(roll => roll.id === 'IncreasedLife5').values[0], 81);
  s = step(c, s, 'Orb of Scouring'); assert.equal(s.item.mods.length, 1); assert.equal(s.item.mods[0].fractured, true);
  assert.throws(() => start({ rarity: 'rare', influences: ['Shaper'], mods: [{ id: 'IncreasedLife5', fractured: true }] }), /cannot coexist/);
});

test('Essence guarantees its source modifier and ordinary Fossils block tag families', () => {
  let s = start(); s = step(c, s, { type: 'essence', essence: 'Deafening Essence of Greed' });
  const essence = [...c.essences.values()].find(row => row.name === 'Deafening Essence of Greed');
  assert.ok(s.item.mods.some(roll => roll.id === essence.mods.Amulet));
  s = step(c, s, { type: 'fossils', fossils: ['Scorched Fossil'] });
  assert.ok(s.item.mods.every(roll => !c.mods.get(roll.id).implicit_tags.includes('cold')));
  assert.throws(() => step(c, s, { type: 'fossils', fossils: ['Scorched Fossil', 'Scorched Fossil'] }), /duplicate/);
  assert.throws(() => step(c, s, { type: 'fossils', fossils: ['Sanctified Fossil'] }), /independently verified/);
});

test('influence orbs add the influence and a matching influenced affix', () => {
  let s = start({ rarity: 'rare', mods: ['IncreasedLife5'] }); s = step(c, s, "Hunter's Exalted Orb");
  assert.deepEqual(s.item.influences, ['Hunter']);
  assert.ok(s.item.mods.some(roll => c.mods.get(roll.id).spawn_weights.some(w => w.tag === 'amulet_basilisk' && w.weight > 0)));
  assert.throws(() => step(c, s, "Crusader's Exalted Orb"), /Invalid influence/);
});

test('Eldritch implicits determine which explicit side can be modified', () => {
  let s = start({ base: 'Vaal Regalia', rarity: 'rare' });
  s = step(c, s, 'Greater Eldritch Ember'); s = step(c, s, 'Lesser Eldritch Ichor');
  assert.equal(s.item.eldritch.exarch.tier, 2); assert.equal(s.item.eldritch.eater.tier, 1);
  s = step(c, s, 'Eldritch Exalted Orb'); assert.deepEqual(count(c, s.item), { prefix: 1, suffix: 0 });
  s = step(c, s, 'Eldritch Orb of Annulment'); assert.equal(s.item.mods.length, 0);
  assert.throws(() => step(c, start(), 'Lesser Eldritch Ember'), /Invalid base/);
});

test('Harvest reforge and imprint/restoration have explicit resource accounting', () => {
  let s = start({ rarity: 'magic', mods: ['IncreasedLife5'] });
  s = step(c, s, { type: 'beast', method: 'imprint', cost: { 'Craicic Chimeral': 1, 'Yellow Beast': 3 } });
  const oldItem = structuredClone(s.item); s = step(c, s, 'Regal Orb');
  s = step(c, s, { type: 'beast', method: 'restore_imprint' }); assert.deepEqual(s.item, oldItem);
  s = step(c, s, 'Regal Orb'); s = step(c, s, { type: 'harvest', method: 'reforge', tag: 'fire', cost: { 'Primal Crystallised Lifeforce': 50 } });
  assert.ok(s.item.mods.some(roll => c.mods.get(roll.id).implicit_tags.includes('fire')));
  assert.equal(s.spent['Craicic Chimeral'], 1); assert.equal(s.spent['Primal Crystallised Lifeforce'], 50);
  assert.throws(() => step(c, s, { type: 'harvest', method: 'reforge', tag: 'fire' }), /object|cost/);
});

test('unveil offers do not consume slots until an explicit choice is made', () => {
  let s = start({ rarity: 'rare', mods: ['IncreasedLife5', 'Strength1', 'FireResist1', 'ColdResist1'] });
  s = step(c, s, 'Veiled Exalted Orb'); s = step(c, s, { type: 'unveil' });
  assert.ok(s.offers.ids.length >= 1); const id = s.offers.ids[0];
  s = step(c, s, { type: 'choose_unveil', index: 0 }); assert.equal(s.offers, null);
  assert.ok(s.item.mods.some(roll => roll.id === id && roll.kind === 'unveiled')); replay(c, s);
});

test('illegal steps, unsupported mechanics, corruption and budget failures are atomic', () => {
  const s = start({}, { budget: { 'Chaos Orb': 1 } }), original = digest(s);
  for (const action of ['Orb of Transmutation', 'Chaos Orb', 'Vaal Orb', 'Foulborn Exalted Orb']) assert.throws(() => step(c, s, action));
  assert.equal(digest(s), original);
  assert.throws(() => step(c, start({ corrupted: true }), 'Orb of Transmutation'), /uncorrupted/);
  const changed = structuredClone(start()); changed.spent['Chaos Orb'] = 1; assert.throws(() => replay(c, changed), /Replay mismatch/);
  assert.throws(() => start({}, { budget: JSON.parse('{"__proto__":1}') }), /Invalid budget/);
});

test('adaptive training restarts from normal and includes failures and start costs', () => {
  const exercise = { start: { item: { base: 'Amber Amulet', item_level: 86 }, start_cost: { 'Chaos Orb': 2 }, target: { rarity: 'rare', groups: ['IncreasedLife'] } },
    policy: [{ when: { rarity: 'normal' }, action: 'Orb of Alchemy' }, { action: 'Chaos Orb' }] };
  const result = train(c, exercise, { episodes: 20, seed: 7, max_steps: 20 });
  assert.equal(Object.values(result.outcomes).reduce((a, b) => a + b, 0), 20);
  assert.ok(result.total_spent['Chaos Orb'] >= 40); assert.equal(result.acquisition_cost_included, true);
  assert.deepEqual(train(c, exercise, { episodes: 20, seed: 7, max_steps: 20 }), result);
  assert.throws(() => train(c, { ...exercise, policy: [{ action: 'Vaal Orb' }] }), /Unimplemented/);
});

test('safe export translates actual rolls and refuses unsupported handlers and quality', () => {
  const s = start({ rarity: 'rare', mods: [{ id: 'IncreasedLife5', values: [81] }, { id: 'FireResist1', values: [9] }] });
  const result = exportPob(c, s.item);
  assert.ok(result.text.includes('+81 to maximum Life')); assert.ok(result.text.includes('+9% to Fire Resistance'));
  assert.ok(!/[^\x0a\x20-\x7e]/.test(result.text));
  assert.throws(() => exportPob(c, start({ quality: 20 }).item), /Quality/);
});

test('CLI truncation preserves denominator and snapshots cannot overwrite', () => {
  assert.ok(cli(['bases', '--match', 'Amulet', '--limit', '1']).omitted > 0);
  const name = `test-v1-${process.pid}-${Date.now()}`; let file;
  try { file = save(name, { value: 1 }); assert.throws(() => save(name, { value: 2 }), /EEXIST/); assert.throws(() => save('../escape', {})); }
  finally { if (file) fs.unlinkSync(file); }
});
