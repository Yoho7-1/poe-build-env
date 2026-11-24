import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillProfile, loadBossScenarios, resolveBoss, bossChanges, evaluateSurvival, hitAssessment, engineHitAssessment } from '../scripts/analysis-bosses.mjs';
import { readMetric, delta, canonicalJson, analysisKey, assertOneContract, AnalysisCache, evaluateCandidates } from '../scripts/analysis-core.mjs';
import { rankRows, attachPrice, budgetSummary, rankByPrice, flagTradeoffs } from '../scripts/analysis-rank.mjs';
import { statCandidates } from '../scripts/analysis-nodes.mjs';
import { validateCandidateFile, mergeChanges, expandCandidates, packageInteraction } from '../scripts/analysis-upgrades.mjs';
import { loadCases, validateCases, checkSignals, scoreAnswers, prompts } from '../scripts/analysis-eval.mjs';

const contract = { input_sha256: 'a'.repeat(64), calculation_contract_sha256: 'b'.repeat(64), engine: { commit: 'c1' }, scenario: 'sustained' };
const result = (output, extra = {}) => ({ ...contract, calculation_id: extra.id ?? 'x', output, ...extra });

test('boss skill damage reproduces PoB preset arithmetic, uber multiplier and earlierUber', () => {
  const table = Array.from({ length: 85 }, (_, i) => i + 1); // level L -> L
  const skill = { DamageMultipliers: { Fire: [10, 0.1] }, DamagePenetrations: { FirePen: '' }, UberDamagePenetrations: { FirePen: 30 }, UberDamageMultiplier: 2, DamageType: 'Spell' };
  const pin = skillProfile('X', skill, 'pinnacle', { damageTable: table });
  assert.equal(pin.damage.Fire, Math.round(84 * (10 + 70 * 0.1)));
  assert.deepEqual(pin.penetration, {});
  const uber = skillProfile('X', skill, 'uber', { damageTable: table });
  assert.equal(uber.damage.Fire, Math.round(85 * 17 * 2));
  assert.equal(uber.penetration.FirePen, 30);
  assert.deepEqual(uber.config, { enemyIsBoss: 'Uber', presetBossSkills: 'X', enemyDamageRollRange: 70 });
  const early = skillProfile('X', { ...skill, earlierUber: true }, 'pinnacle', { damageTable: table });
  assert.equal(early.uber_values_applied, true);
});

test('tracked boss scenarios cover at least three pinnacle bosses with real skill presets', () => {
  const data = loadBossScenarios();
  for (const name of ['uber maven', 'Shaper', 'Sirus', 'exarch']) assert.equal(resolveBoss(data, name).skill_coverage, 'pob_boss_skill_presets');
  const maven = resolveBoss(data, 'Maven').tiers.uber.skills.find(s => s.skill === 'Maven Fireball');
  assert.equal(maven.penetration.FirePen, 30);
  assert.ok(maven.damage.Fire > 30000 && maven.damage.Fire < 40000);
  assert.equal(resolveBoss(data, 'Elder').skill_coverage, 'generic_only');
  assert.throws(() => resolveBoss(data, 'Nobody'), /Unknown boss/);
  assert.ok(data.provenance.sources.every(s => !path.isAbsolute(s.file)));
});

