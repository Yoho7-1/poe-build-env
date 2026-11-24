import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, lazyModules } from '../scripts/agent.mjs';
import { runBatch } from '../scripts/analysis-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// agent.mjs loads command modules on first use through require(esm); a module with top-level await (or one that
// imports such a module) would fail only when its command is called, so every lazy module is loaded here.
test('every lazily loaded command module loads synchronously', () => {
  for (const [name, load] of Object.entries(lazyModules)) assert.equal(typeof load(), 'object', name);
  assert.ok(Object.keys(agent(['help', '--full']).commands).length > 50);
});

// The analysis batch pool runs jobs in worker threads; a failing job must still come back as { error } per job.
test('analysis batch pool reports per-job errors like the pob run CLI', () => {
  const batch = runBatch({ file: path.join(root, 'fixtures/fireball-control.xml'), scenario: 'sustained', changesList: [{ unknown_change: 1 }, { config: [] }], concurrency: 2 });
  assert.equal(batch.runs, 2);
  const errors = [...batch.results.values()].map(r => r.error).sort();
  assert.deepEqual(errors, ['Unsupported change: unknown_change', 'config must be an object']);
});
