import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, 'cache');
await fs.mkdir(cache, { recursive: true });
const api = 'https://www.poewiki.net/w/api.php';
const manifest = { target_game: 'poe1', target_patch: '3.30', league: 'Covens of Umbra', fetched_at: new Date().toISOString(), sources: [] };
let lastRequestAt = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(params, filename) {
  const url = new URL(api);
  for (const [key, value] of Object.entries({ format: 'json', ...params })) url.searchParams.set(key, String(value));
  const file = path.join(cache, filename);
  let text;
  if (!process.argv.includes('--refresh')) {
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const cached = text !== undefined;
  if (!cached) {
    if (process.argv.includes('--cached-only')) { const error = new Error(`Not cached: ${filename}`); error.code = 'CACHE_MISSING'; throw error; }
    for (let attempt = 0; attempt < 4; attempt++) {
      await pause(Math.max(0, 1500 - (Date.now() - lastRequestAt)));
      lastRequestAt = Date.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(45000), headers: { 'User-Agent': 'PoEKnowledgeDB/0.1 (local reference research)' } });
      if ((response.status === 429 || response.status === 503) && attempt < 3) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter ? (Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)) : 15 * (attempt + 1);
        if (!Number.isFinite(seconds) || seconds > 60) throw new Error(`Retry later (${retryAfter}): ${url}`);
        console.log(`Source requests a pause: ${Math.max(1, seconds)} seconds.`);
        await response.body?.cancel();
        await pause(Math.max(1, seconds) * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      text = await response.text();
      break;
    }
    const json = JSON.parse(text);
    if (json.error) throw new Error(JSON.stringify(json.error));
    if (params.action === 'cargoquery' && !Array.isArray(json.cargoquery)) throw new Error(`No cargoquery data: ${url}`);
    await fs.writeFile(file, text);
  }
  manifest.sources.push({ url: url.href, file: `cache/${filename}`, sha256: createHash('sha256').update(text).digest('hex'), obtained_at: (await fs.stat(file)).mtime.toISOString(), cached });
  const json = JSON.parse(text);
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json;
}

const fields = [
  'name', 'base_item', 'base_item_id', 'class', 'metadata_id', 'rarity',
  'drop_enabled', 'is_in_game', 'is_drop_restricted', 'release_version', 'removal_version',
  'drop_text', 'acquisition_tags', 'drop_areas', 'drop_monsters', 'drop_level',
  'implicit_stat_text', 'explicit_stat_text', 'enchantment_stat_text', 'stat_text',
  'required_level', 'required_strength', 'required_dexterity', 'required_intelligence',
  'is_replica', 'is_corrupted', 'is_account_bound', 'inventory_icon', 'tags', 'description'
];

async function tableRows(label, table, selected, where, joins) {
  const rows = [];
  const count = await request({ action: 'cargoquery', tables: table, fields: 'COUNT(*)=total', where, ...(joins ? { join_on: joins } : {}) }, `${label}-count.json`);
  const expected = Number(count.cargoquery[0].title.total);
  for (let offset = 0; offset < expected; offset += 500) {
    const result = await request({ action: 'cargoquery', tables: table, fields: selected, where, ...(joins ? { join_on: joins } : {}), order_by: `${table.split('=')[0].split(',')[0]}._ID`, limit: 500, offset }, `${label}-${offset}.json`);
    rows.push(...result.cargoquery.map(row => row.title));
  }
  if (rows.length !== expected) throw new Error(`Incomplete ${label}: ${rows.length}/${expected}`);
  await fs.writeFile(path.join(cache, `${label}.json`), JSON.stringify(rows, null, 2));
  console.log(`${label}: ${rows.length}/${expected}`);
  return rows;
}

await request({ action: 'query', meta: 'siteinfo', siprop: 'rightsinfo' }, 'wiki-rights.json');
await request({ action: 'cargofields', table: 'items' }, 'schema-items.json');
await tableRows('items', 'items', ['items._pageName=page_name', 'items._pageID=page_id', ...fields.map(field => `items.${field}=${field}`)].join(','), "items.rarity='Unique'");
for (const [label, selected] of [
  ['item_mods', ['id', 'text', 'is_random', 'is_explicit', 'is_implicit', 'is_enchantment', 'is_map_fragment_bonus']],
  ['item_stats', ['id', 'mod_id', 'min', 'max', 'avg']]
]) {
  await request({ action: 'cargofields', table: label }, `schema-${label}.json`);
  await tableRows(label, `${label},items`, [`${label}._pageName=page_name`, ...selected.map(field => `${label}.${field}=${field}`)].join(','), "items.rarity='Unique'", `${label}._pageID=items._pageID`);
}
for (const table of ['armours', 'weapons', 'flasks', 'jewels', 'maps', 'shields', 'tinctures', 'foulborn_modifiers']) {
  try {
    const schema = await request({ action: 'cargofields', table }, `schema-${table}.json`);
    const columns = Object.keys(schema.cargofields).filter(field => !field.endsWith('_html'));
    await tableRows(table, `${table},items`, [`${table}._pageName=page_name`, ...columns.map(field => `${table}.${field}=${field}`)].join(','), "items.rarity='Unique'", `${table}._pageID=items._pageID`);
  } catch (error) {
    if (error.code !== 'CACHE_MISSING') {
      await fs.writeFile(path.join(cache, 'manifest.json'), JSON.stringify(manifest, null, 2));
      throw error;
    }
    (manifest.missing_optional_groups ??= []).push(table);
    console.log(`Optional group not cached: ${table}`);
  }
}
await fs.writeFile(path.join(cache, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Saved ${manifest.sources.length} source responses.`);
