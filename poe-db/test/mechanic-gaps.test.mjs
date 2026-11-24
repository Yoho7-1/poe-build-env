import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gaps, externalReferences } from '../mechanics/gaps.mjs';
import { cards } from '../mechanics/catalog.mjs';
import { mechanicGaps } from '../scripts/mechanics.mjs';
import { recoupSustain, onKillExplosions, thornsRetaliation, parseThorns, degenTolerance, approximateModels, enemyResistsOf } from '../scripts/mechanic-models.mjs';
import { rules, validatePrototype, specFromInspect } from '../scripts/mechanic-validate.mjs';
import { approximationsFor, markdownReport } from '../scripts/analysis-encounter.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const enemies = path.join(root, 'scenarios/enemies.json');
const modelIds = ['recoup_sustain', 'on_kill_explosions', 'thorns_retaliation', 'degen_tolerance'];

test('gap registry: unique ids, known models, rules, cards and sources', () => {
  const ids = gaps.map(g => g.id);
  assert.equal(new Set(ids).size, ids.length);
  const cardIds = new Set(cards.map(c => c.id));
  const sources = new Set(JSON.parse(fs.readFileSync(path.join(root, 'mechanics/sources.json'), 'utf8')).map(s => s.id));
  for (const g of gaps) {
    assert.ok(['not_modelled', 'partial', 'config_assumed'].includes(g.pob_status), g.id);
    assert.ok(g.pob_does && g.gap, g.id);
    if (g.model) assert.ok(modelIds.includes(g.model), `${g.id}: model ${g.model}`);
    for (const r of g.checks) assert.ok(rules[r], `${g.id}: rule ${r}`);
    for (const c of g.cards) assert.ok(cardIds.has(c), `${g.id}: card ${c}`);
    assert.ok(g.sources.length, g.id);
    for (const s of g.sources) assert.ok(sources.has(s) || externalReferences[s], `${g.id}: source ${s}`);
  }
  // every gap model and rule is referenced by some gap
  for (const m of modelIds) assert.ok(gaps.some(g => g.model === m), m);
});

test('gap registry covers every danger axis of the enemy database exactly once', { skip: !fs.existsSync(enemies) }, () => {
  const db = JSON.parse(fs.readFileSync(enemies, 'utf8'));
  const axes = new Set(Object.values(db.map_mods).flatMap(m => m.danger_axes ?? []));
  const owner = new Map();
  for (const g of gaps) for (const a of g.axes) { assert.ok(!owner.has(a), `axis ${a} in ${owner.get(a)} and ${g.id}`); owner.set(a, g.id); }
  for (const a of axes) assert.ok(owner.has(a), `uncovered danger axis ${a}`);
});

test('mechanic gaps: list, filters and one entry with resolved sources', () => {
  const all = mechanicGaps();
  assert.equal(all.total, gaps.length);
  assert.ok(all.with_model.includes('recoup:recoup_sustain'));
  assert.ok(mechanicGaps(null, { status: 'not_modelled' }).results.every(r => r.pob_status === 'not_modelled'));
  assert.deepEqual(mechanicGaps(null, { axis: 'reflect_physical' }).results.map(r => r.id), ['monster_thorns']);
  const one = mechanicGaps('recoup').results[0];
  assert.ok(one.sources.some(s => s.id === 'pob.calc-defence' && s.url?.includes('CalcDefence.lua')));
  assert.ok(one.sources.some(s => s.id === 'wiki.recoup' && s.kind === 'community_wiki'));
  assert.throws(() => mechanicGaps('nope'), /Unknown gap/);
  assert.throws(() => mechanicGaps(null, { status: 'bad' }), /--status/);
});

// Synthetic PoB output: 1000 taken per hit every 0.5 s, 20% life recoup, 300 regen.
const output = { totalTakenHit: 1000, enemySkillTime: 0.5, LifeRecoup: 20, LifeRegenRecovery: 300, LifeLeechGainRate: 0, EnergyShieldRegenRecovery: 0,
  TotalLifeRecoupRecovery: 4000, LifeRecoupRecoveryMax: 1000, LifeRecoupRecoveryAvg: 400, Life: 5000, EnergyShield: 1000,
  FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 0, PhysicalTakenReflect: 1, FireTakenReflect: 0.9, ColdTakenReflect: 0.8, LightningTakenReflect: 0.9,
  ColdHitAverage: 2000 };

