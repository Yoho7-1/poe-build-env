import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const labRoot = fileURLToPath(new URL('./', import.meta.url));
const dbRoot = new URL('../../', import.meta.url);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = value => sha256(JSON.stringify(value));
export const supportedBases = Object.freeze([
  'Metadata/Items/Amulets/Amulet3',
  'Metadata/Items/Rings/Ring4',
  'Metadata/Items/Belts/Belt3',
  'Metadata/Items/Armours/BodyArmours/BodyInt17',
  'Metadata/Items/Armours/Boots/BootsDex1',
  'Metadata/Items/Weapons/OneHandWeapons/Wands/Wand16',
]);

// No database connections, downloads, rebuilds, or writes in the data adapter.
export function loadCatalog() {
  const lockBytes = fs.readFileSync(new URL('./data-lock.json', import.meta.url));
  const lock = JSON.parse(lockBytes);
  const values = {};
  for (const [key, source] of Object.entries(lock.sources)) {
    const bytes = fs.readFileSync(new URL(source.file, dbRoot));
    if (sha256(bytes) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.file}; explicit migration required`);
    values[key] = JSON.parse(bytes);
  }
  const reference = fs.readFileSync(new URL(lock.weight_reference.file, dbRoot));
  if (sha256(reference) !== lock.weight_reference.sha256) throw new Error('Weight reference checksum mismatch; explicit migration required');
  const codeFiles = ['catalog.mjs', 'engine.mjs', 'practice.mjs', 'cli.mjs'];
  const contract = digest({ lock: sha256(lockBytes), code: codeFiles.map(file => [file, sha256(fs.readFileSync(new URL(file, import.meta.url)))]) });
  const bases = new Map(supportedBases.map(id => {
    const base = values.bases[id];
    if (!base || base.domain !== 'item' || base.release_state !== 'released') throw new Error(`Unsupported source base: ${id}`);
    return [id, { id, ...base }];
  }));
  const mods = new Map(Object.entries(values.mods).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, mod]) => [id, { id, ...mod }]));
  const ordinaryMods = [...mods.values()].filter(mod => mod.domain === 'item' && ['prefix', 'suffix'].includes(mod.generation_type) && !mod.is_essence_only);
  const statIds = new Set(ordinaryMods.flatMap(mod => mod.stats.map(stat => stat.id)));
  return { bases, mods, ordinaryMods, statIds, contract, provenance: lock, source_kind: 'pinned_client_data' };
}

export function findBase(catalog, value) {
  const matches = [...catalog.bases.values()].filter(base => base.id === value || base.name.toLowerCase() === String(value).toLowerCase());
  if (matches.length !== 1) throw new Error(`Base outside initial coverage: ${value}`);
  return matches[0];
}
