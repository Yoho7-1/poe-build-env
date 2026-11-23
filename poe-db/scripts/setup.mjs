// One-time installation of a fresh clone.
// Usage: node poe-db/scripts/setup.mjs [--archive <file.tar.gz>] [--skip-pob] [--deep]
// 1) data snapshot from the GitHub Release pinned in poe-db/data-release.json (or a local --archive),
//    verified by SHA-256; 2) npm ci --ignore-scripts; 3) PoB headless subset (setup-pob.mjs);
// 4) empty build "main"; 5) doctor. Network is used only for steps that are missing locally.
// Existing data, PoB and builds are never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dbRoot, projectRoot, readJson, hashFile } from './workspace.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const step = message => console.log(`\n== ${message}`);
const run = (command, commandArgs, cwd = dbRoot) =>
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' && command === 'npm' });

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js >=24 required');

step('Data snapshot');
const dataDir = path.join(dbRoot, 'data');
if (fs.existsSync(path.join(dataDir, 'knowledge-3.30.sqlite'))) console.log('poe-db/data already present; left unchanged.');
else {
  if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) throw new Error('poe-db/data is incomplete; move it aside before setup');
  const release = readJson(path.join(dbRoot, 'data-release.json'));
  let archive = option('--archive');
  if (!archive) {
    archive = path.join(projectRoot, 'dist', release.asset);
    if (!fs.existsSync(archive)) {
      if (!release.repository) throw new Error('data-release.json has no repository; pass --archive <file>');
      const url = `https://github.com/${release.repository}/releases/download/${release.tag}/${release.asset}`;
      console.log(`Downloading ${url} (${(release.bytes / 1048576).toFixed(0)} MB)`);
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      const response = await fetch(url);
      if (response.ok) {
        const partial = `${archive}.tmp`;
        fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
        fs.renameSync(partial, archive);
      } else {
        // Private repository: anonymous download returns 404; use the signed-in GitHub CLI instead.
        console.log(`Anonymous download failed (HTTP ${response.status}); trying "gh release download" (requires gh auth login and access to the repository).`);
        try {
          execFileSync('gh', ['release', 'download', release.tag, '--repo', release.repository, '--pattern', release.asset, '--dir', path.dirname(archive)],
            { stdio: 'inherit', windowsHide: true });
        } catch (error) {
          throw new Error(`Download failed. For a private repository install GitHub CLI, run "gh auth login", or pass --archive <file>. (${error.message})`);
        }
      }
    }
  }
  const actual = hashFile(path.resolve(archive));
  if (actual !== release.sha256) throw new Error(`SHA-256 mismatch for ${archive}: expected ${release.sha256}, got ${actual}`);
  console.log(`Verified ${release.asset} (${release.files} files).`);
  // tar runs with a relative path from the project root to avoid non-ASCII absolute paths.
  const relative = path.relative(projectRoot, path.resolve(archive)).split(path.sep).join('/');
  execFileSync('tar', ['-xzf', relative], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
}

step('npm dependencies');
const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
const parser = path.join(dbRoot, 'node_modules/fast-xml-parser/package.json');
if (fs.existsSync(parser) && readJson(parser).version === lock.versions.xml_parser) console.log('Already installed.');
else run('npm', ['ci', '--ignore-scripts']);

step('Build state');
if (fs.existsSync(path.join(projectRoot, 'builds/main/build.json'))) console.log('builds/main exists; left unchanged.');
else run(process.execPath, ['scripts/agent.mjs', 'build', 'init', 'main']);

step('Path of Building (headless)');
// setup-pob verifies every pinned file and downloads only missing/changed ones, so a rerun resumes an interrupted install.
if (args.includes('--skip-pob')) console.log('Skipped by --skip-pob; PoB calculations and doctor pob checks will fail.');
else run(process.execPath, ['scripts/setup-pob.mjs']);

step('Doctor');
run(process.execPath, ['scripts/agent.mjs', 'doctor', ...(args.includes('--deep') ? ['--deep'] : [])]);
