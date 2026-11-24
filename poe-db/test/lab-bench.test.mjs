import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sampleComponents, baselines, scoreTiers, validatePredictions, predictBenchmark, scoreBenchmark, showBenchmark, benchmarkStats, ensembleTier, routeFromCells, parseRoute, ensembleTaskScore } from '../scripts/lab-bench.mjs';
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

test('ensemble routes kinds to the stronger predictor and learns a route from other builds only', () => {
  // Fixed route: items from the agent, everything else from empirical.
  assert.equal(ensembleTier('items', { agent: 'core', empirical: 'minor' }), 'core');
  assert.equal(ensembleTier('config', { agent: 'core', empirical: 'minor' }), 'minor');
  assert.equal(ensembleTier('items', { empirical: 'minor' }), 'minor'); // missing source falls back to the other one
  assert.equal(ensembleTier('tree', { agent: 'major' }), 'major');
  assert.equal(ensembleTier('unheard_of', { agent: 'major', empirical: 'core' }), 'major'); // unknown kind -> fallback
  assert.equal(ensembleTier('unheard_of', { agent: 'major', empirical: 'core' }, {}, 'empirical'), 'core');
  // Learned route: agent wins on items (2 of 3 exact vs 0), empirical on config; a kind under minCells takes the overall winner.
  const cell = (kind, truth, agent, empirical) => ({ kind, truth, by: { agent, empirical } });
  const cells = [
    ...['core', 'core', 'minor'].map((t, i) => cell('items', t, t, 'minor')), cell('items', 'major', 'minor', 'minor'), cell('items', 'core', 'minor', 'minor'),
    ...['minor', 'minor', 'minor', 'major', 'core'].map(t => cell('config', t, 'core', t)),
    cell('tree', 'core', 'core', 'minor')];
  const learned = routeFromCells(cells);
  assert.equal(learned.route.items, 'agent'); assert.equal(learned.route.config, 'empirical');
  assert.equal(learned.route.tree, learned.fallback); // 1 cell < minCells: overall winner, not a per-kind choice
  assert.deepEqual(routeFromCells([]), { route: {}, fallback: 'agent' });
  assert.deepEqual(parseRoute('items=agent,config=empirical'), { items: 'agent', config: 'empirical' });
  assert.equal(parseRoute(null), null);
  assert.throws(() => parseRoute('items=oracle'), /kind=agent\|empirical/);
});

test('ensemble score of a benchmark uses frozen agent and stored empirical predictions', () => {
  const comps4 = comps.slice(0, 4); // 2 supports, 1 unique item, 1 flask item
  const truth = { 'support:1:2': 'core', 'support:1:3': 'minor', 'item:Helmet': 'core', 'item:Flask 2': 'negligible' };
  const record = { data: {
    task: { components: comps4 },
    predictions: { tiers: { 'support:1:2': 'minor', 'support:1:3': 'minor', 'item:Helmet': 'core', 'item:Flask 2': 'negligible' } },
    score: { truth, input_sha256: 'h', baseline_predictions: { empirical: { 'support:1:2': 'core', 'support:1:3': 'core', 'item:Helmet': 'minor', 'item:Flask 2': 'minor' } } } } };
  // supports from empirical (1 of 2 right, the miss is two classes off), items from the agent (2 of 2 right) -> 3 of 4.
  assert.deepEqual(ensembleTaskScore(record), { exact: 0.75, within_one: 0.75, n: 4, from_empirical: true });
  // Without stored empirical predictions the ensemble falls back to the agent's own numbers (3 of 4 here).
  const noEmp = { data: { ...record.data, score: { ...record.data.score, baseline_predictions: { kind_prior: {} } } } };
  assert.equal(ensembleTaskScore(noEmp).exact, 0.75);
  assert.equal(ensembleTaskScore(noEmp).from_empirical, false);
  assert.equal(ensembleTaskScore({ data: { task: { components: comps4 } } }), null); // not scored
});
