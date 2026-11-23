import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dbRoot } from '../scripts/workspace.mjs';
import { loadEnemyDb, buildEnemyDb, translateStats, bandOfTier, areaLevelOfTier, enemyLife, resolveMapMod, listMapMods, luaNumberTable } from '../scripts/enemy-db.mjs';
import { buildEncounter, parseEnemy, mergeChanges } from '../scripts/encounter.mjs';
import { defenceOf, damageOf, buildChecks, sweepVerdict, markdownReport } from '../scripts/analysis-encounter.mjs';
import { loadBossScenarios } from '../scripts/analysis-bosses.mjs';
import { runPob } from '../scripts/pob.mjs';
import * as enemyDbModule from '../scripts/enemy-db.mjs';
import * as atlasModule from '../scripts/atlas-combat.mjs';

const db = loadEnemyDb();
const bosses = loadBossScenarios();
const fixture = fs.readFileSync(path.join(dbRoot, 'fixtures/fireball-control.xml'), 'utf8');

test('tracked enemy database matches a fresh build from the pinned sources', () => {
  const fresh = buildEnemyDb();
  assert.deepEqual(fresh.provenance, db.provenance);
  assert.deepEqual(Object.keys(fresh.map_mods), Object.keys(db.map_mods));
  assert.equal(fresh.pob_map_affixes.unmatched_in_repoe.length, 0, 'every PoB map affix has a RePoE 3.30 mod');
});

test('map tiers, area levels and level tables follow PoB/RePoE', () => {
  assert.equal(bandOfTier(1), 'white'); assert.equal(bandOfTier(10), 'yellow'); assert.equal(bandOfTier(16), 'red'); assert.equal(bandOfTier(17), 't17');
  assert.throws(() => bandOfTier(18), /1-17/);
  assert.equal(areaLevelOfTier(16), 83); assert.equal(areaLevelOfTier(17), 84);
  assert.deepEqual(luaNumberTable('data.x = { 3, 4, [10] = 7, }', 'data.x'), { 1: 3, 2: 4, 10: 7 });
  assert.ok(db.levels[83].damage > db.levels[68].damage && db.levels[83].life > 0);
  assert.equal(db.rarity.rare.life_more, 390); assert.equal(db.rarity.unique.damage_more, 70);
});

test('catalogue: PoB affixes for white-red, translations for T17, unmodelled mechanics keep danger axes', () => {
  const savage = resolveMapMod(db, 'Savage');
  assert.equal(savage.tiers.red.engine.method, 'pob_map_affix');
  assert.equal(savage.tiers.red.engine.pob_tier, 'HIGH');
  assert.deepEqual(savage.tiers.t17.engine.enemy_mods, [{ name: 'Damage', type: 'INC', value: 40 }]);
  assert.equal(resolveMapMod(db, 'of exposure').tiers.t17.engine.custom_mods[0], '-20% to all maximum Resistances');
  assert.deepEqual(resolveMapMod(db, 'penetration').tiers.t17.engine.pen, { Fire: 15, Cold: 15, Lightning: 15 });
  const punishing = resolveMapMod(db, 'punishing');
  assert.equal(punishing.tiers.red.engine.method, 'not_modelled');
  assert.ok(punishing.danger_axes.includes('reflect_physical'));
  assert.equal(resolveMapMod(db, 'prismatic').tiers.t17.engine.method, 'partial');
  assert.match(resolveMapMod(db, 'curses').tiers.t17.engine.custom_mods.join(), /Level 15 Elemental Weakness/);
  assert.ok(!/Threads|Atlas Drops/.test(resolveMapMod(db, 'curses').tiers.t17.text));
  assert.throws(() => resolveMapMod(db, 'no-such-mod'), /Unknown map mod/);
  const red = listMapMods(db, { band: 'red', method: 'not_modelled' }).map(m => m.id);
  assert.ok(red.includes('punishing') && !red.includes('venom'), 'method filter is per band');
  for (const m of Object.values(db.map_mods)) for (const t of Object.values(m.tiers)) {
    assert.deepEqual(t.engine.unknown_stats ?? [], [], `${m.id} has unclassified stats`);
    // A PoB affix can only be selected from the drop-down of the same affix kind.
    if (t.engine.method === 'pob_map_affix') assert.ok(db.pob_map_affixes[m.affix === 'prefix' ? 'prefixes' : 'suffixes'].includes(t.engine.pob_affix), `${m.id} not selectable as ${m.affix}`);
  }
  assert.equal(resolveMapMod(db, 'unwavering').tiers.red.engine.method, 'translated', 'PoB data without a drop-down entry is translated');
});

