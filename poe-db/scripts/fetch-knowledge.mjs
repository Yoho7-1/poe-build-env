import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, 'cache/knowledge');
await fs.mkdir(path.join(cache, 'schemas'), { recursive: true });
const repo = 'https://raw.githubusercontent.com/repoe-fork/repoe-fork.github.io/536caa88b673e232aa410cb47e20dc2d9ecd064e/';
const atlas = 'https://raw.githubusercontent.com/grindinggear/atlastree-export/d225501d7a3e52c991309116473908c284075e89/';
const manifest = { game: 'poe1', target_patch: '3.30', fetched_at: new Date().toISOString(), repoe_commit: '536caa88b673e232aa410cb47e20dc2d9ecd064e', sources: [] };
const offline = process.argv.includes('--cached-only');
async function get(relative, url, json = true) {
  const filename = path.join(cache, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  let text;
  try { text = await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (text && json) { try { if (relative === 'gems.json' && JSON.parse(text).$schema) text = undefined; } catch { text = undefined; } }
  if (text === undefined) {
    if (offline) throw new Error(`Not cached: ${relative}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    text = await response.text();
    if (json) JSON.parse(text);
    await fs.writeFile(filename, text);
  }
  const value = json ? JSON.parse(text) : text.trim();
  if (json && !relative.startsWith('schemas/') && (value.error || value.message || value.$schema)) throw new Error(`Unexpected data: ${relative}`);
  manifest.sources.push({ file: `cache/knowledge/${relative}`, url, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), obtained_at: (await fs.stat(filename)).mtime.toISOString() });
  console.log(`${relative}: ${json ? Object.keys(value).length : value}`);
  return value;
}
await get('version.txt', `${repo}version.txt`, false);
manifest.exported_version = await get('exported-version.txt', `${repo}exported-version.txt`, false);
if (!manifest.exported_version.startsWith('3.30.')) throw new Error('Source export is not 3.30');
await get('atlas-tree.json', `${atlas}data.json`);
const treeFile = path.resolve(root, '../research/330/ggg-passive-tree.json');
const treeText = await fs.readFile(treeFile, 'utf8');
manifest.sources.push({ file: '../research/330/ggg-passive-tree.json', url: 'https://raw.githubusercontent.com/grindinggear/skilltree-export/550fb34ae7fca9ec4d760a2ac845bb2ba1032ec3/data.json', sha256: createHash('sha256').update(treeText).digest('hex'), bytes: Buffer.byteLength(treeText), obtained_at: (await fs.stat(treeFile)).mtime.toISOString() });
const files = ['base_items', 'gems', 'mods', 'stats', 'stat_translations', 'stat_value_handlers', 'crafting_bench_options', 'essences', 'fossils', 'item_classes', 'tags', 'gem_tags', 'active_skill_types', 'cost_types', 'cluster_jewels', 'cluster_jewel_notables', 'characters', 'default_monster_stats', 'buffs', 'world_areas', 'mercenary_classes', 'mercenary_builds', 'mercenary_skills', 'mercenary_supports'];
for (const name of files) {
  await get(`${name}.json`, `${repo}data/${name}.json`);
  await fs.writeFile(path.join(cache, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
for (const name of ['base_items', 'gems_minimal', 'mods']) await get(`Russian/${name}.json`, `${repo}data/Russian/${name}.json`);
for (const name of ['base_items', 'gems', 'mods', 'crafting_bench_options', 'essences', 'fossils', 'mercenary_builds', 'world_areas', 'buffs']) await get(`schemas/${name}.json`, `${repo}data/data-formats/${name}.json`);
manifest.pob_export_commit = '31d9f0c74da9bffa9d71cfbca9905abe4f2d530d';
manifest.pob_export_version = '2.68.0';
for (const name of ['Pantheons', 'Viscera', 'ModFoulborn', 'ModFoulbornMap', 'BeastCraft', 'Bosses', 'BossSkills', 'TattooPassives', 'Vestigial']) {
  await get(`pob/${name}.json`, `https://raw.githubusercontent.com/repoe-fork/pob-data/${manifest.pob_export_commit}/pob-data/poe1/${name}.json`);
}
await fs.writeFile(path.join(cache, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Saved ${manifest.sources.length} versioned sources.`);
