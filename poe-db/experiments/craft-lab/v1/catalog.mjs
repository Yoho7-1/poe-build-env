import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const root = fileURLToPath(new URL('./', import.meta.url));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const digest = value => hash(JSON.stringify(canonical(value)));
export const domains = new Set(['item', 'flask', 'jewel', 'abyss_jewel', 'affliction_jewel', 'tincture', 'heist_trinket', 'area', 'heist_area', 'deepwater_chart']);
export const influenceSuffix = Object.freeze({ Shaper: 'shaper', Elder: 'elder', Crusader: 'crusader', Redeemer: 'eyrie', Hunter: 'basilisk', Warlord: 'adjudicator' });

export function loadCatalog() {
  const lock = JSON.parse(fs.readFileSync(new URL('./sources.json', import.meta.url)));
  const data = {};
  for (const source of lock.sources) {
    const bytes = fs.readFileSync(new URL('../../../' + source.file, import.meta.url));
    if (hash(bytes) !== source.sha256) throw new Error(`Pinned source changed: ${source.file}; migrate explicitly`);
    data[source.file.split('/').at(-1).replace('.json', '')] = JSON.parse(bytes);
  }
  const map = value => new Map(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, row]) => [id, { id, ...row }]));
  const allBases = map(data.base_items), mods = map(data.mods);
  const bases = new Map([...allBases].filter(([, base]) => base.release_state === 'released' && domains.has(base.domain)));
  const byDomain = new Map();
  for (const mod of mods.values()) {
    if (!byDomain.has(mod.domain)) byDomain.set(mod.domain, []);
    byDomain.get(mod.domain).push(mod);
  }
  const recipes = new Map(data.crafting_bench_options.map((row, index) => [String(index), { id: String(index), ...row }]));
  const essences = map(data.essences), fossils = map(data.fossils);
  const modules = ['catalog.mjs', 'state.mjs', 'operations.mjs', 'session.mjs', 'training.mjs', 'export.mjs', 'cli.mjs', 'coverage.mjs'];
  const contract = digest({ lock, code: modules.map(file => [file, hash(fs.readFileSync(new URL(file, import.meta.url)))]),
    common: hash(fs.readFileSync(new URL('../engine.mjs', import.meta.url))) });
  const statIds = new Set([...mods.values()].flatMap(mod => mod.stats.map(stat => stat.id)));
  const groups = new Set([...mods.values()].flatMap(mod => mod.groups));
  const candidates = new Map();
  for (const [domain, rows] of byDomain) {
    candidates.set(domain + ':affix', rows.filter(mod => ['prefix', 'suffix'].includes(mod.generation_type)));
    for (const generation of new Set(rows.map(mod => mod.generation_type))) candidates.set(domain + ':' + generation, rows.filter(mod => mod.generation_type === generation));
  }
  return { allBases, bases, mods, byDomain, candidates, recipes, essences, fossils, statIds, groups, classes: data.item_classes, clusters: data.cluster_jewels,
    translations: data.stat_translations, handlers: data.stat_value_handlers, lock, contract };
}

export function baseOf(catalog, value) {
  if (catalog.bases.has(value)) return catalog.bases.get(value);
  const matches = [...catalog.bases.values()].filter(base => base.name.toLowerCase() === String(value).toLowerCase());
  if (matches.length > 1) throw new Error(`Ambiguous base name; use exact ID: ${value}`);
  if (!matches.length) throw new Error(`Base is not admitted as a released craftable type: ${value}`);
  return matches[0];
}
export function named(map, value, label) {
  const exact = map.get(value);
  if (exact) return exact;
  const matches = [...map.values()].filter(row => row.name && row.name.toLowerCase() === String(value).toLowerCase());
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous ${label}: ${value}; use an exact ID`);
  return matches[0];
}
export function influenceTag(catalog, base, influence) {
  const suffix = influenceSuffix[influence];
  const tag = catalog.classes[base.item_class]?.influence_tags?.find(tag => tag.endsWith('_' + suffix));
  if (!suffix || !tag) throw new Error(`Influence ${influence} is not supported by ${base.item_class}`);
  return tag;
}
export function currencyName(catalog, id) { return catalog.allBases.get(id)?.name || id; }