test('stat translation picks the worst roll, merges speed and splits random elements explicitly', () => {
  const r = translateStats([{ id: 'map_additional_player_maximum_resistances_%', min: -12, max: -9 }, { id: 'map_monsters_attack_speed_+%', min: 35, max: 45 }, { id: 'map_monsters_cast_speed_+%', min: 35, max: 40 },
    { id: 'map_monsters_physical_damage_%_to_add_as_random_element', min: 180, max: 200 }, { id: 'map_item_drop_quantity_+%', min: 10, max: 10 }, { id: 'map_packs_are_ghosts', min: 1, max: 1 }]);
  assert.deepEqual(r.custom_mods, ['-12% to all maximum Resistances']);
  assert.deepEqual(r.enemy_mods.filter(m => m.name === 'Speed'), [{ name: 'Speed', type: 'INC', value: 45 }]);
  assert.equal(r.enemy_mods.filter(m => m.name.startsWith('PhysicalDamageGainAs')).length, 3);
  assert.equal(r.approximate, true);
  assert.deepEqual(r.content, ['map_packs_are_ghosts']);
});

test('encounters: archetype level from map tier, PoB slots and tier, penetration adds to boss presets', () => {
  const rare = buildEncounter(db, bosses, { enemy: 'rare', tier: 16, mods: ['savage', 'resistant', 'of exposure', 'punishing'] });
  assert.equal(rare.changes.config.enemyLevel, 83);
  assert.equal(rare.changes.config.enemyIsBoss, 'None');
  assert.equal(rare.changes.config.conditionEnemyRareOrUnique, true);
  assert.equal(rare.changes.config.multiplierMapModTier, 'HIGH');
  assert.equal(rare.changes.config.MapPrefix1, 'Savage');
  assert.equal(rare.changes.config.MapPrefix2, 'Resistant');
  assert.equal(rare.changes.config.MapSuffix1, 'of Exposure');
  assert.ok(rare.changes.enemy_mods.some(m => m.source === 'Monster rarity rare' && m.name === 'Life'));
  assert.equal(rare.not_modelled[0].id, 'punishing');
  assert.ok(rare.life.value > 0);
  const t17 = buildEncounter(db, bosses, { enemy: 'boss:Shaper:Shaper Ball', tier: 17, mods: ['penetration'] });
  assert.equal(t17.changes.config.presetBossSkills, 'Shaper Ball');
  assert.equal(t17.changes.config.enemyColdPen, 55, 'preset 40% + map 15%');
  assert.equal(t17.changes.config.enemyFirePen, 15);
  assert.equal(t17.life.value, null);
  const uber = buildEncounter(db, bosses, { enemy: 'uber', tier: 17, mods: ['penetration'] });
  assert.equal(uber.changes.config.enemyFirePen, bosses.misc.uberBossPen + 15);
  const effect = buildEncounter(db, bosses, { enemy: 'rare', tier: 17, mods: ['savage', 'curses'], map_mod_effect: 50 });
  assert.equal(effect.changes.enemy_mods.find(m => m.source.startsWith('Map mod Savage')).value, 60);
  assert.match(effect.changes.custom_mods, /Level 15 Vulnerability/);
  assert.equal(buildEncounter(db, bosses, { enemy: 'rare', tier: 16, mods: ['stalwart'] }).modifiers[0].status, 'not_on_this_tier');
  // "Unique Boss" mods: not applied to rares (PoB would), applied to the map boss.
  const rareBoss = buildEncounter(db, bosses, { enemy: 'rare', tier: 16, mods: ['overlords'] });
  assert.equal(rareBoss.modifiers[0].status, 'boss_only_not_applied');
  assert.equal(rareBoss.changes.config.MapPrefix1, undefined);
  assert.equal(buildEncounter(db, bosses, { enemy: 'map_boss', tier: 16, mods: ['overlords'] }).changes.config.MapPrefix1, "Overlord's");
  const plain = buildEncounter(db, bosses, { enemy: 'rare', tier: 16 }).life.value;
  assert.ok(Math.abs(buildEncounter(db, bosses, { enemy: 'rare', tier: 16, mods: ['buffered'] }).life.value / plain - 1.49) < 0.001, 'Buffered ES is part of the life pool');
  assert.throws(() => buildEncounter(db, bosses, { enemy: 'dragon' }), /Unknown enemy/);
  assert.deepEqual(parseEnemy('boss:Maven:Maven Fireball'), { kind: 'boss', boss: 'Maven', skill: 'Maven Fireball' });
  assert.deepEqual(mergeChanges({ config: { a: 1 }, custom_mods: 'x' }, { config: { b: 2 }, custom_mods: 'y', enemy_mods: [{ name: 'Life', type: 'MORE', value: 1 }] }),
    { config: { a: 1, b: 2 }, custom_mods: 'x\ny', enemy_mods: [{ name: 'Life', type: 'MORE', value: 1 }] });
});