test('recoup model: steady-state recovery per second, apart from PoB recovery', () => {
  const m = recoupSustain(output);
  assert.equal(m.applicable, true);
  assert.equal(m.confidence, 'medium');
  assert.equal(m.inputs.recoup_duration_s, 4);
  assert.equal(m.result.taken_per_s, 2000);
  assert.equal(m.result.life_recoup_per_s, 400);
  assert.equal(m.result.recovery_without_recoup_per_s, 300);
  assert.equal(m.result.recovery_with_recoup_per_s, 700);
  assert.equal(m.result.sustain_ratio_with, 0.35);
  assert.equal(m.result.first_window_unrecovered, Math.round(2000 * 4 * (1 - 0.15)));
  assert.equal(recoupSustain({ ...output, LifeRecoupRecoveryMax: 4000 / 3 }).inputs.recoup_duration_s, 3);
  assert.equal(recoupSustain(output, { kind: 'damage_over_time' }).applicable, false);
  assert.equal(recoupSustain({ ...output, LifeRecoup: 0 }).applicable, false);
});

test('explosion model: resistance, pack life ratio and chain', () => {
  const mods = [{ amount: 25, chance: 0.5, type: 'Chaos', conditions: ['enemy:Cursed'], source_name: 'Profane Bloom' }];
  const m = onKillExplosions(mods, { life: { value: 40000 }, targets: { normal: 8000, magic: 16000 }, enemyResists: { Chaos: 20 } });
  const r = m.result.rows[0];
  assert.equal(m.confidence, 'low');
  assert.equal(r.damage_per_explosion, 8000);
  assert.equal(r.expected_damage_per_kill, 4000);
  assert.equal(r.fraction_of_target_life.normal, 1);
  assert.equal(r.kills_normal_outright, true);
  assert.equal(r.normal_explosions_to_kill_normal, 5);
  assert.deepEqual(r.requires, ['enemy cursed']);
  assert.equal(onKillExplosions([], {}).applicable, false);
  const random = onKillExplosions([{ amount: 10, chance: 1, type: 'RandomElement' }], { life: { value: 1000 }, enemyResists: { Fire: 30, Cold: 0, Lightning: 0 } });
  assert.equal(random.result.rows[0].target_resist_pct, 10);
  assert.deepEqual(enemyResistsOf({ enemyChaosResist: 10 }, 'Boss'), { Fire: 40, Cold: 40, Lightning: 40, Chaos: 10, Physical: 0 });
});

test('thorns model: parse map mod text, damage per trigger and verdict', () => {
  const t = parseThorns(['Rare Monsters have Physical Thorns reflecting 1500 Physical Damage\nRare Monsters have Elemental Thorns reflecting 2500 Elemental Damage']);
  assert.deepEqual(t, { Physical: 1500, Elemental: 2500 });
  const m = thornsRetaliation(output, t);
  assert.equal(m.result.damage_per_trigger, 1500 + 2500 * 0.9);
  assert.equal(m.result.triggers_to_empty_pool, Math.round(6000 / 3750 * 10) / 10);
  assert.equal(m.result.verdict, 'dangerous');
  assert.equal(thornsRetaliation({ ...output, ColdHitAverage: 0 }, t).result.verdict, 'likely_not_triggered');
  assert.equal(thornsRetaliation(output, { Physical: 0, Elemental: 0 }).applicable, false);
});

test('degen tolerance: recovery divided by the DoT taken multiplier', () => {
  const m = degenTolerance(output);
  const row = t => m.result.rows.find(r => r.type === t);
  assert.equal(row('Fire').tolerance_dps, 1200);
  assert.equal(row('Physical').tolerance_dps, 300);
  assert.equal(row('Chaos').tolerance_dps, 300);
  assert.ok(['Physical', 'Chaos'].includes(m.result.weakest_type));
  assert.equal(m.result.seconds_at_double_tolerance, 20);
});