test('survival picks the largest fraction of max hit and refuses mixed baselines', () => {
  const data = loadBossScenarios();
  const profile = resolveBoss(data, 'Shaper');
  const runs = bossChanges(profile, 'uber');
  assert.equal(runs.length, 3);
  const out = { PhysicalMaximumHitTaken: 30000, FireMaximumHitTaken: 50000, ColdMaximumHitTaken: 12000, LightningMaximumHitTaken: 50000, ChaosMaximumHitTaken: 8000, LifeRegenRecovery: 100 };
  const results = runs.map((r, i) => result(out, { id: `r${i}`, changes: r.changes }));
  const report = evaluateSurvival(profile, 'uber', results);
  assert.equal(report.kills_first.skill, 'Shaper Ball');
  assert.equal(report.kills_first.verdict, 'one_shot');
  // DoT skills: without DoT EHP in the output no verdict is derived; with it, degen is compared with recovery.
  assert.equal(report.skills.find(s => s.skill === 'Shaper Beam').verdict, 'unknown');
  const dotOut = { ...out, Life: 5000, EnergyShield: 0, ColdDotEHP: 50000, FireDotEHP: 50000, LightningDotEHP: 50000, LifeRegenRecovery: 2000 };
  const withDot = evaluateSurvival(profile, 'uber', runs.map((r, i) => result(dotOut, { id: `d${i}`, changes: r.changes })));
  const beam = withDot.skills.find(s => s.skill === 'Shaper Beam');
  assert.equal(beam.verdict, 'degen_survivable');
  assert.ok(beam.taken_dps > beam.recovery_per_s && beam.time_to_die_s > 4);
  assert.deepEqual(report.missing, []);
  const partial = evaluateSurvival(profile, 'uber', results.slice(0, 1));
  assert.deepEqual(partial.missing.sort(), ['Shaper Beam', 'Shaper Slam']);
  assert.throws(() => evaluateSurvival(profile, 'uber', [results[0], { ...results[1], input_sha256: 'z' }]), /input_sha256/);
});

test('mixed hits sum fractions; missing max hit gives unknown, not survival', () => {
  const skill = { damage: { Physical: 500, Fire: 500 }, damage_type: 'Spell' };
  const a = hitAssessment(skill, { PhysicalMaximumHitTaken: 1000, FireMaximumHitTaken: 1000 });
  assert.equal(a.damage_fraction_of_max_hit, 1);
  assert.equal(a.verdict, 'one_shot');
  assert.equal(hitAssessment(skill, { PhysicalMaximumHitTaken: 1000 }).verdict, 'unknown');
  const generic = hitAssessment({ damage: { Physical: 500, Fire: 500 }, damage_type: 'Average' }, { PhysicalMaximumHitTaken: 1000, FireMaximumHitTaken: 2000 });
  assert.equal(generic.damage_fraction_of_max_hit, 0.5);
});

test('engine hits-to-die is the primary verdict; a preset mismatch makes it unknown', () => {
  const skill = { damage: { Physical: 1000 }, damage_type: 'Spell' };
  const base = { PhysicalMaximumHitTaken: 4000, FireMaximumHitTaken: 4000, totalEnemyDamageIn: 1000, PhysicalTakenHit: 300, FireTakenHit: 900, totalTakenHit: 1200 };
  const a = engineHitAssessment(skill, { ...base, NumberOfDamagingHits: 0.5 });
  assert.equal(a.source, 'engine_configured_hit');
  assert.equal(a.verdict, 'one_shot');
  assert.equal(a.damage_fraction_of_max_hit, 2);
  assert.equal(a.dominant_type, 'Fire');
  assert.equal(a.cross_check.damage_fraction_of_max_hit, 0.25);
  assert.equal(engineHitAssessment(skill, { ...base, NumberOfDamagingHits: 3 }).verdict, 'survives_hit');
  assert.equal(engineHitAssessment(skill, { ...base, NumberOfDamagingHits: 3, totalEnemyDamageIn: 5000 }).verdict, 'unknown');
  const fallback = engineHitAssessment(skill, base);
  assert.equal(fallback.source, 'pure_type_max_hit_estimate');
  assert.equal(fallback.verdict, 'survives_hit');
});

test('metrics, deltas and canonical cache keys', () => {
  const r = result({ CombinedDPS: 100, TotalEHP: 5000, PhysicalMaximumHitTaken: 4, FireMaximumHitTaken: 3, ColdMaximumHitTaken: 9, LightningMaximumHitTaken: 9, ChaosMaximumHitTaken: 2, ManaRegenRecovery: 10, ManaPerSecondCost: 12 });
  assert.equal(readMetric(r, 'dps'), 100);
  assert.equal(readMetric(r, 'maxhit'), 2);
  assert.equal(readMetric(r, 'mana_sustain'), -2);
  assert.equal(readMetric(result({ PhysicalMaximumHitTaken: 4 }), 'maxhit'), null);
  assert.throws(() => readMetric(r, 'nope'), /Unknown metric/);
  assert.deepEqual(delta(0, 5), { before: 0, after: 5, abs: 5, pct: null });
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const c = { input_sha256: 'a', calculation_contract_sha256: 'b', engine_commit: 'c', scenario: 's' };
  assert.equal(analysisKey({ contract: c, kind: 'n', change: { x: 1, y: 2 } }), analysisKey({ contract: c, kind: 'n', change: { y: 2, x: 1 } }));
  assert.notEqual(analysisKey({ contract: c, kind: 'n', change: { x: 1 } }), analysisKey({ contract: { ...c, calculation_contract_sha256: 'other' }, kind: 'n', change: { x: 1 } }));
  assert.throws(() => assertOneContract(r, [{ ...r, scenario: 'burst' }]), /scenario/);
});

