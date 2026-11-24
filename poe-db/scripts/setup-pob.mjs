import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dbRoot, readJson, atomicJson } from './workspace.mjs';

const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
const directory = path.join(dbRoot, 'vendor/pob');
const repository = 'https://github.com/PathOfBuildingCommunity/PathOfBuilding.git';
const offline = process.argv.includes('--cached-only');
const featureFile=path.join(dbRoot,'vendor/pob-source.json');
let previousFeatures=[];
try{previousFeatures=readJson(featureFile).timeless_types??[];}catch{}
const featureIndex=process.argv.indexOf('--timeless');
const timeless=[...new Set([...previousFeatures,...(featureIndex>=0?(process.argv[featureIndex+1]??'').split(','):[])])];
for(const type of timeless)if(!['GloriousVanity','LethalPride','BrutalRestraint','MilitantFaith','ElegantHubris','HeroicTragedy'].includes(type))throw new Error('Unknown --timeless type; use the repository type names without spaces');
await fs.mkdir(path.dirname(directory), { recursive: true });
try { await fs.access(path.join(directory, '.git/HEAD')); }
catch {
  if (offline) throw new Error('PoB metadata is not cached');
  execFileSync('git', ['clone','--depth','1','--filter=blob:none','--no-checkout','--branch',`v${lock.versions.pob}`,repository,directory], { stdio: 'inherit', windowsHide: true });
}
const git = args => execFileSync('git', ['-C',directory,...args], { encoding: 'utf8', windowsHide: true });
if (git(['rev-parse','HEAD']).trim() !== lock.versions.pob_commit) throw new Error('Unexpected PoB source commit');
const entries = git(['ls-tree','-r','HEAD']).trim().split('\n').map(line => {
  const [, sha1, file] = line.match(/^\d+ blob ([a-f\d]+)\t(.+)$/) ?? [];
  return { sha1, file };
}).filter(({ file }) => file && (
  /^src\/(?:Modules|Classes|Data|Export)\/.*\.lua$/.test(file) || /^src\/[^/]+\.lua$/.test(file) ||
  /^src\/TreeData\/(?:3_28|3_29|3_30|legion)\/.*\.lua$/.test(file) || /^src\/TreeData\/[^/]+\/Assets.lua$/.test(file) || /^runtime\/lua\//.test(file) ||
  /^runtime\/(?:lua51|lua-utf8|z|zlib1)\.dll$/.test(file) ||
  /^spec\/System\/Test(?:Defence|Ailments|Attacks|GemSocketQuality|Skills)_spec\.lua$/.test(file) ||
  ['LICENSE.md','manifest.xml','src/Data/ModFoulbornMap.jsonc'].includes(file) ||
  timeless.some(type=>file.startsWith(`src/Data/TimelessJewelData/${type}.zip`))
));
const results = [];
let next = 0;
async function worker() {
  while (next < entries.length) {
    const { file, sha1 } = entries[next++];
    const filename = path.join(directory, file);
    let bytes;
    const matches = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') === sha1;
    try { bytes = await fs.readFile(filename); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!bytes || !matches(bytes)) {
      if (offline) throw new Error(`Missing/modified PoB source: ${file}`);
      const url = `https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/${lock.versions.pob_commit}/${file}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          bytes = Buffer.from(await response.arrayBuffer());
          if (!matches(bytes)) throw new Error('Git blob checksum mismatch');
          break;
        } catch (error) { if (attempt === 2) throw new Error(`${file}: ${error.message}`); }
      }
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, bytes);
    }
    results.push({ file, git_blob_sha1: sha1, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    if (results.length % 40 === 0) console.log(`Verified PoB files: ${results.length}/${entries.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
atomicJson(path.join(dbRoot, 'vendor/pob-source.json'), { repository, version: lock.versions.pob, commit: lock.versions.pob_commit,
  scope: 'Headless subset: Lua source, standard 3.28–3.30 trees and runtime; optional pinned Timeless data. No updater or GUI assets.',timeless_types:timeless,
  verified_at: new Date().toISOString(), files: results.sort((a,b) => a.file.localeCompare(b.file)) });
console.log(`Pinned PoB ${lock.versions.pob}: ${results.length} files verified.`);
// Report whether the installed engine can actually start; nothing is installed system-wide.
try {
  const { smokeEngine } = await import('./pob.mjs');
  const smoke = smokeEngine();
  console.log(`PoB host ready: ${smoke.host} (${smoke.host_file}), ${smoke.lua}`);
} catch (error) {
  console.warn(`PoB files are installed, but the engine host did not start: ${error.message}`);
  process.exitCode = 1;
}
