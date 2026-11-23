import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const database = new DatabaseSync(fileURLToPath(new URL('../data/poe-3.30.sqlite', import.meta.url)), { readOnly: true });
const args = process.argv.slice(2);
if (!args.length) {
  console.log('Usage: node scripts/search.mjs <item name or English phrase> [--full]');
} else {
  const full = args.includes('--full');
  const query = args.filter(arg => arg !== '--full').join(' ');
  const nameMatches = database.prepare('SELECT id FROM items WHERE name LIKE ? ORDER BY name LIMIT 10').all(`%${query}%`);
  const matches = nameMatches.length ? nameMatches : database.prepare('SELECT item_id AS id FROM item_search WHERE item_search MATCH ? ORDER BY rank LIMIT 10').all(query.split(/\s+/).filter(Boolean).map(word => '"' + word.replaceAll('"', '""') + '"').join(' AND '));
  const get = database.prepare('SELECT record_json FROM documents WHERE item_id=?');
  const records = matches.map(({ id }) => JSON.parse(get.get(id).record_json));
  console.log(JSON.stringify(full ? records : records.map(record => ({ id: record.id, name: record.name, base_type: record.base_type, item_class: record.item_class, level: record.requirements.level, effects: record.effects, source: record.source.url })), null, 2));
}
database.close();