test('enemy life is estimated only where local data can give it', () => {
  const normal = enemyLife(db, 'normal', 83), rare = enemyLife(db, 'rare', 83);
  assert.ok(Math.abs(rare.value - normal.value * 4.9) <= 5, `${rare.value} vs ${normal.value} x 4.9`);
  assert.equal(enemyLife(db, 'map_boss', 83).value, null);
});

test('assessment: verdicts, minion scope, build checks and sweep rules', () => {
  const o = { NumberOfDamagingHits: 0.6, PhysicalMaximumHitTaken: 900, FireMaximumHitTaken: 500, PhysicalTakenHit: 1500, TotalEHP: 800, CombinedDPS: 0, FullDPS: 0,
    PhysicalHitAverage: 100, LifeRegenRecovery: 90, LifeLeechGainRate: 10, IgniteAvoidChance: 100, FreezeAvoidChance: 100, ShockAvoidChance: 50 };
  const d = defenceOf(o);
  assert.equal(d.verdict, 'one_shot'); assert.equal(d.weakest_type, 'Fire'); assert.equal(d.dominant_type, 'Physical');
  assert.equal(defenceOf({ NumberOfDamagingHits: 1.2 }).verdict, 'dangerous');
  assert.equal(defenceOf({ NumberOfDamagingHits: 5 }).verdict, 'survives_hit');
  assert.equal(defenceOf({}).verdict, 'unknown');
  const m = damageOf(o, { value: 10000, basis: 'x' }, { CombinedDPS: 5000 });
  assert.equal(m.scope, 'minion'); assert.equal(m.time_to_kill_s, 2);
  const checks = Object.fromEntries(buildChecks(['reflect_physical', 'reflect_elemental', 'no_regeneration', 'ailments_on_player', 'boss_possessed'], o).map(c => [c.axis, c.status]));
  assert.deepEqual(checks, { reflect_physical: 'risk', reflect_elemental: 'ok', no_regeneration: 'risk', ailments_on_player: 'caution', boss_possessed: 'manual' });
  const row = (vs, verdict = 'survives_hit', bc = [], method = 'pob_map_affix') => ({ vs_clean: { clean_verdict: 'survives_hit', ...vs }, defence: { verdict }, build_checks: bc, modifiers: [{ method }] });
  assert.equal(sweepVerdict(row({ dps_pct: -45 })).verdict, 'avoid');
  assert.equal(sweepVerdict(row({ dps_pct: -1 }, 'one_shot')).verdict, 'avoid');
  assert.equal(sweepVerdict(row({ hits_to_die_pct: -25 })).verdict, 'caution');
  assert.equal(sweepVerdict(row({}, 'survives_hit', [{ axis: 'reflect_physical', status: 'risk' }], 'not_modelled')).verdict, 'avoid');
  assert.equal(sweepVerdict(row({}, 'survives_hit', [{ axis: 'hazards', status: 'manual' }], 'not_modelled')).verdict, 'manual');
  assert.equal(sweepVerdict(row({ dps_pct: -3 })).verdict, 'ok');
  const md = markdownReport({ analysis: 'encounter', label: 'X', build_file: 'b.xml', scenario: 'sustained', damage: damageOf(o, null), defence: d, vs_clean: null, modifiers: [], build_checks: [], assumptions: [], disclaimer: 'D' });
  assert.match(md, /# X/); assert.match(md, /ваншот/);
});

test('engine: boss preset uses the uber selection, map affix tiers and enemy mods apply, custom mod parsing is reported', { timeout: 120000 }, () => {
  // Regression: PoB reads enemyIsBoss / multiplierMapModTier from the drop-down state, not only the input value.
  const slam = bosses.bosses.Shaper.tiers.uber.skills.find(s => s.skill === 'Shaper Slam');
  const uber = runPob({ input: fixture, scenario: 'sustained', changes: { config: slam.config }, full: true });
  assert.equal(uber.output.totalEnemyDamageIn, slam.damage.Physical);
  const base = runPob({ input: fixture, changes: {}, full: true }).output.totalEnemyDamage;
  const low = runPob({ input: fixture, changes: { config: { MapPrefix1: 'Savage', multiplierMapModTier: 'LOW' } }, full: true }).output.totalEnemyDamage;
  const high = runPob({ input: fixture, changes: { config: { MapPrefix1: 'Savage', multiplierMapModTier: 'HIGH' } }, full: true }).output.totalEnemyDamage;
  assert.ok(Math.abs(low / base - 1.17) < 0.001 && Math.abs(high / base - 1.25) < 0.001, `Savage LOW/HIGH ${low / base} ${high / base}`);
  assert.throws(() => runPob({ input: fixture, changes: { config: { MapPrefix1: 'Nonexistent' } } }), /Unknown value for configuration option MapPrefix1/);
  const em = runPob({ input: fixture, changes: { enemy_mods: [{ name: 'Damage', type: 'INC', value: 40, source: 'test' }], custom_mods: 'Buffs on you expire 100% faster' }, full: true });
  assert.ok(Math.abs(em.output.totalEnemyDamage / base - 1.4) < 0.001);
  assert.deepEqual(em.unparsed_custom_mods.map(u => u.line), ['Buffs on you expire 100% faster']);
  assert.throws(() => runPob({ input: fixture, changes: { enemy_mods: [{ name: 'Damage', type: 'SUM', value: 1 }] } }), /enemy_mods/);
  // Every translated player-side line in the catalogue must be parseable by the pinned engine.
  const lines = [...new Set(Object.values(db.map_mods).flatMap(m => Object.values(m.tiers).flatMap(t => t.engine.custom_mods ?? [])))];
  const parsed = runPob({ input: fixture, changes: { custom_mods: lines.join('\n') }, full: true });
  assert.deepEqual(parsed.unparsed_custom_mods, [], 'translated custom modifiers are all parsed by PoB');
});

test('boss varieties: derived life range, real resistances, uber life unknown', () => {
  const { bossLifeEstimate } = enemyDbModule;
  const est = bossLifeEstimate(db, 'Shaper', 84);
  assert.ok(est.range && est.range[0] > 1e6 && est.range[1] >= est.range[0], JSON.stringify(est.range));
  assert.match(est.basis, /not verified in game/);
  assert.equal(bossLifeEstimate(db, 'NoSuchBoss').range, null);
  const atz = buildEncounter(db, bosses, { enemy: 'boss:Atziri', boss_tier: 'pinnacle' });
  assert.equal(atz.changes.config.enemyFireResist, 40, 'Wiki variety resistance replaces the PoB 50% default');
  assert.deepEqual(atz.life.range, bossLifeEstimate(db, 'Atziri', 84).range);
  const uber = buildEncounter(db, bosses, { enemy: 'boss:Shaper:Shaper Slam', boss_tier: 'uber' });
  assert.equal(uber.life.range, null);
  assert.match(uber.life.basis, /Uber life scaling/);
  const given = buildEncounter(db, bosses, { enemy: 'boss:Shaper:Shaper Slam', boss_tier: 'uber', enemy_life: 1e8 });
  assert.equal(given.life.value, 1e8);
});

test('damage profiles keep the PoB generic total; pantheon values are validated', () => {
  const mixed = buildEncounter(db, bosses, { enemy: 'rare', tier: 16, damage_profile: 'mixed' }).changes.config;
  const total = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'].reduce((a, t) => a + mixed[`enemy${t}Damage`], 0);
  assert.ok(Math.abs(total - db.levels[83].damage * 1.5) <= 3, `${total}`);
  assert.equal(buildEncounter(db, bosses, { enemy: 'rare', tier: 16, damage_profile: 'cold' }).changes.config.enemyColdDamage, Math.round(db.levels[83].damage * 1.5));
  assert.throws(() => buildEncounter(db, bosses, { enemy: 'map_boss', damage_profile: 'fire' }), /damage-profile/);
  assert.throws(() => buildEncounter(db, bosses, { enemy: 'rare', damage_profile: 'void' }), /damage-profile/);
  assert.equal(buildEncounter(db, bosses, { enemy: 'rare', pantheon_major: 'Arakaali' }).changes.config.pantheonMajorGod, 'Arakaali');
  assert.throws(() => buildEncounter(db, bosses, { enemy: 'rare', pantheon_minor: 'Arakaali' }), /pantheon-minor/);
});

test('atlas: generic monster lines and explicit modifier effect are translated, others listed', () => {
  const nodes = [{ name: 'Dance of Destruction', stats: ['Monsters in your Maps deal 25% more Damage', 'Monsters in your Maps have 25% less Life'] },
    { name: 'Mounting Modifiers', stats: ['2% increased effect of Explicit Modifiers on your Maps per Explicit Modifier'] },
    { name: 'True Terrors', stats: ['Unique Monsters in your Maps have 2 additional Monster Modifiers'] }];
  const e = atlasModule.atlasEffects(['Dance of Destruction', 'Mounting Modifiers', 'True Terrors'], { explicitModCount: 6, nodes });
  assert.deepEqual(e.enemy_mods.map(m => [m.name, m.value]), [['Damage', 25], ['Life', -25]]);
  assert.equal(e.map_mod_effect, 12);
  assert.equal(e.not_modelled[0].node, 'True Terrors');
  assert.throws(() => atlasModule.atlasEffects(['Nope'], { nodes }), /Unknown atlas node/);
  const enc = buildEncounter(db, bosses, { enemy: 'rare', tier: 16, mods: ['savage'], atlas: ['Map Modifier Effect'] });
  assert.equal(enc.changes.config.multiplierMapModEffect, 2);
});
