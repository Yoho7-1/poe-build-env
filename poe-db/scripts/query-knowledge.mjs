import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const filename = fileURLToPath(new URL('../data/knowledge-3.30.sqlite', import.meta.url));
const columns = 'r.category,r.id,r.name,r.name_ru,r.summary,r.eligibility';
const quoteFts = text => text.split(/\s+/).map(word => `"${word.replaceAll('"', '""')}"`).join(' AND ');
function number(value, label, minimum = 0, maximum = Infinity) {
  const n = Number(value);
  if (value === '' || !Number.isInteger(n) || n < minimum || n > maximum) throw new Error(`Invalid ${label}: ${value}`);
  return n;
}
function parse(args) {
  const positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (key === 'include-reference') { options[key] = true; continue; }
    if (!['category', 'tree', 'level', 'limit', 'offset'].includes(key)) throw new Error(`Unknown option: ${args[i]}`);
    if (args[i + 1] == null || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = args[++i];
  }
  return { positional, options };
}

export function queryKnowledge(args = []) {
  const { positional, options } = parse(args);
  const command = positional.shift() ?? 'help';
  if (command === 'help') return { database: filename, network_required: false, commands: {
    metadata: 'Source versions, snapshot and scope',
    categories: 'Counts by domain and eligibility',
    'search <text> [--category gems] [--limit 10] [--offset 0]': 'English/Russian names, identifiers and full text',
    'get <category> <id or exact name>': 'Full record, source and outgoing relations',
    'gem <id or exact name> [--level 20]': 'Gem or granted skill with resolved values at one level',
    'mod <id>': 'Modifier definition, numeric ranges and ordered weights',
    'node <id or exact name> [--tree passive|atlas]': 'Tree node, adjacent nodes and mastery options',
    '--include-reference': 'Also allow historical and unconfirmed entries. Other reference-only definitions are always searchable but do not imply acquisition.'
  } };
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, row.value]));
    const context = { game: metadata.game, patch: metadata.patch, snapshot_id: metadata.snapshot_id };
    const eligible = options['include-reference'] ? '1' : "r.eligibility NOT IN ('historical','unconfirmed')";
    const limit = options.limit == null ? 10 : number(options.limit, 'limit', 1, 100);
    const offset = options.offset == null ? 0 : number(options.offset, 'offset');
    if (command === 'metadata') return { ...context, database: filename, network_required: false, metadata,
      records: db.prepare('SELECT COUNT(*) AS n FROM records').get().n,
      categories: db.prepare('SELECT COUNT(DISTINCT category) AS n FROM records').get().n };
    if (command === 'categories') return { ...context, results: db.prepare('SELECT category,eligibility,COUNT(*) AS records,SUM(name_ru IS NOT NULL) AS russian_names FROM records GROUP BY category,eligibility ORDER BY category,eligibility').all() };
    function full(row) {
      const { payload_json, source_id, ...record } = row;
      return { ...record, data: JSON.parse(payload_json), source: db.prepare('SELECT url,sha256,obtained_at,source_version FROM sources WHERE id=?').get(source_id),
        sources: db.prepare('SELECT rs.role,s.url,s.sha256,s.obtained_at,s.source_version FROM record_sources rs JOIN sources s ON s.id=rs.source_id WHERE rs.category=? AND rs.id=? ORDER BY rs.role').all(row.category, row.id),
        relations: db.prepare('SELECT relation,target_category,target_id FROM relations WHERE category=? AND id=? ORDER BY relation,target_id').all(row.category, row.id) };
    }
    if (command === 'search') {
      const text = positional.join(' ').trim();
      if (!text) throw new Error('Missing search text');
      const params = [], conditions = [eligible];
      if (options.category) { conditions.push('r.category=?'); params.push(options.category); }
      const wildcard = `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      const nameFrom = `FROM records r WHERE ${conditions.join(' AND ')} AND (r.name LIKE ? ESCAPE '\\' OR r.name_ru LIKE ? ESCAPE '\\' OR r.id LIKE ? ESCAPE '\\')`;
      const nameParams = [...params, wildcard, wildcard, wildcard];
      let total = db.prepare(`SELECT COUNT(*) AS n ${nameFrom}`).get(...nameParams).n;
      let results;
      if (total) results = db.prepare(`SELECT ${columns} ${nameFrom} ORDER BY r.name,r.category,r.id LIMIT ? OFFSET ?`).all(...nameParams, limit, offset);
      else {
        const from = `FROM record_search JOIN records r ON r.category=record_search.category AND r.id=record_search.id WHERE ${conditions.join(' AND ')} AND record_search MATCH ?`;
        const values = [...params, quoteFts(text)];
        total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...values).n;
        results = db.prepare(`SELECT ${columns} ${from} ORDER BY rank,r.category,r.id LIMIT ? OFFSET ?`).all(...values, limit, offset);
      }
      return { ...context, total, limit, offset, acquisition_note: 'Eligibility describes source status; reference entries do not establish league availability.', results };
    }
    let category;
    if (command === 'get') category = positional.shift();
    else if (command === 'mod') category = 'mods';
    else if (command === 'gem') category = null;
    else if (command === 'node') {
      const tree = options.tree ?? 'passive';
      if (!['passive', 'atlas'].includes(tree)) throw new Error('tree must be passive or atlas');
      category = tree === 'passive' ? 'passive_nodes' : 'atlas_nodes';
    } else throw new Error(`Unknown knowledge command: ${command}`);
    const text = positional.join(' ').trim();
    if (!text || (command === 'get' && !category)) throw new Error(`Missing query for ${command}`);
    const categorySql = category ? 'r.category=?' : "r.category IN ('gems','granted_skills')";
    const categoryParams = category ? [category] : [];
    const exactIds = db.prepare(`SELECT r.* FROM records r WHERE ${categorySql} AND ${eligible} AND r.id=? ORDER BY r.category,r.id`).all(...categoryParams, text);
    const rows = exactIds.length ? exactIds : db.prepare(`SELECT r.* FROM records r WHERE ${categorySql} AND ${eligible} AND (r.name=? COLLATE NOCASE OR r.name_ru=?) ORDER BY r.category,r.id`).all(...categoryParams, text, text);
    const results = rows.map(row => {
      const record = full(row);
      if (command === 'gem') {
        const level = number(options.level ?? '20', 'level', 1, 1000);
        const resolved = db.prepare('SELECT effects_json FROM gem_levels WHERE gem_id=? AND level=?').get(row.id, level);
        record.level = level;
        record.level_data = resolved ? JSON.parse(resolved.effects_json) : null;
        record.available_levels = db.prepare('SELECT level FROM gem_levels WHERE gem_id=? ORDER BY level').all(row.id).map(x => x.level);
        record.units = metadata.units;
      }
      if (command === 'mod') {
        record.stat_ranges = db.prepare('SELECT stat_id,min_value,max_value FROM mod_stats WHERE mod_id=?').all(row.id);
        record.ordered_weights = db.prepare('SELECT kind,ordinal,tag,weight FROM mod_weights WHERE mod_id=? ORDER BY kind,ordinal').all(row.id);
      }
      if (command === 'node') {
        const tree = options.tree ?? 'passive';
        record.neighbors = db.prepare(`SELECT DISTINCT p.node_id,p.name,p.kind,p.eligibility FROM passive_nodes p JOIN tree_edges e ON p.tree=e.tree AND ((e.from_node=? AND p.node_id=e.to_node) OR (e.to_node=? AND p.node_id=e.from_node)) WHERE e.tree=? ORDER BY p.node_id`).all(row.id, row.id, tree);
        record.mastery_options = db.prepare('SELECT effect_id,stats_json FROM mastery_options WHERE tree=? AND node_id=? ORDER BY effect_id').all(tree, row.id).map(({ effect_id, stats_json }) => ({ effect_id, stats: JSON.parse(stats_json) }));
      }
      return record;
    });
    return { ...context, count: results.length, results };
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(queryKnowledge(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
