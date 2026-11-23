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
export const armourClasses = Object.freeze(['Body Armour', 'Boots', 'Gloves', 'Helmet']);
export const jewelleryClasses = Object.freeze(['Ring', 'Amulet', 'Belt']);
export const weaponClasses = Object.freeze(['Bow', 'Claw', 'Dagger', 'Rune Dagger', 'One Hand Axe', 'One Hand Mace', 'One Hand Sword', 'Thrusting One Hand Sword', 'Sceptre', 'Staff', 'Warstaff', 'Two Hand Axe', 'Two Hand Mace', 'Two Hand Sword', 'Wand', 'Fishing Rod']);
export const MODULES = ['rules.mjs', 'catalog.mjs', 'item.mjs', 'draw.mjs', 'sockets.mjs', 'actions/basic.mjs', 'actions/crafts.mjs', 'actions/special.mjs', 'actions.mjs', 'session.mjs', 'training.mjs', 'export.mjs', 'coverage.mjs', 'cli.mjs'];

let cached = null;
export function loadCatalog() {
  if (cached) return cached;
  const lock = JSON.parse(fs.readFileSync(new URL('./sources.json', import.meta.url)));
  const data = {};
  for (const source of lock.sources) {
    const bytes = fs.readFileSync(new URL('../../../' + source.file, import.meta.url));
    if (hash(bytes) !== source.sha256) throw new Error(`Pinned source changed: ${source.file}; migrate explicitly`);
    data[source.file.split('/').at(-1).replace('.json', '')] = JSON.parse(bytes);
  }
  const map = value => new Map(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, row]) => [id, { id, ...row }]));
  const allBases = map(data.base_items), mods = map(data.mods);
  const bases = new Map([...allBases].filter(([, base]) => base.release_state === 'released' && domains.has(base.domain) && !/Royale/.test(base.id)));
  const currencies = new Map([...allBases].filter(([, base]) => ['StackableCurrency', 'Currency', 'DelveStackableSocketableCurrency', 'Omen'].includes(base.item_class) || base.id.startsWith('Metadata/Items/Currency/')).map(([id, base]) => [base.name, base]));
  const byDomain = new Map();
  for (const mod of mods.values()) {
    if (!byDomain.has(mod.domain)) byDomain.set(mod.domain, []);
    byDomain.get(mod.domain).push(mod);
  }
  const candidates = new Map();
  for (const [domain, rows] of byDomain) {
    candidates.set(domain + ':affix', rows.filter(mod => ['prefix', 'suffix'].includes(mod.generation_type)));
    for (const generation of new Set(rows.map(mod => mod.generation_type))) candidates.set(domain + ':' + generation, rows.filter(mod => mod.generation_type === generation));
  }
  // Tier tables: mods of one type, side and domain. Tiers are computed per item context in draw.mjs.
  const byType = new Map();
  for (const mod of mods.values()) if (['prefix', 'suffix'].includes(mod.generation_type)) {
    const key = `${mod.domain}|${mod.generation_type}|${mod.type}`;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(mod);
  }
  // Elevated mods (rule influence.elevated_map): an ordinary influence mod links to the Elevated mod of its group whose stats include its
  // stats and whose (zero-weight) spawn tags include one of the ordinary mod's positive influence tags. Several candidates: a unique V2 wins, else refused.
  const elevatedMods = [...mods.values()].filter(mod => /^Elevated /.test(mod.name ?? '') && mod.domain === 'item');
  const links = new Map();
  for (const mod of mods.values()) {
    if (mod.domain !== 'item' || !['prefix', 'suffix'].includes(mod.generation_type) || /^Elevated /.test(mod.name ?? '')) continue;
    const positive = mod.spawn_weights.filter(row => row.weight > 0 && Object.values(influenceSuffix).some(suffix => row.tag.endsWith('_' + suffix))).map(row => row.tag);
    if (!positive.length) continue;
    const stats = mod.stats.map(stat => stat.id);
    const found = elevatedMods.filter(e => e.generation_type === mod.generation_type && e.groups.join() === mod.groups.join()
      && stats.every(id => e.stats.some(s => s.id === id)) && e.spawn_weights.some(row => positive.includes(row.tag)));
    if (found.length) links.set(mod.id, found.map(e => e.id));
  }
  const elevated = new Map();
  for (const [id, found] of links) {
    const choice = found.length === 1 ? found[0] : found.filter(e => /V2/.test(e)).length === 1 ? found.find(e => /V2/.test(e)) : null;
    if (choice) elevated.set(id, choice);
  }
  const recipes = new Map(data.crafting_bench_options.map((row, index) => [String(index), { id: String(index), ...row }]));
  const essences = map(data.essences), fossils = map(data.fossils);
  const fileHash = file => hash(fs.readFileSync(new URL(file, import.meta.url)));
  const contract = digest({ lock, code: MODULES.map(file => [file, fileHash(file)]), common: hash(fs.readFileSync(new URL('../engine.mjs', import.meta.url))) });
  const statIds = new Set([...mods.values()].flatMap(mod => mod.stats.map(stat => stat.id)));
  const groups = new Set([...mods.values()].flatMap(mod => mod.groups));
  const tags = new Set([...mods.values()].flatMap(mod => mod.implicit_tags));
  cached = { allBases, bases, currencies, mods, byDomain, candidates, byType, elevated, recipes, essences, fossils, statIds, groups, tags,
    classes: data.item_classes, clusters: data.cluster_jewels, translations: data.stat_translations, handlers: data.stat_value_handlers, lock, contract };
  return cached;
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
