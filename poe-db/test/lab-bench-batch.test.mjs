import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sampleComponents, newAblationBenchmarks, predictBenchmark, scoreBenchmarks, benchmarkStats, empiricalBaseline } from '../scripts/lab-bench.mjs';

const comps = [
  ['support:1:2', 'supports'], ['support:1:3', 'supports'], ['support:1:4', 'supports'], ['item:Helmet', 'items'], ['item:Ring 1', 'items'], ['item:Flask 1', 'items'],
  ['node:1', 'tree'], ['node:2', 'tree'], ['node:3', 'tree'], ['config:a', 'config'], ['config:b', 'config'], ['config:c', 'config']
].map(([id, kind]) => ({ id, kind, label: id, target: kind === 'items' ? { rarity: 'RARE', slot: id.slice(5) } : {} }));

test('sample excludes used ids; batch tasks on one file are disjoint and continue across calls', () => {
  assert.ok(sampleComponents(comps, 12, 's', new Set(['node:1'])).every(c => c.id !== 'node:1'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-bench-b-'));
  const ledger = path.join(dir, 'ledger.jsonl'), file = path.join(dir, 'b.xml');
  try {
    const plan = { components: comps };
    const rs = newAblationBenchmarks({ file, tasks: 2, components: 4, seed: 'x', tags: ['wp4'], ledger, plan });
    assert.equal(rs.length, 2);
    const ids = rs.flatMap(r => r.data.task.components.map(c => c.id));
    assert.equal(new Set(ids).size, 8);
    assert.deepEqual(rs[0].tags, ['ablation_tiers', 'wp4']);
    const more = newAblationBenchmarks({ file, tasks: 3, components: 4, seed: 'y', ledger, plan }); // only 4 unused left
    assert.equal(more.length, 1);
    assert.equal(new Set([...ids, ...more[0].data.task.components.map(c => c.id)]).size, 12);
    assert.throws(() => newAblationBenchmarks({ file, tasks: 1, components: 4, ledger, plan }), /Fewer than 3/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('batch scoring: one ablation per build, per-component baselines, pooled breakdown by kind, held-out flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-bench-b-'));
  const ledger = path.join(dir, 'ledger.jsonl'), file = path.join(dir, 'b.xml');
  try {
    const rs = newAblationBenchmarks({ file, tasks: 2, components: 4, seed: 'x', tags: ['wp4'], ledger, plan: { components: comps } });
    const truth = Object.fromEntries(comps.map(c => [c.id, c.kind === 'supports' ? 'major' : c.kind === 'config' ? 'negligible' : 'minor']));
    const preds = rs.map(r => predictBenchmark(r.id, 1, Object.fromEntries(r.data.task.components.map(c => [c.id, 'minor'])), ledger));
    const calls = [];
    const fake = o => { calls.push(o.only); return { contract: { input_sha256: 'held' }, rows: o.only.map(id => ({ id, tier: truth[id] })) }; };
    const training = [{ build: 'other', kind: 'supports', label: 'x', target: {}, tier: 'core' }];
    assert.throws(() => scoreBenchmarks(rs.map(r => r.id), [2], { ledger, runAblation: fake, rowsLoader: () => training }), /One expected revision/);
    assert.throws(() => scoreBenchmarks(rs.map(r => r.id), [2, 1], { ledger, runAblation: fake, rowsLoader: () => training }), /Revision conflict/);
    assert.equal(calls.length, 0); // nothing runs until every record is valid
    const scored = scoreBenchmarks(rs.map(r => r.id), preds.map(p => p.revision), { ledger, runAblation: fake, rowsLoader: () => training });
    assert.equal(calls.length, 1); assert.equal(calls[0].length, 8);
    for (const s of scored) {
      assert.equal(Object.keys(s.data.score.truth).length, 4); // only its own components
      assert.equal(Object.keys(s.data.score.baseline_predictions.kind_prior).length, 4);
      assert.equal(s.data.score.empirical_training.in_training, false);
    }
    const st = benchmarkStats(ledger, { tag: 'wp4', breakdown: true });
    assert.equal(st.scored, 2); assert.equal(st.builds, 1); assert.equal(st.held_out_builds, 1);
    assert.equal(st.pooled.overall.n, 8);
    const kinds = st.pooled.by_kind;
    if (kinds.supports) { assert.equal(kinds.supports.agent.exact, 0); assert.equal(kinds.supports.kind_prior.exact, 1); }
    if (kinds.config) assert.equal(kinds.config.kind_prior.exact, 1);
    assert.equal(benchmarkStats(ledger, { tag: 'none' }).scored, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('empirical baseline reports whether the benchmarked build was a training build', () => {
  const rows = [{ build: 'a', kind: 'supports', label: 'x', target: {}, tier: 'core' }, { build: 'b', kind: 'supports', label: 'x', target: {}, tier: 'major' }];
  assert.equal(empiricalBaseline('a', () => rows).trained_on.in_training, true);
  assert.equal(empiricalBaseline('zzz', () => rows).trained_on.in_training, false);
});
