import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { plainText, splitOptions, classifyAvailability, numeric, wikiUrl, groupBy } from './model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = async name => JSON.parse(await fs.readFile(path.join(root, 'cache', `${name}.json`), 'utf8'));
const [rows, modifierRows, statRows, manifest] = await Promise.all(['items', 'item_mods', 'item_stats', 'manifest'].map(read));
const counts = {};
const accepted = [], excluded = [];
const duplicateConflicts = [];
for (const [pageName, sourceRows] of groupBy(rows, 'page_name')) {
  const item = { ...sourceRows[0] };
  if (sourceRows.length > 1) {
    item.source_rows = sourceRows;
    item.conflicting_fields = [];
    for (const field of ['implicit_stat_text', 'explicit_stat_text', 'enchantment_stat_text', 'stat_text', 'drop_text']) {
      const values = [...new Set(sourceRows.map(row => row[field]))];
      if (values.length > 1) { item.conflicting_fields.push(field); item[field] = null; }
    }
    if (item.conflicting_fields.length) duplicateConflicts.push({ page_name: plainText(pageName), fields: item.conflicting_fields, source_rows: sourceRows });
    if (new Set(sourceRows.map(row => JSON.stringify(classifyAvailability(row)))).size > 1) {
      excluded.push({ page_name: plainText(pageName), reason: 'conflicting_availability_rows', source_url: wikiUrl(pageName) });
      counts.conflicting_availability_rows = (counts.conflicting_availability_rows ?? 0) + 1;
      continue;
    }
  }
  const availability = classifyAvailability(item);
  if (availability.include) accepted.push({ ...item, availability });
  else excluded.push({ name: plainText(item.name), page_name: plainText(item.page_name), class: item.class, reason: availability.reason, release_version: item.release_version, removal_version: item.removal_version, source_url: wikiUrl(item.page_name) });
  counts[availability.reason] = (counts[availability.reason] ?? 0) + 1;
}
const uniqueRows = values => [...new Map(values.map(row => [JSON.stringify(row), row])).values()];
const modifiersByPage = groupBy(uniqueRows(modifierRows), 'page_name');
const statsByPage = groupBy(uniqueRows(statRows), 'page_name');
const extras = {};
const missingGroups = [];
for (const table of ['armours', 'weapons', 'flasks', 'jewels', 'maps', 'shields', 'tinctures', 'foulborn_modifiers']) {
  let data;
  try { data = await read(table); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    missingGroups.push(table);
    continue;
  }
  const schema = (await read(`schema-${table}`)).cargofields;
  extras[table] = groupBy(data.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, ['Integer', 'Float'].includes(schema[key]?.type) ? numeric(value) : value]))), 'page_name');
}

const out = path.join(root, 'data');
const reports = path.join(root, 'reports');
await fs.mkdir(out, { recursive: true });
await fs.mkdir(reports, { recursive: true });
const snapshotId = createHash('sha256').update(JSON.stringify(manifest.sources.map(s => [s.file, s.sha256]))).digest('hex').slice(0, 16);
const temporary = path.join(out, `poe-3.30-${process.pid}.sqlite`);
const database = new DatabaseSync(temporary);
await fs.writeFile(path.join(reports, 'excluded.json'), JSON.stringify(excluded, null, 2));
await fs.writeFile(path.join(reports, 'source-conflicts.json'), JSON.stringify(duplicateConflicts, null, 2));

