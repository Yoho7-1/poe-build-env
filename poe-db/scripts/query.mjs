import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { queryKnowledge } from './query-knowledge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const filename = resolve(root, 'data/poe-3.30.sqlite');

function boundedNumber(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value == null || value === '') throw new Error(`Missing ${label}`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) throw new Error(`Invalid ${label}: ${value}`);
  return number;
}

function parseArgs(args) {
  const options = {}, positional = [];
  const allowed = new Set(['limit', 'offset', 'min', 'max', 'class', 'mode']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const flag = arg.slice(2);
    if (flag === 'include-random') { options.includeRandom = true; continue; }
    if (!allowed.has(flag)) throw new Error(`Unknown option: ${arg}`);
    if (args[i + 1] == null || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[flag] = args[++i];
  }
  return { positional, options };
}

function quoteFts(text) {
  return text.trim().split(/\s+/).map(word => `"${word.replaceAll('"', '""')}"`).join(' AND ');
}

function shortRecord(record) {
  return { id: record.id, name: record.name, base_type: record.base_type, item_class: record.item_class, requirements: record.requirements,
    availability: record.availability, effects: record.effects, source_conflicts: record.source_conflicts, source: record.source };
}

export function queryCatalog(args) {
  if (args[0] === 'knowledge') return queryKnowledge(args.slice(1));
  const { positional, options } = parseArgs(args);
  const command = positional.shift() ?? 'help';
  if (command === 'help') return { commands: {
    metadata: 'Snapshot, local paths, counts and limitations',
    'search <text> [--class <class>] [--limit 10] [--offset 0]': 'Compact name or full-text search; English source terms',
    'item <exact name, page name or id>': 'Full matching records; includes separate variants',
    'stat <stat_id> [--min N] [--max N] [--mode guaranteed|possible] [--include-random] [--class <class>]': 'Filter numeric ranges. Guaranteed (default) requires the entire range to fit; possible requires intersection. Random modifiers excluded by default.',
    'classes': 'Item classes and record counts',
    'knowledge <command>': 'Other domains: metadata, categories, search, get, gem, mod, node. Run knowledge help for syntax.'
  }, database: filename, network_required: false };
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const metadata = Object.fromEntries(database.prepare('SELECT key,value FROM metadata').all().map(({ key, value }) => [key, value]));
    const context = { game: metadata.game, patch: metadata.patch, league: metadata.league, snapshot_id: metadata.snapshot_id, language: metadata.language };
    const limit = options.limit == null ? 10 : boundedNumber(options.limit, 'limit', { min: 1, max: 100, integer: true });
    const offset = options.offset == null ? 0 : boundedNumber(options.offset, 'offset', { min: 0, integer: true });
    if (command === 'metadata') {
      const summary = JSON.parse(readFileSync(resolve(root, 'reports/import-summary.json'), 'utf8'));
      return { ...context, database: filename, root, network_required: false, metadata,
        counts: { records: summary.included_items, distinct_names: summary.distinct_item_names, stats: summary.numeric_stat_rows, modifiers: summary.modifier_rows },
        missing_property_groups: summary.missing_optional_property_groups, conflicts: summary.source_conflict_pages, warnings: summary.warnings };
    }
    if (command === 'classes') return { ...context, results: database.prepare('SELECT item_class,COUNT(*) AS records FROM items GROUP BY item_class ORDER BY item_class').all() };
    const text = positional.join(' ').trim();
    if (!text) throw new Error(`Missing query for ${command}`);
    if (command === 'item') {
      const matches = database.prepare('SELECT d.record_json FROM items i JOIN documents d ON d.item_id=i.id WHERE i.id=? OR i.name=? COLLATE NOCASE OR i.page_name=? COLLATE NOCASE ORDER BY i.page_name').all(text, text, text);
      return { ...context, count: matches.length, results: matches.map(row => JSON.parse(row.record_json)) };
    }
    if (command === 'search') {
      const wildcard = `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      const classCondition = options.class ? ' AND i.item_class=?' : '';
      const classParams = options.class ? [options.class] : [];
      const byName = `FROM items i JOIN documents d ON d.item_id=i.id WHERE (i.name LIKE ? ESCAPE '\\' OR i.base_type LIKE ? ESCAPE '\\')${classCondition}`;
      let total = database.prepare(`SELECT COUNT(*) AS n ${byName}`).get(wildcard, wildcard, ...classParams).n;
      let matches;
      if (total) matches = database.prepare(`SELECT d.record_json ${byName} ORDER BY i.name,i.page_name LIMIT ? OFFSET ?`).all(wildcard, wildcard, ...classParams, limit, offset);
      else {
        const from = `FROM item_search JOIN items i ON i.id=item_search.item_id JOIN documents d ON d.item_id=i.id WHERE item_search MATCH ?${classCondition}`;
        const fts = quoteFts(text);
        total = database.prepare(`SELECT COUNT(*) AS n ${from}`).get(fts, ...classParams).n;
        matches = database.prepare(`SELECT d.record_json ${from} ORDER BY rank,i.name LIMIT ? OFFSET ?`).all(fts, ...classParams, limit, offset);
      }
      return { ...context, total, offset, limit, results: matches.map(row => shortRecord(JSON.parse(row.record_json))) };
    }
    if (command === 'stat') {
      const mode = options.mode ?? 'guaranteed';
      if (!['guaranteed', 'possible'].includes(mode)) throw new Error('mode must be guaranteed or possible');
      const conditions = ['s.stat_id=?'], params = [text];
      if (!options.includeRandom) conditions.push('s.is_random=0');
      if (options.class) { conditions.push('i.item_class=?'); params.push(options.class); }
      const minimum = options.min == null ? null : boundedNumber(options.min, 'min');
      const maximum = options.max == null ? null : boundedNumber(options.max, 'max');
      if (minimum != null && maximum != null && minimum > maximum) throw new Error('min cannot exceed max');
      if (minimum != null) { conditions.push(`s.${mode === 'guaranteed' ? 'min_value' : 'max_value'}>=?`); params.push(minimum); }
      if (maximum != null) { conditions.push(`s.${mode === 'guaranteed' ? 'max_value' : 'min_value'}<=?`); params.push(maximum); }
      const from = `FROM stats s JOIN items i ON i.id=s.item_id WHERE ${conditions.join(' AND ')}`;
      const total = database.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
      const results = database.prepare(`SELECT i.id,i.name,i.page_name,i.base_type,i.item_class,s.stat_id,s.mod_id,s.min_value,s.max_value,s.is_random,i.source_url ${from} ORDER BY i.name,i.page_name,s.mod_id LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return { ...context, mode, scope_note: 'Guaranteed applies to the source roll range only; activation conditions and alternative item variants still require checking.', random_modifiers_included: !!options.includeRandom, total, offset, limit, results };
    }
    throw new Error(`Unknown command: ${command}`);
  } finally { database.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(queryCatalog(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