test('batch evaluation reuses cache and rejects foreign contracts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-cache-'));
  try {
    const baseline = result({ CombinedDPS: 100, TotalEHP: 1000 });
    let calls = 0;
    const runner = changes => { calls++; return changes.bad ? { ...baseline, calculation_contract_sha256: 'other' } : result({ CombinedDPS: 100 + changes.add, TotalEHP: 1000 }); };
    const candidates = [{ id: 'a', changes: { add: 10 }, cost: { points: 2 } }, { id: 'b', changes: { add: 5 }, cost: { points: 1 } }, { id: 'c', changes: { bad: true } }];
    const first = evaluateCandidates({ baseline, candidates, runner, metricsWanted: ['dps', 'ehp'], cache: new AnalysisCache(dir) });
    assert.equal(calls, 3);
    assert.match(first.rows[2].error, /calculation_contract_sha256/);
    const second = evaluateCandidates({ baseline, candidates, runner, metricsWanted: ['dps', 'ehp'], cache: new AnalysisCache(dir) });
    assert.equal(calls, 4); // only the failed candidate is recomputed
    assert.equal(second.cache.hits, 2);
    const ranked = rankRows(second.rows, { metric: 'dps' });
    assert.deepEqual(ranked.top.map(r => r.id), ['a', 'b']); // 10%/2 == 5%/1, tie broken by absolute gain
    assert.equal(ranked.excluded[0].reason, 'calculation_error');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ranking per point, disabled skills excluded, trade-offs flagged', () => {
  const rows = [
    { id: 'x', cost: { points: 4 }, deltas: { dps: { pct: 8, abs: 8 }, ehp: { pct: -5 } } },
    { id: 'y', cost: { points: 1 }, deltas: { dps: { pct: 3, abs: 3 }, ehp: { pct: 0 } } },
    { id: 'z', cost: { points: 1 }, deltas: { dps: { pct: 50, abs: 50 } }, skill_disabled_reason: 'requirements' }
  ];
  const ranked = rankRows(rows);
  assert.deepEqual(ranked.top.map(r => r.id), ['y', 'x']);
  assert.equal(ranked.excluded[0].id, 'z');
  assert.deepEqual(flagTradeoffs(rows)[0].tradeoffs, [{ metric: 'ehp', pct: -5 }]);
});

test('signed metrics rank by absolute delta, never by a sign-flipped percent', () => {
  assert.equal(delta(-10, -14).pct, null);
  const ranked = rankRows([{ id: 'worse', deltas: { m: delta(-10, -14) } }, { id: 'better', deltas: { m: delta(-10, -2) } }], { metric: 'm', per: 'none' });
  assert.deepEqual(ranked.top.map(r => r.id), ['better', 'worse']);
});

test('prices: currency conflicts are kept separate and never totalled', () => {
  const quote = (chaos, conflict) => ({ total_matches: 1, results: [{ name: 'I', chaos, snapshot_id: 's1', observed_at: 't', platform: 'pc', variant: { divineValue: 2, variant: null },
    quote_warning: conflict ? { code: 'inconsistent_currency_conversion' } : undefined }] });
  const a = attachPrice({ id: 'a', deltas: { dps: { pct: 10 } } }, quote(100, false));
  const b = attachPrice({ id: 'b', deltas: { dps: { pct: 10 } } }, quote(400, true));
  assert.equal(budgetSummary([a]).total_chaos, 100);
  const total = budgetSummary([a, b]);
  assert.equal(total.total_chaos, null);
  assert.equal(total.reason, 'inconsistent_currency_conversion');
  assert.equal(budgetSummary([a, attachPrice({ id: 'c' }, { results: [] })]).reason, 'unknown_prices');
  const byPrice = rankByPrice([a, b]);
  assert.deepEqual(byPrice.ranked.map(r => r.id), ['a']);
  assert.equal(byPrice.not_comparable[0].reason, 'currency_conflict');
});

