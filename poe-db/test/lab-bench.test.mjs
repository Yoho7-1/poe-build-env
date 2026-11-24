import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sampleComponents, baselines, scoreTiers, validatePredictions, predictBenchmark, scoreBenchmark, showBenchmark, benchmarkStats } from '../scripts/lab-bench.mjs';
import { createRecord, getRecord } from '../scripts/lab.mjs';

const comps = [
  { id: 'support:1:2', kind: 'supports', label: 'Efficacy', target: {} }, { id: 'support:1:3', kind: 'supports', label: 'Empower', target: {} },
  { id: 'item:Helmet', kind: 'items', label: 'Crown', target: { rarity: 'UNIQUE', slot: 'Helmet' } }, { id: 'item:Flask 2', kind: 'items', label: 'QS', target: { rarity: 'MAGIC', slot: 'Flask 2' } },
  { id: 'node:1', kind: 'tree', label: 'MoM', target: { type: 'keystone' } }, { id: 'node:2', kind: 'tree', label: 'Notable', target: { type: 'notable' } },
  { id: 'config:x', kind: 'config', label: 'x', target: {} }];

test('stratified sample is deterministic and covers every kind before repeating one', () => {
  const a = sampleComponents(comps, 4, 's'), b = sampleComponents(comps, 4, 's');
  assert.deepEqual(a, b);
  assert.deepEqual(new Set(a.map(c => c.kind)), new Set(['config', 'items', 'supports', 'tree']));
  assert.equal(sampleComponents(comps, 50, 's').length, comps.length);
  assert.notDeepEqual(sampleComponents(comps, 7, 's').map(c => c.id), sampleComponents(comps, 7, 'other').map(c => c.id));
});

test('baselines and scoring', () => {
  assert.equal(baselines.kind_prior(comps[2]), 'major'); assert.equal(baselines.kind_prior(comps[3]), 'negligible');
  assert.equal(baselines.kind_prior(comps[4]), 'major'); assert.equal(baselines.kind_prior(comps[6]), 'negligible');
  const s = scoreTiers(comps.slice(0, 3), { 'support:1:2': 'major', 'support:1:3': 'core', 'item:Helmet': 'error' }, { 'support:1:2': 'major', 'support:1:3': 'minor', 'item:Helmet': 'core' });
  assert.equal(s.n, 2); assert.equal(s.exact, 0.5); assert.equal(s.within_one, 0.5);
  assert.equal(scoreTiers([comps[0]], { 'support:1:2': 'removal_improves' }, { 'support:1:2': 'negligible' }).within_one, 1);
  assert.throws(() => validatePredictions(comps.slice(0, 2), { 'support:1:2': 'major' }), /Missing prediction/);
  assert.throws(() => validatePredictions(comps.slice(0, 1), { 'support:1:2': 'huge' }), /must be one of/);
  assert.throws(() => validatePredictions(comps.slice(0, 1), { 'support:1:2': 'major', zzz: 'minor' }), /unknown component/);
});

test('benchmark flow: no truth before scoring, frozen predictions, agent vs baselines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-bench-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  try {
    const task = { kind: 'ablation_tiers', file: path.join(dir, 'b.xml'), scenario: 'sustained', seed: 's', thresholds: { core: 25, major: 10, minor: 2 }, components: comps.slice(0, 4) };
    const b = createRecord({ type: 'benchmark', title: 'T', held_out: true, builds: ['x'], data: { task } }, { file: ledger });
    const shown = showBenchmark(b.id, ledger);
    assert.equal(shown.scored, false); assert.equal(shown.score, undefined); assert.equal(Object.keys(shown.template).length, 4);
    let called = null;
    const fake = opts => { called = opts.only; return { contract: { input_sha256: 'h' }, rows: [
      { id: 'support:1:2', tier: 'major' }, { id: 'support:1:3', tier: 'major' }, { id: 'item:Helmet', tier: 'minor' }, { id: 'item:Flask 2', tier: 'negligible' }] }; };
    assert.throws(() => scoreBenchmark(b.id, 1, { ledger, runAblation: fake, rowsLoader: () => [] }), /No predictions/);
    const p = predictBenchmark(b.id, 1, { 'support:1:2': 'major', 'support:1:3': 'major', 'item:Helmet': 'core', 'item:Flask 2': 'negligible' }, ledger);
    const rowsLoader = ({ excludeSha }) => (excludeSha === 'h' ? [] : null) ?? [];
    const scored = scoreBenchmark(b.id, p.revision, { ledger, runAblation: fake, rowsLoader });
    assert.deepEqual(called, comps.slice(0, 4).map(c => c.id));
    assert.equal(scored.data.score.agent.exact, 0.75); assert.equal(scored.data.score.baselines.all_minor.exact, 0.25); assert.equal(scored.data.score.baselines.kind_prior.exact, 0.75);
    assert.equal(scored.status, 'retired');
    assert.deepEqual(scored.data.score.misses, [{ id: 'item:Helmet', truth: 'minor', predicted: 'core' }]);
    assert.throws(() => predictBenchmark(b.id, scored.revision, { 'support:1:2': 'minor', 'support:1:3': 'major', 'item:Helmet': 'core', 'item:Flask 2': 'negligible' }, ledger), /cannot change/);
    assert.equal(getRecord(b.id, { file: ledger }).evidence.at(-1).supports, false); // did not beat the best baseline
    const st = benchmarkStats(ledger);
    assert.equal(st.scored, 1); assert.equal(st.agent_exact, 0.75); assert.equal(st.baselines.kind_prior, 0.75);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
