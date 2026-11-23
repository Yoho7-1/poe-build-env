import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { mergeGemLevel, skillNodeKind, treeEdges, recordTitle } from './knowledge-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, 'cache/knowledge');
const read = async file => JSON.parse(await fs.readFile(path.join(cache, file), 'utf8'));
const manifest = await read('manifest.json');
if (manifest.game !== 'poe1' || !manifest.exported_version.startsWith('3.30.')) throw new Error('Wrong game or source patch');
for (const source of manifest.sources) {
  const bytes = await fs.readFile(path.resolve(root, source.file));
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Source hash mismatch: ${source.file}`);
}
const snapshot = createHash('sha256').update(JSON.stringify(manifest.sources.map(s => [s.file, s.sha256]))).digest('hex').slice(0, 16);
const out = path.join(root, 'data/knowledge');
await fs.mkdir(out, { recursive: true });
const temporary = path.join(root, 'data', `knowledge-3.30-${process.pid}.sqlite`);
const db = new DatabaseSync(temporary);
const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE sources(id TEXT PRIMARY KEY,url TEXT NOT NULL,sha256 TEXT NOT NULL,obtained_at TEXT NOT NULL,source_version TEXT NOT NULL) STRICT;
CREATE TABLE records(category TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,name_ru TEXT,summary TEXT NOT NULL,eligibility TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),payload_json TEXT NOT NULL,PRIMARY KEY(category,id)) STRICT;
CREATE INDEX records_name ON records(category,name);
CREATE INDEX records_ru ON records(name_ru);
CREATE TABLE record_sources(category TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),role TEXT NOT NULL,PRIMARY KEY(category,id,role),FOREIGN KEY(category,id) REFERENCES records(category,id)) STRICT;
CREATE VIRTUAL TABLE record_search USING fts5(category UNINDEXED,id UNINDEXED,name,name_ru,summary,tokenize='unicode61');
CREATE TABLE passive_nodes(tree TEXT NOT NULL,node_id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,ascendancy_id TEXT,eligibility TEXT NOT NULL,group_id INTEGER,stats_json TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(tree,node_id)) STRICT;
CREATE TABLE tree_edges(tree TEXT NOT NULL,from_node TEXT NOT NULL,to_node TEXT NOT NULL,PRIMARY KEY(tree,from_node,to_node),FOREIGN KEY(tree,from_node) REFERENCES passive_nodes(tree,node_id),FOREIGN KEY(tree,to_node) REFERENCES passive_nodes(tree,node_id)) STRICT;
CREATE TABLE mastery_options(tree TEXT NOT NULL,node_id TEXT NOT NULL,effect_id TEXT NOT NULL,stats_json TEXT NOT NULL,PRIMARY KEY(tree,node_id,effect_id),FOREIGN KEY(tree,node_id) REFERENCES passive_nodes(tree,node_id)) STRICT;
CREATE TABLE gem_levels(gem_id TEXT NOT NULL,level INTEGER NOT NULL,required_level INTEGER,effects_json TEXT NOT NULL,PRIMARY KEY(gem_id,level)) STRICT;
CREATE TABLE gem_stats(gem_id TEXT NOT NULL,level INTEGER NOT NULL,stat_id TEXT NOT NULL,value REAL,value_type TEXT,FOREIGN KEY(gem_id,level) REFERENCES gem_levels(gem_id,level)) STRICT;
CREATE INDEX gem_stats_by_id ON gem_stats(stat_id,level,value);
CREATE TABLE mod_stats(mod_id TEXT NOT NULL,stat_id TEXT NOT NULL,min_value REAL,max_value REAL) STRICT;
CREATE INDEX mod_stats_lookup ON mod_stats(stat_id,min_value,max_value);
CREATE TABLE mod_weights(mod_id TEXT NOT NULL,kind TEXT NOT NULL,ordinal INTEGER NOT NULL,tag TEXT NOT NULL,weight REAL NOT NULL,PRIMARY KEY(mod_id,kind,ordinal)) STRICT;
CREATE INDEX mod_weights_by_tag ON mod_weights(tag,mod_id);
CREATE TABLE essence_mods(essence_id TEXT NOT NULL,item_class TEXT NOT NULL,mod_id TEXT NOT NULL,PRIMARY KEY(essence_id,item_class)) STRICT;
CREATE TABLE bench_costs(craft_id TEXT NOT NULL,currency_id TEXT NOT NULL,amount REAL NOT NULL,PRIMARY KEY(craft_id,currency_id)) STRICT;
CREATE TABLE relations(category TEXT NOT NULL,id TEXT NOT NULL,relation TEXT NOT NULL,target_category TEXT NOT NULL,target_id TEXT NOT NULL,PRIMARY KEY(category,id,relation,target_category,target_id)) STRICT;
CREATE VIEW released_gems AS SELECT * FROM records WHERE category='gems' AND eligibility='released_in_client';
`;
db.exec(schema);
await fs.writeFile(path.join(root, 'knowledge-schema.sql'), schema.trim() + '\n');
const insert = db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)');
const insertRecordSource = db.prepare('INSERT INTO record_sources VALUES (?,?,?,?)');
const fts = db.prepare('INSERT INTO record_search VALUES (?,?,?,?,?)');
const insertNode = db.prepare('INSERT INTO passive_nodes VALUES (?,?,?,?,?,?,?,?,?)');
const insertEdge = db.prepare('INSERT INTO tree_edges VALUES (?,?,?)');
const insertMastery = db.prepare('INSERT INTO mastery_options VALUES (?,?,?,?)');
const insertLevel = db.prepare('INSERT INTO gem_levels VALUES (?,?,?,?)');
const insertGemStat = db.prepare('INSERT INTO gem_stats VALUES (?,?,?,?,?)');
const insertModStat = db.prepare('INSERT INTO mod_stats VALUES (?,?,?,?)');
const insertWeight = db.prepare('INSERT INTO mod_weights VALUES (?,?,?,?,?)');
const insertEssence = db.prepare('INSERT INTO essence_mods VALUES (?,?,?)');
const insertCost = db.prepare('INSERT INTO bench_costs VALUES (?,?,?)');
const insertRelation = db.prepare('INSERT OR IGNORE INTO relations VALUES (?,?,?,?,?)');
const exportRows = new Map();
const sourceIds = new Map();
const excluded = [];
const issues = [];
let levelsCount = 0;
const levelLines = [];