test('stat probes append to existing custom modifiers', () => {
  const [probe] = statCandidates(['inc-life'], { custom_mods: 'Existing mod', config: { a: 1 } });
  assert.equal(probe.changes.custom_mods, 'Existing mod\n1% increased maximum Life');
  assert.deepEqual(probe.changes.config, { a: 1 });
  assert.throws(() => statCandidates(['nope']), /Unknown stat probe/);
});

test('upgrade packages merge changes and reject conflicting slots/config', () => {
  const file = { candidates: [
    { id: 'ring', changes: { replace_items: [{ slot: 'Ring 1', text: 'R' }], custom_mods: 'a' }, cost: { points: 0 } },
    { id: 'belt', changes: { replace_items: [{ slot: 'Belt', text: 'B' }], config: { x: true } }, price: { name: 'Mageblood', variant: '4 Flasks' } },
    { id: 'ring2', changes: { replace_items: [{ slot: 'Ring 1', text: 'R2' }] } }],
    packages: [{ id: 'ring-belt', members: ['ring', 'belt'] }] };
  const expanded = expandCandidates(file);
  assert.equal(expanded.length, 4);
  const pkg = expanded.find(c => c.id === 'ring-belt');
  assert.equal(pkg.changes.replace_items.length, 2);
  assert.equal(pkg.changes.custom_mods, 'a');
  assert.throws(() => mergeChanges([file.candidates[0], file.candidates[2]].map(c => ({ id: c.id, changes: c.changes }))), /Ring 1/);
  assert.throws(() => mergeChanges([{ id: 'p', changes: { config: { x: 1 } } }, { id: 'q', changes: { config: { x: 2 } } }]), /config.x/);
  assert.throws(() => mergeChanges([{ id: 'p', changes: { tree: { allocate: [1] } } }, { id: 'q', changes: { tree: { deallocate: [1] } } }]), /same nodes/);
  assert.throws(() => validateCandidateFile({ candidates: [{ id: 'a', changes: {} }] }), /non-empty/);
  assert.throws(() => validateCandidateFile({ candidates: [{ id: 'a', changes: { x: 1 } }], packages: [{ id: 'p', members: ['a', 'b'] }] }), /unknown member/);
  const inter = packageInteraction([{ id: 'ring', deltas: { dps: { pct: 5 } } }, { id: 'belt', deltas: { dps: { pct: 5 } } },
    { id: 'ring-belt', meta: { type: 'package', members: ['ring', 'belt'] }, deltas: { dps: { pct: 12 } } }]);
  assert.equal(inter[0].interaction_pct, 2);
});

test('evaluation cases are valid, prompts are blind and automatic signals never pass alone', () => {
  const data = loadCases();
  assert.ok(data.cases.length >= 14);
  assert.ok(data.cases.filter(c => ['tree', 'leveling', 'changes', 'analysis'].includes(c.category)).length >= 5);
  const blind = prompts(data);
  assert.ok(blind.every(p => Object.keys(p).join() === 'id,request'));
  assert.throws(() => validateCases({ cases: [{ id: 'a', request: 'r', pass: 'p', evidence: [], signals: { must: ['('] } }] }));
  const c = data.cases.find(x => x.id === 'historical-input');
  assert.equal(checkSignals(c, 'Нужна явная миграция 3.29 -> 3.30').status, 'signals_present');
  assert.equal(checkSignals(c, 'Да, можно').status, 'signals_missing');
  const report = scoreAnswers(data, { model: 'm', answers: [
    { id: 'historical-input', answer: 'Нужна миграция' },
    { id: 'price-age', answer: 'нет', manual: { verdict: 'pass' } },
    { id: 'tree-path-ee', answer: '' }] });
  assert.deepEqual(report.summary, { pass: 1, partial: 0, fail: 1, pending_review: 1 });
  assert.equal(report.not_answered.length, data.cases.length - 3);
  assert.throws(() => scoreAnswers(data, { answers: [{ id: 'price-age', manual: { verdict: 'great' } }] }), /Invalid manual verdict/);
});
