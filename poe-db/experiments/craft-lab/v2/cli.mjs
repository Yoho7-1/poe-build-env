import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, root, digest, baseOf, currencyName } from './catalog.mjs';
import { createSession, step, replay, observe, preview, describeItem, model } from './session.mjs';
import { pool, tierInfo } from './draw.mjs';
import { emptyItem, itemTags } from './item.mjs';
import { exportPob } from './export.mjs';
import { train } from './training.mjs';
import { coverage } from './coverage.mjs';
import { rules } from './rules.mjs';
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
const parseAction = options => {
  if (!!options.action === !!options['action-file'] && !options['action-json']) throw new Error('Exactly one of --action, --action-json, --action-file is required');
  return options['action-json'] ? JSON.parse(options['action-json']) : options.action ?? read(options['action-file']);
};
export function cli(args) {
  const [command = 'help', ...rest] = args;
  if (command === 'help') return { entry: 'node poe-db/experiments/craft-lab/v2/cli.mjs', model,
    commands: ['status', 'coverage', 'rules [--match text]', 'bases [--match text] [--domain item] [--limit 5]', 'mods|recipes|essences|fossils [--match text] [--limit 5]',
      'tiers --base "Vaal Regalia" --ilvl 86 [--match IncreasedLife] [--influence Shaper]', 'pool --base NAME --ilvl N [--rarity rare] [--match text] [--cut strands|foulborn] [--strands N] | pool --file snapshot.json',
      'new --file scenario.json [--save name]', 'step --file snapshot.json (--action "Chaos Orb" | --action-json \'{...}\' | --action-file a.json) [--save name]',
      'preview --file snapshot.json --action NAME (Hinekora-locked item only)', 'replay --file snapshot.json', 'export --file snapshot.json [--save name]',
      'train --file exercise.json [--episodes 100] [--seed 1] [--max-steps 100] [--save name]'],
    writes: 'Only explicit --save; new files inside v2/runs, never overwrites' };
  const A = ['action', 'action-json', 'action-file'];
  const specs = { status: [], coverage: [], rules: ['match'], bases: ['match', 'domain', 'limit'], mods: ['match', 'domain', 'limit'], recipes: ['match', 'limit'], essences: ['match', 'limit'], fossils: ['match', 'limit'],
    tiers: ['base', 'ilvl', 'match', 'influence', 'limit'], pool: ['file', 'base', 'ilvl', 'rarity', 'match', 'limit', 'cut', 'strands', 'influence', 'tag', 'side'],
    new: ['file', 'save'], step: ['file', ...A, 'save'], preview: ['file', ...A], replay: ['file'], export: ['file', 'save'], train: ['file', 'episodes', 'seed', 'max-steps', 'save'] };
  if (!Object.hasOwn(specs, command)) throw new Error(`Unknown command: ${command}`);
  const { positional, options } = flags(rest, specs[command]); if (positional.length) throw new Error('Unexpected positional arguments');
  if (command === 'coverage') return coverage;
  if (command === 'rules') { const match = (options.match ?? '').toLowerCase(); return Object.fromEntries(Object.entries(rules).filter(([id, row]) => (id + JSON.stringify(row)).toLowerCase().includes(match))); }
  const catalog = loadCatalog();
  const limit = numeric(options.limit, command === 'tiers' ? 50 : 5, 1, 500, 'limit');
  if (command === 'status') return { model, contract: catalog.contract, network_required: false, source_files: catalog.lock.sources.length,
    records: { admitted_bases: catalog.bases.size, modifiers: catalog.mods.size, recipes: catalog.recipes.size, essences: catalog.essences.size, fossils: catalog.fossils.size, elevated_links: catalog.elevated.size, rules: Object.keys(rules).length }, gaps: coverage.gaps.map(g => g.family) };
  if (['bases', 'mods', 'recipes', 'essences', 'fossils'].includes(command)) {
    const source = { bases: catalog.bases, mods: catalog.mods, recipes: catalog.recipes, essences: catalog.essences, fossils: catalog.fossils }[command];
    const match = (options.match ?? '').toLowerCase();
    const rows = [...source.values()].filter(row => (!options.domain || row.domain === options.domain) && (command !== 'fossils' || row.name) && JSON.stringify(row).toLowerCase().includes(match));
    return { total_matches: rows.length, omitted: Math.max(0, rows.length - limit), rows: rows.slice(0, limit).map(row => {
      if (command === 'bases') return { id: row.id, name: row.name, item_class: row.item_class, domain: row.domain, drop_level: row.drop_level, tags: row.tags };
      if (command === 'mods') return { id: row.id, text: row.text ?? null, domain: row.domain, side: row.generation_type, groups: row.groups, type: row.type, required_level: row.required_level, tags: row.implicit_tags };
      if (command === 'recipes') return { id: row.id, actions: Object.fromEntries(Object.entries(row.actions).filter(([, v]) => v !== null && v !== false)), mod_text: row.actions.add_explicit_mod ? catalog.mods.get(row.actions.add_explicit_mod)?.text ?? null : null,
        cost: Object.fromEntries(Object.entries(row.cost).map(([id, n]) => [currencyName(catalog, id), n])), item_classes: row.item_classes };
      return row;
    }) };
  }
  if (command === 'tiers' || (command === 'pool' && !options.file)) {
    if (!options.base || !options.ilvl) throw new Error('--base and --ilvl are required');
    const base = baseOf(catalog, options.base), item = emptyItem(base, numeric(options.ilvl, 1, 1, 100, 'ilvl'));
    item.implicits = []; if (options.influence) item.influences = [options.influence];
    item.rarity = options.rarity ?? 'rare'; item.memory_strands = numeric(options.strands, 0, 0, 100, 'strands');
    if (command === 'tiers') {
      const tags = itemTags(catalog, item), match = (options.match ?? '').toLowerCase(), seen = new Set(), out = [];
      for (const row of pool(catalog, item, { respect_tags: false, ignore_capacity: true }).rows) {
        const mod = catalog.mods.get(row.id), info = tierInfo(catalog, item, mod, tags); const key = mod.type + mod.generation_type;
        if (seen.has(key) || !(mod.type + mod.groups + (mod.text ?? '')).toLowerCase().includes(match)) continue; seen.add(key);
        out.push({ type: mod.type, side: mod.generation_type, group: mod.groups, tiers: info.tiers.map((t, i) => ({ tier: i + 1, id: t.id, required_level: t.required_level, text: t.text, weight: t.spawn_weights.find(w => tags.has(w.tag))?.weight })) });
      }
      return { base: base.name, item_level: item.item_level, types: out.length, omitted: Math.max(0, out.length - limit), rows: out.slice(0, limit) };
    }
    return poolReport(catalog, item, options, limit);
  }
  if (!options.file) throw new Error('--file required');
  if (command === 'train') {
    const result = train(catalog, read(options.file), { episodes: numeric(options.episodes, 100, 1, 10000, 'episodes'), seed: numeric(options.seed, 1, 0, 0xffffffff, 'seed'), max_steps: numeric(options['max-steps'], 100, 1, 10000, 'max steps') });
    if (options.save) result.saved_file = save(options.save, result); return result;
  }
  const session = command === 'new' ? createSession(catalog, read(options.file)) : replay(catalog, read(options.file));
  if (command === 'replay') return { valid: true, state_sha256: digest(session), observation: observe(catalog, session, { includeActions: false }) };
  if (command === 'export') { const result = exportPob(catalog, session.item); if (options.save) result.saved_file = save(options.save, result.text, 'txt'); return result; }
  if (command === 'pool') return poolReport(catalog, session.item, options, limit);
  if (command === 'preview') return { preview: describeItem(catalog, preview(catalog, session, parseAction(options))), note: 'Hinekora preview equals the result of applying this currency next' };
  let next = session;
  if (command === 'step') next = step(catalog, session, parseAction(options));
  const result = { observation: observe(catalog, next), last_step: next.history.at(-1) ?? null, session: next };
  if (options.save) result.saved_file = save(options.save, next); return result;
}
function poolReport(catalog, item, options, limit) {
  const result = pool(catalog, item, { cut: options.cut ?? (item.memory_strands > 0 ? 'strands' : null), influence: options.influence && item.influences.includes(options.influence) ? options.influence : undefined, tag: options.tag, side: options.side });
  const match = (options.match ?? '').toLowerCase(), rows = result.rows.filter(row => JSON.stringify(row).toLowerCase().includes(match));
  return { model, total_candidates: result.rows.length, total_weight: result.total_weight, cut_denominator: result.cut_denominator, matched: rows.length, omitted: Math.max(0, rows.length - limit),
    matched_probability: result.total_weight ? rows.reduce((sum, row) => sum + row.weight, 0) / result.total_weight : null,
    rows: rows.slice(0, limit).map(row => ({ ...row, probability: row.weight / result.total_weight })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(cli(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
