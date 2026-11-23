import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { queryCatalog } from '../scripts/query.mjs';

test('catalog is accessible from another working directory without project session state', () => {
  const script = fileURLToPath(new URL('../scripts/query.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, 'metadata'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.patch, '3.30');
  assert.equal(result.network_required, false);
  assert.equal(result.counts.records, 1270);
});

test('search preserves variants and treats punctuation as data', () => {
  assert.equal(queryCatalog(['search', 'Mageblood']).results[0].name, 'Mageblood');
  const found = queryCatalog(['item', "Ralakesh's Impatience"]);
  assert.equal(found.results[0].name, "Ralakesh's Impatience");
  assert.equal(queryCatalog(['search', 'Suppress Spell', '--limit', '2']).results.length, 2);
  assert.equal(queryCatalog(['search', '%']).total, 0);
  assert.equal(queryCatalog(['search', "' OR 1=1 --"]).total, 0);
});

test('numeric query separates guaranteed ranges from possible rolls', () => {
  const guaranteed = queryCatalog(['stat', 'base_spell_suppression_chance_%', '--min', '24', '--limit', '100']);
  const possible = queryCatalog(['stat', 'base_spell_suppression_chance_%', '--min', '24', '--mode', 'possible', '--limit', '100']);
  assert.ok(possible.total > guaranteed.total);
  assert.ok(guaranteed.results.every(row => row.min_value >= 24 && row.is_random === 0));
  assert.ok(possible.results.every(row => row.max_value >= 24));
  assert.throws(() => queryCatalog(['stat', 'x', '--min', '20', '--max', '10']));
  assert.throws(() => queryCatalog(['search', 'x', '--limit', '0']));
});