test('approximations block for an encounter and its Markdown section stay apart from PoB numbers', () => {
  const encounter = { label: 'Rare (T17)', enemy: { kind: 'hit', archetype: 'rare' }, map: { tier: 17, area_level: 84 }, life: { value: 40000 },
    modifiers: [{ id: 'punishing', name: 'Punishing', method: 'not_modelled', text: 'Rare Monsters have Physical Thorns reflecting 1500 Physical Damage' }], changes: { config: { enemyLevel: 84 } } };
  const result = { output, explode_mods: [{ amount: 25, chance: 0.5, type: 'Chaos', conditions: [] }] };
  const db = fs.existsSync(enemies) ? JSON.parse(fs.readFileSync(enemies, 'utf8')) : null;
  const a = approximationsFor(encounter, result, db);
  assert.deepEqual(a.models.map(m => m.id), modelIds);
  assert.deepEqual(a.applicable, modelIds);
  assert.match(a.disclaimer, /Not part of PoB/);
  if (db) assert.ok(a.models[1].inputs.target_life.normal > 0);
  const md = markdownReport({ analysis: 'encounter', label: 'Rare (T17)', build_file: 'x.xml', scenario: 'sustained', damage: { best_dps: 1, dps_basis: 'FullDPS' },
    defence: { enemy_hit_after_mods: 1, hits_to_die: 5, verdict: 'survives_hit', ehp: 1, max_hit: {}, recovery_per_s: { total: 300 } }, vs_clean: null,
    modifiers: [], build_checks: [], assumptions: [], approximations: a, disclaimer: 'd' });
  assert.match(md, /## Приближённые модели вне PoB \(WP9\)/);
  assert.match(md, /\*\*recoup_sustain\*\* \(confidence medium\)/);
  assert.match(md, /thorns_retaliation/);
  const none = approximateModels({ output: {}, explodeMods: [] });
  assert.deepEqual(none.applicable, []);
});

test('validator: preconditions and conflicts from mechanic cards', () => {
  const occultist = { ascendancy: 'Occultist', ascendancy_nodes: ['Profane Bloom', 'Void Beacon'], keystones: ['Mind Over Matter'],
    skills: [{ label: 'Curse', gems: ['Blasphemy', 'Frostbite'] }, { label: 'Main', gems: ['Vortex', 'Efficacy'] }], config: { usePowerCharges: true }, charge_sources: ['Cold Snap of Power'], recovery: ['life_recoup'] };
  const ok = validatePrototype(occultist);
  assert.equal(ok.valid, true);
  const status = (r, id) => r.checks.find(c => c.id === id).status;
  assert.equal(status(ok, 'profane_bloom_curse'), 'pass');
  assert.equal(status(ok, 'blasphemy_hex'), 'pass');
  assert.equal(status(ok, 'config_charge_sources'), 'pass');

  const noCurse = validatePrototype({ ...occultist, skills: [{ label: 'Main', gems: ['Vortex'] }] });
  assert.equal(noCurse.valid, false);
  assert.equal(status(noCurse, 'profane_bloom_curse'), 'fail');

  const markBlasphemy = validatePrototype({ ...occultist, skills: [{ label: 'Aura', gems: ['Blasphemy', "Assassin's Mark"] }] });
  assert.equal(status(markBlasphemy, 'blasphemy_hex'), 'fail');

  const twoCurses = { ...occultist, skills: [{ label: 'A', gems: ['Blasphemy', 'Frostbite'] }, { label: 'B', gems: ['Despair'] }] };
  assert.equal(status(validatePrototype(twoCurses), 'curse_limit'), 'warn');
  assert.equal(status(validatePrototype({ ...twoCurses, curse_limit: 1 }), 'curse_limit'), 'fail');
  assert.equal(status(validatePrototype({ ...twoCurses, curse_limit: 2 }), 'curse_limit'), 'pass');

  assert.equal(status(validatePrototype({ keystones: ['Chaos Inoculation'], recovery: ['life_recoup'] }), 'ci_life_recovery'), 'fail');
  assert.equal(status(validatePrototype({ keystones: ['Eldritch Battery', 'Mind Over Matter'] }), 'eb_mom_shared_pool'), 'warn');
  assert.equal(status(validatePrototype({ skills: [{ gems: ['Detonate Dead'] }] }), 'corpse_source'), 'warn');
  assert.equal(status(validatePrototype({ skills: [{ gems: ['Detonate Dead', 'Desecrate'] }] }), 'corpse_source'), 'pass');
  assert.equal(status(validatePrototype({ ascendancy_points: 10 }), 'ascendancy_budget'), 'fail');
  assert.equal(status(validatePrototype({ config: { useFrenzyCharges: true }, skills: [] }), 'config_charge_sources'), 'warn');

  const empty = validatePrototype({});
  assert.equal(empty.valid, true);
  assert.ok(empty.checks.every(c => ['unknown', 'not_applicable'].includes(c.status)));
  assert.ok(Object.keys(rules).length >= 3);
  assert.throws(() => validatePrototype({}, { only: ['nope'] }), /Unknown validator rule/);
});

test('validator spec from pob inspect and run results', () => {
  const inspect = { ascendancy: 'Occultist', config: { usePowerCharges: true }, items: 3,
    skills: [{ label: 'Curse', enabled: 'true', gems: [{ name: 'Blasphemy', enabled: 'true' }, { name: 'Frostbite', enabled: 'true' }, { name: 'Despair', enabled: 'false' }] },
      { label: 'On Kill Monster Explosion', gems: [{ name: '' }] }] };
  const run = { explode_mods: [{ source_name: 'Profane Bloom' }], budget: { ascendancy_used: 8 }, equipped_items: [{ name: 'X', base: 'Y' }], output: { EnemyCurseLimit: 1, LifeRecoup: 31, LifeRegenRecovery: 100 } };
  const spec = specFromInspect(inspect, run);
  assert.deepEqual(spec.skills, [{ label: 'Curse', enabled: true, gems: ['Blasphemy', 'Frostbite'] }]);
  assert.deepEqual(spec.explode_sources, ['Profane Bloom']);
  assert.equal(spec.ascendancy_points, 8);
  assert.deepEqual(spec.recovery, ['life_recoup', 'life_regen']);
  assert.equal(validatePrototype(spec).checks.find(c => c.id === 'profane_bloom_curse').status, 'pass');
  assert.equal(specFromInspect(inspect).explode_sources, undefined);
});