db.exec('BEGIN');
try {
  const metadata = { game: 'poe1', patch: '3.30', repoe_export_version: manifest.exported_version, pob_export_version: manifest.pob_export_version, snapshot_id: snapshot, language: 'en+ru', fetched_at: manifest.fetched_at,
    scope: 'Versioned reference data for PoE 1. Client presence or a PoB entry is not an acquisition guarantee. Legacy/unreleased kept out of normal lookup.',
    units: 'Numeric values retain source units. Gem cast times and many durations use milliseconds; quality coefficients are raw source coefficients, not interpreted as displayed percentages.',
    limitations: 'No full combat engine, crafting simulator, live economy, comprehensive encounters or complete player-build corpus. Some client data is internal or historical.' };
  for (const [key, value] of Object.entries(metadata)) db.prepare('INSERT INTO metadata VALUES (?,?)').run(key, value);
  for (const [index, source] of manifest.sources.entries()) {
    const id = `source:${index}`;
    sourceIds.set(source.file.replace('cache/knowledge/', ''), id);
    const sourceVersion = source.file.includes('/pob/') ? `PoB ${manifest.pob_export_version}` : source.file.includes('tree.json') ? 'GGG 3.30.0' : manifest.exported_version;
    db.prepare('INSERT INTO sources VALUES (?,?,?,?,?)').run(id, source.url, source.sha256, source.obtained_at, sourceVersion);
  }
  function add(category, id, name, payload, sourceFile, { ru = null, summary = '', eligibility = 'reference_only' } = {}) {
    id = String(id); name = String(name || id);
    ru = ru?.trim() || null;
    const sourceId = sourceIds.get(sourceFile);
    if (!sourceId) throw new Error(`Source not registered: ${sourceFile}`);
    const text = summary || name;
    const json = JSON.stringify(payload);
    insert.run(category, id, name, ru, text, eligibility, sourceId, json);
    insertRecordSource.run(category, id, sourceId, 'primary');
    const ruFile = { base_items: 'Russian/base_items.json', gems: 'Russian/gems_minimal.json', mods: 'Russian/mods.json' }[category];
    const ruSourceId = ru && ruFile ? sourceIds.get(ruFile) : null;
    if (ruSourceId) insertRecordSource.run(category, id, ruSourceId, 'localization');
    fts.run(category, id, name, ru, text);
    const source = manifest.sources[Number(sourceId.split(':')[1])];
    const record = { category, id, name, name_ru: ru, game: 'poe1', patch: '3.30', snapshot_id: snapshot, eligibility, summary: text, source: { url: source.url, version: source.file.includes('/pob/') ? `PoB ${manifest.pob_export_version}` : source.file.includes('tree.json') ? 'GGG 3.30.0' : manifest.exported_version, sha256: source.sha256 }, data: payload };
    if (ruSourceId) {
      const localizedSource = manifest.sources[Number(ruSourceId.split(':')[1])];
      record.localization_source = { url: localizedSource.url, sha256: localizedSource.sha256, version: manifest.exported_version };
    }
    if (!exportRows.has(category)) exportRows.set(category, []);
    exportRows.get(category).push(JSON.stringify(record));
  }

  const tree = JSON.parse(await fs.readFile(path.resolve(root, '../research/330/ggg-passive-tree.json'), 'utf8'));
  const treeSource = '../research/330/ggg-passive-tree.json';
  const coreAsc = new Map(tree.classes.flatMap(c => c.ascendancies.map(a => [a.id, { ...a, class: c.name }])));
  const bloodlines = tree.alternate_ascendancies.filter(a => a.name.endsWith('Bloodline'));
  const historical = new Set(tree.alternate_ascendancies.filter(a => !a.name.endsWith('Bloodline')).map(a => a.id));
  for (const [index, c] of tree.classes.entries()) add('classes', c.name, c.name, { ...c, class_index: index, ascendancy_points_shared: tree.points.ascendancyPoints }, treeSource, { eligibility: 'tree_defined' });
  for (const [id, a] of coreAsc) add('ascendancies', id, a.name, a, treeSource, { summary: `${a.name}; base class: ${a.class}`, eligibility: 'tree_defined' });
  for (const a of bloodlines) add('bloodlines', a.id, a.name, { ...a, shared_ascendancy_points: tree.points.ascendancyPoints, acquisition_verified: false }, treeSource, { eligibility: a.id === 'Brinerot' ? 'unconfirmed' : 'tree_defined', summary: `${a.name}; shares the eight ascendancy points with the primary ascendancy. Acquisition must be checked.` });
  for (const [treeName, data, source] of [['passive', tree, treeSource], ['atlas', await read('atlas-tree.json'), 'atlas-tree.json']]) {
    for (const [id, node] of Object.entries(data.nodes)) {
      const eligibility = historical.has(node.ascendancyName) ? 'historical' : node.ascendancyName === 'Brinerot' ? 'unconfirmed' : node.group == null && !node.isAscendancyStart ? 'granted_only' : 'tree_defined';
      const name = node.name ?? (id === 'root' ? 'Tree Root' : `Node ${id}`);
      insertNode.run(treeName, id, name, skillNodeKind(node), node.ascendancyName ?? null, eligibility, node.group ?? null, JSON.stringify(node.stats ?? []), JSON.stringify(node));
      add(treeName === 'atlas' ? 'atlas_nodes' : 'passive_nodes', id, name, node, source, { summary: [name, coreAsc.get(node.ascendancyName)?.name ?? node.ascendancyName, ...(node.stats ?? []), ...(node.reminderText ?? [])].filter(Boolean).join('\n'), eligibility });
      for (const effect of node.masteryEffects ?? []) insertMastery.run(treeName, id, String(effect.effect), JSON.stringify(effect.stats ?? []));
      if (node.recipe) add('anointments', id, name, { node_id: id, oils: node.recipe, stats: node.stats ?? [] }, source, { eligibility: 'tree_defined', summary: `${name}\n${node.recipe.join(' + ')}\n${(node.stats ?? []).join('\n')}` });
    }
    for (const [from, to] of treeEdges(data)) insertEdge.run(treeName, from, to);
  }
  console.log('Imported passive and Atlas graphs.');

  const bases = await read('base_items.json');
  const ruBases = await read('Russian/base_items.json');
  for (const [id, b] of Object.entries(bases)) {
    if (!['released', 'unique_only'].includes(b.release_state)) { excluded.push({ category: 'base_items', id, reason: b.release_state }); continue; }
    add('base_items', id, b.name, b, 'base_items.json', { ru: ruBases[id]?.name ?? null, summary: `${b.name}\n${ruBases[id]?.name ?? ''}\n${b.item_class}\n${b.properties?.description ?? ''}\n${(b.tags ?? []).join(' ')}`, eligibility: 'released_in_client' });
  }

  const ruGems = new Map(Object.values(await read('Russian/gems_minimal.json')).filter(g => g.base_item?.id).map(g => [`${g.base_item.id}|${g.discriminator ?? ''}`, g]));
  const gems = await read('gems.json');
  for (const [id, gem] of Object.entries(gems)) {
    const state = gem.base_item?.release_state;
    if (state && state !== 'released') { excluded.push({ category: 'gems', id, reason: state }); continue; }
    const category = gem.base_item ? 'gems' : 'granted_skills';
    const { per_level, ...overview } = gem;
    const ruGem = ruGems.get(`${gem.base_item?.id}|${gem.discriminator ?? ''}`);
    const name = gem.display_name ?? gem.active_skill?.display_name ?? gem.base_item?.display_name ?? id;
    const ru = ruGem?.display_name ?? ruGem?.active_skill?.display_name ?? ruGem?.base_item?.display_name ?? null;
    add(category, id, name, { ...overview, level_count: Object.keys(per_level ?? {}).length, quality_coefficients_are_raw: true, description_ru: ruGem?.active_skill?.description ?? ruGem?.support_gem?.support_text ?? null }, 'gems.json',
      { ru, eligibility: gem.base_item ? 'released_in_client' : 'granted_only', summary: [name, ru, gem.active_skill?.description, gem.support_gem?.support_text, ...(gem.tags ?? []), ...Object.values(gem.static?.stat_text ?? {})].filter(Boolean).join('\n') });
    for (const level of Object.keys(per_level ?? {})) {
      const resolved = mergeGemLevel(gem, level);
      insertLevel.run(id, Number(level), resolved.required_level ?? null, JSON.stringify(resolved));
      for (const stat of resolved.stats) if (stat.value != null && typeof stat.value === 'number') insertGemStat.run(id, Number(level), stat.id, stat.value, stat.type ?? null);
      levelsCount++;
      levelLines.push(JSON.stringify({ gem_id: id, category, level: Number(level), game: 'poe1', patch: '3.30', snapshot_id: snapshot, units: 'source_native', data: resolved }));
    }
  }
  console.log(`Imported gems and ${levelsCount} skill levels.`);

  const mods = await read('mods.json');
  const ruMods = await read('Russian/mods.json');
  for (const [id, mod] of Object.entries(mods)) {
    add('mods', id, mod.name || id, mod, 'mods.json', { ru: ruMods[id]?.name || null, summary: [id, mod.name, mod.text, ruMods[id]?.text, mod.domain, mod.generation_type, ...(mod.implicit_tags ?? [])].filter(Boolean).join('\n') });
    for (const stat of mod.stats ?? []) insertModStat.run(id, stat.id, stat.min ?? null, stat.max ?? null);
    for (const kind of ['spawn_weights', 'generation_weights']) for (const [ordinal, weight] of (mod[kind] ?? []).entries()) insertWeight.run(id, kind, ordinal, weight.tag, weight.weight);
  }
  for (const [id, craft] of Object.entries(await read('crafting_bench_options.json'))) {
    const modId = craft.actions?.add_explicit_mod ?? craft.actions?.add_enchant_mod;
    const title = mods[modId]?.text || `Bench craft ${id}`;
    add('bench_crafts', id, title, craft, 'crafting_bench_options.json', { summary: [title, ...(craft.item_classes ?? []), JSON.stringify(craft.actions), ...Object.entries(craft.cost ?? {}).map(([currency, amount]) => `${amount} ${bases[currency]?.name ?? currency}`)].join('\n') });
    for (const [currency, amount] of Object.entries(craft.cost ?? {})) insertCost.run(id, currency, amount);
    if (modId) insertRelation.run('bench_crafts', id, 'adds_mod', 'mods', modId);
  }
  for (const [id, essence] of Object.entries(await read('essences.json'))) {
    add('essences', id, essence.name, essence, 'essences.json');
    for (const [itemClass, modId] of Object.entries(essence.mods ?? {})) {
      if (modId == null) continue;
      insertEssence.run(id, itemClass, modId); insertRelation.run('essences', id, itemClass, 'mods', modId);
    }
  }
  for (const [id, fossil] of Object.entries(await read('fossils.json'))) add('fossils', id, fossil.name ?? id, fossil, 'fossils.json', { summary: [fossil.name, ...Object.values(fossil.descriptions ?? {})].filter(Boolean).join('\n') });
  console.log('Imported modifiers, weights and crafting definitions.');

  for (const [category, filename] of [['stat_definitions','stats'],['stat_translations','stat_translations'],['stat_value_handlers','stat_value_handlers'],['item_classes','item_classes'],['tags','tags'],['gem_tags','gem_tags'],['skill_types','active_skill_types'],['cost_types','cost_types'],['cluster_jewels','cluster_jewels'],['cluster_notables','cluster_jewel_notables'],['character_defaults','characters'],['monster_level_defaults','default_monster_stats'],['buffs','buffs'],['world_areas','world_areas'],['mercenary_classes','mercenary_classes'],['mercenary_builds','mercenary_builds'],['mercenary_skills','mercenary_skills'],['mercenary_supports','mercenary_supports']]) {
    for (const [key, value] of Object.entries(await read(`${filename}.json`))) {
      if (category === 'world_areas' && (key === 'NULL' || !value.name || value.name === 'NULL')) continue;
      const id = Array.isArray(value) ? key : typeof value === 'object' && value !== null ? value.id ?? key : key;
      const name = recordTitle(id, value);
      let summary = [name, value?.description, value?.support_text, ...Object.values(value?.stat_text ?? {}), ...(value?.stat_text && Array.isArray(value.stat_text) ? [] : [])].filter(Boolean).join('\n');
      if (category === 'stat_translations') summary = [...(value.ids ?? []), ...(value.English ?? []).map(rule => rule.string)].join('\n');
      add(category, id, name, value, `${filename}.json`, { summary });
      if (category === 'mercenary_builds') insertRelation.run(category, String(id), 'class', 'mercenary_classes', value.class_id);
    }
  }

  for (const [category, file] of [['pantheon','Pantheons'],['viscera','Viscera'],['foulborn_mods','ModFoulborn'],['beastcraft_mods','BeastCraft'],['boss_profiles','Bosses'],['vestigial_mods','Vestigial']]) {
    for (const [key, value] of Object.entries(await read(`pob/${file}.json`))) {
      const name = typeof value === 'string' ? value.trim().split('\n')[0] : category === 'vestigial_mods' ? key : recordTitle(key, value);
      const summary = typeof value === 'string' ? value : category === 'pantheon' ? `${key}\n${(value.souls ?? []).flatMap(soul => [soul.name, ...(soul.mods ?? []).map(mod => mod.line)]).join('\n')}` : [name, ...Object.entries(value).filter(([key]) => /^\d+$/.test(key)).map(([, line]) => line)].join('\n');
      add(category, key, name, value, `pob/${file}.json`, { summary });
    }
  }
  const uniqueDb = new DatabaseSync(path.join(root, 'data/poe-3.30.sqlite'), { readOnly: true });
  const currentNames = new Set(uniqueDb.prepare('SELECT DISTINCT name FROM items').all().map(row => row.name));
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('uniques_snapshot_id', uniqueDb.prepare("SELECT value FROM metadata WHERE key='snapshot_id'").get().value);
  uniqueDb.close();
  for (const [name, lines] of Object.entries(await read('pob/ModFoulbornMap.json'))) {
    if (!currentNames.has(name)) { excluded.push({ category: 'foulborn_replacements', id: name, reason: 'unique_not_in_current_catalogue' }); continue; }
    add('foulborn_replacements', name, name, { item_name: name, possible_replacement_lines: lines, simultaneous: false, combination_rules_complete: false }, 'pob/ModFoulbornMap.json', { summary: `${name}\nPossible replacements, not simultaneous guarantees:\n${lines.join('\n')}`, eligibility: 'current_item_reference' });
  }
  const bosses = await read('pob/BossSkills.json');
  for (const [id, skill] of Object.entries(bosses.bossSkills ?? {})) add('boss_skills', id, id, skill, 'pob/BossSkills.json', { summary: `${id}\n${skill.tooltip ?? ''}\n${skill.DamageType ?? ''}` });
  const tattoo = await read('pob/TattooPassives.json');
  for (const [id, node] of Object.entries(tattoo.nodes ?? {})) add('tattoo_nodes', id, node.dn || id || node.id, node, 'pob/TattooPassives.json', { summary: `${node.dn || id}\n${(node.sd ?? []).join('\n')}` });

  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
const integrity = db.prepare('PRAGMA integrity_check').all();
const fk = db.prepare('PRAGMA foreign_key_check').all();
if (integrity.some(row => row.integrity_check !== 'ok') || fk.length) throw new Error('Knowledge integrity check failed');
const summary = { game: 'poe1', patch: '3.30', snapshot_id: snapshot, fetched_at: manifest.fetched_at, repoe_export_version: manifest.exported_version, pob_export_version: manifest.pob_export_version, source_files: manifest.sources.length,
  categories: db.prepare('SELECT category,COUNT(*) AS records,SUM(name_ru IS NOT NULL) AS russian_names FROM records GROUP BY category ORDER BY category').all(),
  tree_nodes: db.prepare('SELECT tree,COUNT(*) AS nodes FROM passive_nodes GROUP BY tree').all(),
  tree_edges: db.prepare('SELECT tree,COUNT(*) AS edges FROM tree_edges GROUP BY tree').all(),
  mastery_options: db.prepare('SELECT COUNT(*) AS n FROM mastery_options').get().n,
  gem_levels: levelsCount, gem_stat_values: db.prepare('SELECT COUNT(*) AS n FROM gem_stats').get().n,
  mod_stat_ranges: db.prepare('SELECT COUNT(*) AS n FROM mod_stats').get().n, mod_weights: db.prepare('SELECT COUNT(*) AS n FROM mod_weights').get().n,
  excluded_records: excluded.length, issues, integrity: 'ok',
  limitations: ['Source-defined structures, not independent in-game acquisition verification.', 'Raw source units and quality coefficients are preserved.', 'Reference catalogs contain internal definitions; availability and crafting eligibility require context.', 'Velka Bloodline is unconfirmed; historical Affliction ascendancies are not current choices.', 'No complete combat or crafting simulation, live prices, all quest/encounter rules, or tested-build corpus.'] };
db.close();
await fs.rename(temporary, path.join(root, 'data/knowledge-3.30.sqlite'));
for (const [category, lines] of exportRows) await fs.writeFile(path.join(out, `${category}.jsonl`), lines.join('\n') + '\n');
await fs.writeFile(path.join(out, 'gem-levels.jsonl'), levelLines.join('\n') + '\n');
await fs.writeFile(path.join(root, 'reports/knowledge-summary.json'), JSON.stringify(summary, null, 2));
await fs.writeFile(path.join(root, 'reports/knowledge-excluded.json'), JSON.stringify(excluded, null, 2));
console.log(JSON.stringify({ categories: summary.categories.length, records: summary.categories.reduce((sum, row) => sum + row.records, 0), gem_levels: levelsCount, integrity: summary.integrity }));
