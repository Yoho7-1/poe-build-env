// Packs the locally built data snapshot into one archive for a GitHub Release.
// Usage (from any folder): node poe-db/scripts/data-pack.mjs [--tag data-3.30-YYYY-MM-DD]
// Writes dist/<asset>.tar.gz and updates poe-db/data-release.json (commit that file with the release).
// Does not use the network and does not modify the databases.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dbRoot, projectRoot, readJson, hashFile, atomicJson } from './workspace.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
const releaseFile = path.join(dbRoot, 'data-release.json');
const previous = fs.existsSync(releaseFile) ? readJson(releaseFile) : {};
const tag = option('--tag') ?? `data-${lock.patch}-${new Date().toISOString().slice(0, 10)}`;
if (!/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error('Tag must be printable ASCII without spaces');
const asset = `poe-${tag}.tar.gz`;

// Everything a fresh clone needs for `doctor --deep`, except npm packages and PoB (installed separately).
const rel = file => path.relative(projectRoot, path.join(dbRoot, file)).split(path.sep).join('/');
const files = new Set();
const addTree = folder => {
  const absolute = path.join(dbRoot, folder);
  if (!fs.existsSync(absolute)) throw new Error(`Missing ${folder}`);
  for (const entry of fs.readdirSync(absolute, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith('.tmp') || entry.name === '.write-lock') continue;
    files.add(rel(path.relative(dbRoot, path.join(entry.parentPath, entry.name))));
  }
};
addTree('data');
addTree('cache/knowledge');
addTree('cache/research');
// Wiki Cargo/page cache: sources of scenarios/enemies.json (boss varieties) and of the leveling/changes builds.
addTree('cache/wiki');
files.add(rel('cache/manifest.json'));
for (const source of readJson(path.join(dbRoot, 'cache/manifest.json')).sources) {
  if (!source.file.startsWith('cache/')) continue; // Files outside cache/ are tracked in git.
  files.add(rel(source.file));
}
const list = [...files].sort();
for (const file of list) if (!/^[\x21-\x7e]+$/.test(file)) throw new Error(`Non-ASCII path in data pack: ${file}`);

const distDir = path.join(projectRoot, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const listFile = path.join(distDir, `${tag}.files.txt`);
fs.writeFileSync(listFile, list.join('\n') + '\n');
const output = path.join(distDir, asset);
if (fs.existsSync(output)) throw new Error(`${path.relative(projectRoot, output)} already exists; choose another --tag`);
// Relative paths and cwd keep tar away from non-ASCII parent folders.
execFileSync('tar', ['-czf', `dist/${asset}`, '-T', `dist/${tag}.files.txt`], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });

const release = {
  schema_version: 1,
  repository: previous.repository ?? null, // "owner/name" on GitHub; set once before the first release.
  tag,
  asset,
  sha256: hashFile(output),
  bytes: fs.statSync(output).size,
  files: list.length,
  game: lock.game,
  patch: lock.patch,
  snapshots: lock.snapshots,
  created_at: new Date().toISOString(),
};
atomicJson(releaseFile, release);
console.log(JSON.stringify({ ...release, archive: path.relative(projectRoot, output).split(path.sep).join('/'),
  next: 'Commit poe-db/data-release.json, create GitHub release with this tag and upload the archive.' }, null, 2));
