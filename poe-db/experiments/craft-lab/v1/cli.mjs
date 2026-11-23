import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, root, digest } from './catalog.mjs';
import { createSession, step, replay, observe, model } from './session.mjs';
import { pool } from './state.mjs';
import { exportPob } from './export.mjs';
import { train } from './training.mjs';
import { coverage } from './coverage.mjs';
import { flags, safeId } from '../../../scripts/workspace.mjs';

export const read = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
export function save(name, value, extension = 'json') {
  safeId(name);
  const runs = path.join(root, 'runs'); fs.mkdirSync(runs, { recursive: true });
  if (fs.lstatSync(runs).isSymbolicLink()) throw new Error('runs cannot be a symlink');
  const file = path.join(runs, name + '.' + extension);
  fs.writeFileSync(file, extension === 'txt' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return file;
}
function numeric(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`); return n;
}
export function cli(args) {
  const [command = 'help', ...rest] = args;
  if (command === 'help') return { entry: 'node poe-db/experiments/craft-lab/v1/cli.mjs', model,
    commands: ['status', 'coverage', 'bases [--match text] [--domain item] [--limit 5]', 'mods|recipes|essences|fossils [--match text] [--limit 5]',
      'new --file scenario.json [--save name]', 'step --file snapshot.json --action "Chaos Orb" [--save name]',
      'step --file snapshot.json --action-file action.json [--save name]', 'replay --file snapshot.json',
      'pool --file snapshot.json [--match text] [--limit 5]', 'export --file snapshot.json [--save name]',
      'train --file exercise.json [--episodes 100] [--seed 1] [--max-steps 100] [--save name]'],
    writes: 'Only explicit --save; new files inside v1/runs, never overwrites existing snapshots' };
  const specs = { status: [], coverage: [], bases: ['match', 'domain', 'limit'], mods: ['match', 'domain', 'limit'], recipes: ['match', 'limit'], essences: ['match', 'limit'], fossils: ['match', 'limit'],
    new: ['file', 'save'], step: ['file', 'action', 'action-file', 'save'], replay: ['file'], pool: ['file', 'match', 'limit'], export: ['file', 'save'], train: ['file', 'episodes', 'seed', 'max-steps', 'save'] };
  if (!Object.hasOwn(specs, command)) throw new Error(`Unknown command: ${command}`);
  const { positional, options } = flags(rest, specs[command]); if (positional.length) throw new Error('Unexpected positional arguments');
  if (command === 'coverage') return coverage;
  const catalog = loadCatalog();
  if (command === 'status') return { model, contract: catalog.contract, network_required: false, source_files: catalog.lock.sources.length,
    records: { all_base_definitions: catalog.allBases.size, admitted_bases: catalog.bases.size, modifiers: catalog.mods.size, recipes: catalog.recipes.size, essences: catalog.essences.size, fossils: catalog.fossils.size }, coverage };
  if (['bases', 'mods', 'recipes', 'essences', 'fossils'].includes(command)) {
    const source = { bases: catalog.bases, mods: catalog.mods, recipes: catalog.recipes, essences: catalog.essences, fossils: catalog.fossils }[command];
    const match = (options.match ?? '').toLowerCase(), limit = numeric(options.limit, 5, 1, 100, 'limit');
    const rows = [...source.values()].filter(row => (!options.domain || row.domain === options.domain) && JSON.stringify(row).toLowerCase().includes(match));
    return { total_matches: rows.length, omitted: Math.max(0, rows.length - limit), rows: rows.slice(0, limit).map(row => {
      if (command === 'bases') return { id: row.id, name: row.name, item_class: row.item_class, domain: row.domain };
      if (command === 'mods') return { id: row.id, text: row.text ?? null, domain: row.domain, groups: row.groups, required_level: row.required_level };
      return row;
    }) };
  }
  if (!options.file) throw new Error('--file required');
  if (command === 'train') {
    const result = train(catalog, read(options.file), { episodes: numeric(options.episodes, 100, 1, 10000, 'episodes'), seed: numeric(options.seed, 1, 0, 0xffffffff, 'seed'), max_steps: numeric(options['max-steps'], 100, 1, 10000, 'max steps') });
    if (options.save) result.saved_file = save(options.save, result); return result;
  }
  const session = command === 'new' ? createSession(catalog, read(options.file)) : replay(catalog, read(options.file));
  if (command === 'replay') return { valid: true, state_sha256: digest(session), observation: observe(catalog, session, { includeActions: false }) };
  if (command === 'export') { const result = exportPob(catalog, session.item); if (options.save) result.saved_file = save(options.save, result.text, 'txt'); return result; }
  if (command === 'pool') {
    const result = pool(catalog, session.item), match = (options.match ?? '').toLowerCase(), limit = numeric(options.limit, 5, 1, 100, 'limit');
    const rows = result.rows.filter(row => JSON.stringify(row).toLowerCase().includes(match));
    return { model, contract: catalog.contract, total_candidates: result.rows.length, total_weight: result.total_weight, matched: rows.length, omitted: Math.max(0, rows.length - limit),
      matched_probability: result.total_weight ? rows.reduce((sum, row) => sum + row.weight, 0) / result.total_weight : null,
      rows: rows.slice(0, limit).map(row => ({ ...row, probability: row.weight / result.total_weight })) };
  }
  let next = session;
  if (command === 'step') {
    if (!!options.action === !!options['action-file']) throw new Error('Exactly one of --action and --action-file is required');
    next = step(catalog, session, options.action ?? read(options['action-file']));
  }
  const result = { observation: observe(catalog, next), session: next };
  if (options.save) result.saved_file = save(options.save, next); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(cli(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
