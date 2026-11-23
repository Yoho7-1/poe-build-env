import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const filename = fileURLToPath(new URL('../data/poe-3.30.sqlite', import.meta.url));
const databaseExists = fs.existsSync(filename);

test('imported database preserves scope, ranges, alternatives and source provenance', { skip: !databaseExists }, () => {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
    const records = database.prepare('SELECT * FROM items').all();
    assert.ok(records.length > 1200);
    assert.ok(records.every(row => row.patch === '3.30' && row.game === 'poe1'));
    const forbidden = ['The Crustacean\'s Call', 'Rotmother\'s Mutiny', 'Wall of Brambles'];
    for (const name of forbidden) assert.equal(database.prepare('SELECT COUNT(*) n FROM items WHERE name=?').get(name).n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) n FROM items WHERE release_version='3.30.0'").get().n, 11);
    const mageblood = database.prepare("SELECT s.min_value,s.max_value FROM stats s JOIN items i ON i.id=s.item_id WHERE i.name='Mageblood' AND s.stat_id='num_magic_utility_flasks_always_apply'").get();
    assert.deepEqual([mageblood.min_value, mageblood.max_value], [2, 4]);
    assert.ok(database.prepare("SELECT COUNT(*) n FROM modifiers m JOIN items i ON i.id=m.item_id WHERE i.name='Watcher''s Eye' AND m.is_random=1").get().n > 50);
    assert.ok(database.prepare("SELECT COUNT(*) n FROM item_search WHERE item_search MATCH '" + '"Suppress" AND "Spell"' + "'").get().n > 0);
    const conflict = database.prepare("SELECT record_json FROM documents d JOIN items i ON i.id=d.item_id WHERE i.page_name='Vessel of Vinktar (Added Lightning Damage to Spells)'").get();
    assert.ok(JSON.parse(conflict.record_json).source_conflicts.length > 0);
    const jsonl = fs.readFileSync(fileURLToPath(new URL('../data/uniques-3.30.jsonl', import.meta.url)), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(jsonl.length, records.length);
    assert.ok(jsonl.every(row => row.source.url.startsWith('https://www.poewiki.net/wiki/') && row.availability.independently_verified === false));
    assert.ok(database.prepare('SELECT COUNT(*) n FROM sources WHERE LENGTH(sha256)=64').get().n >= 50);
  } finally { database.close(); }
});