const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE sources (id INTEGER PRIMARY KEY, url TEXT NOT NULL, cache_file TEXT NOT NULL, sha256 TEXT NOT NULL, obtained_at TEXT NOT NULL) STRICT;
CREATE TABLE items (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, page_name TEXT NOT NULL UNIQUE,
 base_type TEXT, base_item_id TEXT, item_class TEXT NOT NULL, metadata_id TEXT,
 game TEXT NOT NULL CHECK(game='poe1'), patch TEXT NOT NULL CHECK(patch='3.30'),
 league TEXT NOT NULL, language TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 required_level INTEGER, required_strength INTEGER, required_dexterity INTEGER, required_intelligence INTEGER,
 release_version TEXT, is_replica INTEGER, is_corrupted INTEGER, is_drop_restricted INTEGER,
 availability_basis TEXT NOT NULL, availability_confidence TEXT NOT NULL,
 acquisition_text TEXT, implicit_text TEXT, explicit_fixed_text TEXT, enchantment_text TEXT,
 random_options_json TEXT NOT NULL, source_url TEXT NOT NULL, wiki_page_id INTEGER NOT NULL,
 raw_source_json TEXT NOT NULL
) STRICT;
CREATE INDEX items_by_name ON items(name);
CREATE INDEX items_by_class ON items(item_class);
CREATE TABLE modifiers (
 row_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
 mod_id TEXT, text TEXT, is_random INTEGER, is_implicit INTEGER, is_explicit INTEGER, is_enchantment INTEGER,
 raw_source_json TEXT NOT NULL
) STRICT;
CREATE INDEX modifiers_by_item ON modifiers(item_id);
CREATE TABLE stats (
 row_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
 stat_id TEXT NOT NULL, mod_id TEXT, min_value REAL, max_value REAL, source_average REAL,
 is_random INTEGER, raw_source_json TEXT NOT NULL
) STRICT;
CREATE INDEX stats_by_id ON stats(stat_id, min_value, max_value);
CREATE INDEX stats_by_item ON stats(item_id);
CREATE TABLE properties (
 row_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
 property_group TEXT NOT NULL, properties_json TEXT NOT NULL
) STRICT;
CREATE TABLE documents (
 item_id TEXT PRIMARY KEY REFERENCES items(id), content TEXT NOT NULL, record_json TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE item_search USING fts5(item_id UNINDEXED,name,base_type,item_class,content,tokenize='unicode61');
CREATE VIEW current_unique_items AS SELECT * FROM items;
`;
database.exec(schema);
await fs.writeFile(path.join(root, 'schema.sql'), schema.trim() + '\n');
const insertItem = database.prepare(`INSERT INTO items VALUES (${Array(30).fill('?').join(',')})`);
const insertMod = database.prepare('INSERT INTO modifiers(item_id,mod_id,text,is_random,is_implicit,is_explicit,is_enchantment,raw_source_json) VALUES (?,?,?,?,?,?,?,?)');
const insertStat = database.prepare('INSERT INTO stats(item_id,stat_id,mod_id,min_value,max_value,source_average,is_random,raw_source_json) VALUES (?,?,?,?,?,?,?,?)');
const insertProperty = database.prepare('INSERT INTO properties(item_id,property_group,properties_json) VALUES (?,?,?)');
const insertDocument = database.prepare('INSERT INTO documents VALUES (?,?,?)');
const insertSearch = database.prepare('INSERT INTO item_search VALUES (?,?,?,?,?)');
const records = [];
database.exec('BEGIN');
try {
  const metadata = { game: 'poe1', patch: '3.30', league: 'Covens of Umbra', snapshot_id: snapshotId, fetched_at: manifest.fetched_at, language: 'en', schema_version: '0.1', scope: 'source-asserted obtainable uniques in standard Softcore Covens; legacy excluded', completeness: 'all matching rows in the fetched Wiki catalogue; not independently certified complete game coverage', inference_policy: 'Treat random modifiers as alternatives, never as simultaneous guaranteed properties. NULL means unknown. Numeric averages are source metadata, not actual item rolls. Preserve conditions and use engine rules for calculations.' };
  for (const [key, value] of Object.entries(metadata)) database.prepare('INSERT INTO metadata VALUES (?,?)').run(key, value);
  for (const source of manifest.sources) database.prepare('INSERT INTO sources(url,cache_file,sha256,obtained_at) VALUES (?,?,?,?)').run(source.url, source.file, source.sha256, source.obtained_at ?? manifest.fetched_at);
  for (const item of accepted) {
    const id = `poe1:wiki:${item.page_id}:3.30`;
    const name = plainText(item.name), pageName = plainText(item.page_name), baseType = plainText(item.base_item) || null;
    const implicit = splitOptions(item.implicit_stat_text), explicit = splitOptions(item.explicit_stat_text);
    const choices = [...implicit.choices, ...explicit.choices];
    const mods = modifiersByPage.get(item.page_name) ?? [];
    const modMap = new Map(mods.map(mod => [mod.id, mod]));
    const stats = (statsByPage.get(item.page_name) ?? []).map(row => ({ stat_id: row.id, mod_id: row.mod_id, min: numeric(row.min), max: numeric(row.max), source_average: numeric(row.avg), is_random: numeric(modMap.get(row.mod_id)?.is_random), raw: row }));
    const properties = Object.fromEntries(Object.entries(extras).map(([table, values]) => [table, (values.get(item.page_name) ?? []).map(({ page_name, ...rest }) => rest)]).filter(([, values]) => values.length));
    insertItem.run(id, name, pageName, baseType, item.base_item_id, item.class, item.metadata_id, 'poe1', '3.30', 'Covens of Umbra', 'en', snapshotId,
      numeric(item.required_level), numeric(item.required_strength), numeric(item.required_dexterity), numeric(item.required_intelligence),
      item.release_version, numeric(item.is_replica), numeric(item.is_corrupted), numeric(item.is_drop_restricted),
      item.availability.reason, item.availability.confidence, plainText(item.drop_text) || null, implicit.fixed, explicit.fixed,
      plainText(item.enchantment_stat_text), JSON.stringify(choices), wikiUrl(item.page_name), Number(item.page_id), JSON.stringify(item));
    for (const mod of mods) insertMod.run(id, mod.id, plainText(mod.text) || null, numeric(mod.is_random), numeric(mod.is_implicit), numeric(mod.is_explicit), numeric(mod.is_enchantment), JSON.stringify(mod));
    for (const stat of stats) insertStat.run(id, stat.stat_id, stat.mod_id, stat.min, stat.max, stat.source_average, stat.is_random, JSON.stringify(stat.raw));
    for (const [table, values] of Object.entries(properties)) for (const value of values) insertProperty.run(id, table, JSON.stringify(value));
    const content = [`${name} — ${baseType ?? item.class}`, 'Path of Exile 1 | patch 3.30 | Covens of Umbra', `Class: ${item.class}`, `Required level: ${item.required_level ?? 'unknown'}`,
      `Acquisition (source text): ${plainText(item.drop_text) || 'not specified'}`, `Implicit effects:\n${implicit.fixed}`, `Fixed explicit effects:\n${explicit.fixed}`,
      choices.length ? `RANDOM OPTIONS — alternatives, NOT all guaranteed together:\n${choices.join('\n')}` : '',
      item.conflicting_fields?.length ? `SOURCE CONFLICT: ${item.conflicting_fields.join(', ')}. Conflicting text withheld; inspect source alternatives.` : '',
      `Availability: source-asserted, not an independent per-item acquisition test.`, `Source: ${wikiUrl(item.page_name)}`].filter(Boolean).join('\n\n');
    const record = { id, game: 'poe1', patch: '3.30', league: 'Covens of Umbra', language: 'en', snapshot_id: snapshotId, name, base_type: baseType, item_class: item.class,
      requirements: { level: numeric(item.required_level), strength: numeric(item.required_strength), dexterity: numeric(item.required_dexterity), intelligence: numeric(item.required_intelligence) },
      availability: { status: 'source_asserted_obtainable', basis: item.availability.reason, independently_verified: false },
      effects: { implicit: implicit.fixed, explicit_fixed: explicit.fixed, random_options: choices, enchantment: plainText(item.enchantment_stat_text) },
      source_conflicts: item.conflicting_fields ?? [],
      source_alternatives: item.conflicting_fields?.length ? item.source_rows.map(row => ({ implicit: plainText(row.implicit_stat_text), explicit: splitOptions(row.explicit_stat_text), acquisition: plainText(row.drop_text) })) : [],
      modifiers: mods.map(mod => ({ id: mod.id, text: plainText(mod.text) || null, is_random: numeric(mod.is_random), is_implicit: numeric(mod.is_implicit), is_explicit: numeric(mod.is_explicit) })),
      numeric_stats: stats.map(({ raw, ...stat }) => stat), properties, unavailable_property_groups: missingGroups, acquisition_text: plainText(item.drop_text) || null,
      source: { url: wikiUrl(item.page_name), wiki_page_id: Number(item.page_id), snapshot_fetched_at: manifest.fetched_at, provider: 'PoE Wiki Cargo' }, content };
    records.push(record);
    insertDocument.run(id, content, JSON.stringify(record));
    insertSearch.run(id, name, baseType, item.class, content);
  }
  database.exec('COMMIT');
} catch (error) { database.exec('ROLLBACK'); database.close(); throw error; }

const integrity = database.prepare('PRAGMA integrity_check').all();
const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
if (integrity.some(row => row.integrity_check !== 'ok') || foreignKeys.length) throw new Error('Database integrity failed');
const summary = { ...manifest, sources: undefined, snapshot_id: snapshotId, source_unique_rows: rows.length, included_items: records.length, excluded_items: excluded.length, filter_counts: counts,
  duplicate_item_rows: rows.length - groupBy(rows, 'page_name').size,
  source_conflict_pages: duplicateConflicts.map(row => row.page_name),
  distinct_item_names: new Set(records.map(record => record.name)).size,
  missing_optional_property_groups: missingGroups,
  modifier_rows: database.prepare('SELECT COUNT(*) AS n FROM modifiers').get().n,
  numeric_stat_rows: database.prepare('SELECT COUNT(*) AS n FROM stats').get().n,
  property_rows: database.prepare('SELECT COUNT(*) AS n FROM properties').get().n,
  source_responses: manifest.sources.length,
  classes: database.prepare('SELECT item_class,COUNT(*) AS count FROM items GROUP BY item_class ORDER BY count DESC').all(),
  warnings: ['Availability comes from community source flags; individual acquisition was not independently tested.', 'Records excluded for uncertain availability remain in the audit report, not in the database.', 'English original text; Russian localization is not included.', 'The Wiki Foulborn table contains only one source row. Supplementary PoB pools are stored in the separate knowledge database; exhaustive variants and combination rules are not verified.', 'This is retrieval data, not a combat calculator or model training run.'], integrity: 'ok' };
database.close();
await fs.rename(temporary, path.join(out, 'poe-3.30.sqlite'));
await fs.writeFile(path.join(out, 'uniques-3.30.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
await fs.writeFile(path.join(reports, 'import-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ items: summary.included_items, modifiers: summary.modifier_rows, stats: summary.numeric_stat_rows, excluded: summary.excluded_items, integrity: summary.integrity }));
