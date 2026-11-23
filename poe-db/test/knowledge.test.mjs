import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mergeGemLevel, treeEdges } from '../scripts/knowledge-model.mjs';
import { queryCatalog } from '../scripts/query.mjs';

const filename = fileURLToPath(new URL('../data/knowledge-3.30.sqlite', import.meta.url));
const exists = fs.existsSync(filename);

test('gem normalization inherits stat identity and constants, preserves zero and unknown values', () => {
  const gem = { static: { cost_multiplier: 140, stats: [{ id: 'damage', value: null }, { id: 'chance', value: 25 }], costs: { Mana: 8 } },
    per_level: { 20: { cost_multiplier: null, stats: [{ id: null, value: 0 }, null], costs: { Mana: null, Life: 0 } } } };
  const resolved = mergeGemLevel(gem, 20);
  assert.deepEqual(resolved.stats, [{ id: 'damage', value: 0 }, { id: 'chance', value: 25 }]);
  assert.deepEqual(resolved.costs, { Mana: 8, Life: 0 });
  assert.equal(resolved.cost_multiplier, 140);
  assert.equal(gem.static.stats[0].value, null);
  assert.equal(mergeGemLevel(gem, 21), null);
  assert.throws(() => treeEdges({ nodes: { 1: { out: [2] } } }), /Unknown tree connection/);
});

test('knowledge import keeps valid graphs, provenance and crafting references', { skip: !exists }, () => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const [category, count] of [['classes', 7], ['ascendancies', 21], ['gems', 1024], ['passive_nodes', 3462], ['atlas_nodes', 1117]]) {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM records WHERE category=?').get(category).n, count);
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE category='gems' AND json_extract(payload_json,'$.base_item.release_state')<>'released'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sources WHERE LENGTH(sha256)=64').get().n, 49);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM records r LEFT JOIN record_sources s ON s.category=r.category AND s.id=r.id AND s.role=? WHERE r.name_ru IS NOT NULL AND s.id IS NULL').get('localization').n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM relations r LEFT JOIN records t ON t.category=r.target_category AND t.id=r.target_id WHERE t.id IS NULL').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM bench_costs c LEFT JOIN records r ON r.category='base_items' AND r.id=c.currency_id WHERE r.id IS NULL").get().n, 0);
    const uniques = new DatabaseSync(fileURLToPath(new URL('../data/poe-3.30.sqlite', import.meta.url)), { readOnly: true });
    try {
      const names = new Set(uniques.prepare('SELECT DISTINCT name FROM items').all().map(x => x.name));
      assert.ok(db.prepare("SELECT name FROM records WHERE category='foulborn_replacements'").all().every(x => names.has(x.name)));
      assert.equal(db.prepare("SELECT value FROM metadata WHERE key='uniques_snapshot_id'").get().value, uniques.prepare("SELECT value FROM metadata WHERE key='snapshot_id'").get().value);
    } finally { uniques.close(); }
  } finally { db.close(); }
});

test('queries distinguish ordinary and transfigured gems and resolve actual level values', { skip: !exists }, () => {
  const base = queryCatalog(['knowledge', 'gem', 'Fireball', '--level', '20']);
  assert.equal(base.count, 1);
  assert.equal(base.results[0].name_ru, 'Огненный шар');
  assert.equal(base.results[0].level_data.costs.Mana, 20);
  assert.equal(base.results[0].level_data.stats.find(x => x.id === 'spell_minimum_base_fire_damage').value, 1883);
  assert.equal(base.results[0].level_data.stats.find(x => x.id === 'base_chance_to_ignite_%').value, 25);
  const alternate = queryCatalog(['knowledge', 'gem', 'Огненный шар облучения', '--level', '20']);
  assert.equal(alternate.results[0].id, 'FireballAltX');
  assert.equal(alternate.results[0].name, 'Fireball of Radiation');
  assert.equal(alternate.results[0].data.discriminator, 'alt_x');
  assert.equal(alternate.results[0].sources.length, 2);
  assert.equal(queryCatalog(['knowledge', 'gem', 'Fireball', '--level', '999']).results[0].level_data, null);
  const mod = queryCatalog(['knowledge', 'mod', 'Strength1']).results[0];
  assert.deepEqual({ ...mod.stat_ranges[0] }, { stat_id: 'additional_strength', min_value: 8, max_value: 12 });
  assert.equal(mod.ordered_weights.find(x => x.tag === 'ring').weight, 1000);
  assert.equal(mod.ordered_weights.at(-1).weight, 0);
});

test('normal queries withhold historical and unconfirmed tree choices', { skip: !exists }, () => {
  assert.equal(queryCatalog(['knowledge', 'get', 'bloodlines', 'Brinerot']).count, 0);
  assert.equal(queryCatalog(['knowledge', 'get', 'bloodlines', 'Brinerot', '--include-reference']).results[0].eligibility, 'unconfirmed');
  assert.equal(queryCatalog(['knowledge', 'node', '699']).count, 0);
  assert.equal(queryCatalog(['knowledge', 'node', '699', '--include-reference']).results[0].eligibility, 'historical');
  const node = queryCatalog(['knowledge', 'node', 'Mind Over Matter']).results[0];
  assert.ok(node.neighbors.length > 0);
  assert.ok(node.data.stats.length > 0);
  assert.equal(queryCatalog(['knowledge', 'search', "' OR 1=1 --"]).total, 0);
  const percent = queryCatalog(['knowledge', 'search', '%']);
  assert.ok(percent.results.every(row => [row.name, row.name_ru, row.id].some(value => value?.includes('%'))));
  assert.throws(() => queryCatalog(['knowledge', 'search', 'a', '--limit', '0']));
  assert.throws(() => queryCatalog(['knowledge', 'node', 'a', '--tree', 'bad']));
});

test('knowledge query runs from another directory and leaves the snapshot unchanged', { skip: !exists }, () => {
  const script = fileURLToPath(new URL('../scripts/query.mjs', import.meta.url));
  const before = fs.statSync(filename);
  const child = spawnSync(process.execPath, [script, 'knowledge', 'metadata'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.patch, '3.30');
  assert.equal(result.network_required, false);
  assert.equal(result.categories, 40);
  assert.equal(result.records, 98870);
  assert.equal(fs.statSync(filename).mtimeMs, before.mtimeMs);
});
