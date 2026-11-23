import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, labRoot, findBase, digest } from './catalog.mjs';
import { actions, model, createSession, observe, step, replay, pool, integer } from './engine.mjs';
import { practice } from './practice.mjs';

export const read = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
function parse(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(key) || options[key] !== undefined) throw new Error(`Unknown or repeated option: ${args[i]}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = args[++i];
  }
  return options;
}
function required(options, key) { if (options[key] === undefined) throw new Error(`--${key} required`); return options[key]; }
function number(options, key, fallback, min, max) {
  const value = options[key] === undefined ? fallback : /^\d+$/.test(options[key]) ? Number(options[key]) : NaN;
  return integer(value, min, max, key);
}
export function saveSnapshot(name, value) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}\.json$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.json$/i.test(name)) throw new Error('--save must be a simple lowercase JSON filename');
  const runs = path.join(labRoot, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  if (fs.lstatSync(runs).isSymbolicLink()) throw new Error('runs must be a real local directory');
  const file = path.join(runs, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return file;
}

export function cli(args) {
  const [command = 'help', ...rest] = args;
  if (command === 'help') return { model, network_required: false,
    entrypoint: 'node poe-db/experiments/craft-lab/cli.mjs', commands: {
      status: 'Pinned source inventory and limitations; reads only',
      bases: 'Six deliberately selected ordinary base types',
      'new --file scenario.json [--save first.json]': 'Create an assumed initial state and observe legal actions',
      'step --file snapshot.json --action "Regal Orb" [--save next.json]': 'Verify replay, take one action, return observation and state',
      'replay --file snapshot.json': 'Verify deterministic state, history and spending',
      'pool --base "Amber Amulet" --ilvl 86 [--match Life] [--limit 5]': 'Inspect empty rare item addition pool',
      'pool --file snapshot.json [--action "Regal Orb"] [--match Life] [--limit 5]': 'Inspect an action-conditioned pool; denominator includes hidden rows',
      'practice --file exercise.json [--episodes 100] [--seed 1] [--save result.json]': 'Repeat a fixed action list from fresh independent derived seeds',
    }, writes: 'Only explicit --save, new files inside craft-lab/runs; existing files are never overwritten' };
  const accepted = {
    status: [], bases: [], new: ['file', 'save'], step: ['file', 'action', 'save'], replay: ['file'],
    pool: ['file', 'base', 'ilvl', 'action', 'match', 'limit'], practice: ['file', 'episodes', 'seed', 'save'],
  };
  if (!Object.hasOwn(accepted, command)) throw new Error(`Unknown command: ${command}`);
  const options = parse(rest, accepted[command]), catalog = loadCatalog();
  if (command === 'bases') return { bases: [...catalog.bases.values()].map(base => ({ id: base.id, name: base.name, tags: base.tags, acquisition_verified: false })) };
  if (command === 'status') return { model, network_required: false, database_access: false, contract: catalog.contract, provenance: catalog.provenance,
    records: { source_modifiers: catalog.mods.size, supported_bases: catalog.bases.size }, actions };
  if (command === 'practice') {
    const result = practice(catalog, read(required(options, 'file')), { episodes: number(options, 'episodes', 100, 1, 10000), seed: number(options, 'seed', 1, 0, 0xffffffff) });
    if (options.save) result.saved_file = saveSnapshot(options.save, result);
    return result;
  }
  if (command === 'pool') {
    if (options.file && (options.base || options.ilvl)) throw new Error('Use either --file or --base/--ilvl');
    let session;
    if (options.file) session = replay(catalog, read(options.file));
    else session = createSession(catalog, { base: required(options, 'base'), item_level: number(options, 'ilvl', undefined, 1, 100), rarity: 'rare', mods: [], seed: 0 });
    const action = options.action ?? (session.item.rarity === 'magic' ? 'Orb of Augmentation' : 'Exalted Orb');
    if (!['Orb of Augmentation', 'Regal Orb', 'Exalted Orb'].includes(action)) throw new Error('Pool inspection supports only single-addition actions');
    step(catalog, session, action); // Refuse illegal rarity, full slots and exhausted budgets.
    const candidates = pool(catalog, session.item, { rarity: action === 'Regal Orb' ? 'rare' : session.item.rarity });
    const match = (options.match ?? '').toLowerCase();
    const filtered = candidates.rows.filter(row => [row.id, row.text, ...row.groups].some(text => String(text).toLowerCase().includes(match)));
    const limit = number(options, 'limit', 5, 1, 100);
    const mass = filtered.reduce((sum, row) => sum + row.weight_units, 0);
    return { model, contract: catalog.contract, base_name: findBase(catalog, session.item.base_id).name, action, tags: candidates.tags,
      total_candidates: candidates.rows.length, total_weight_units: candidates.total_weight_units, matched_candidates: filtered.length,
      matched_probability: mass / candidates.total_weight_units, omitted_matches: Math.max(0, filtered.length - limit),
      rows: filtered.slice(0, limit).map(row => ({ ...row, probability: row.weight_units / candidates.total_weight_units })),
      scope: 'Conditional probability of the next added modifier under the stated model; not an entire craft probability' };
  }
  const session = command === 'new' ? createSession(catalog, read(required(options, 'file'))) : replay(catalog, read(required(options, 'file')));
  if (command === 'replay') return { valid: true, state_sha256: digest(session), observation: observe(catalog, session) };
  const next = command === 'step' ? step(catalog, session, required(options, 'action')) : session;
  const result = { observation: observe(catalog, next), session: next };
  if (options.save) result.saved_file = saveSnapshot(options.save, next);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(cli(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
