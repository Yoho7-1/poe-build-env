import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dbRoot, projectRoot, readJson, hashFile, atomicJson, safeId } from './workspace.mjs';
import { loadBuild, briefBuild } from './build-store.mjs';
import { ledgerBrief } from './lab.mjs';
import { runPob, smokeEngine } from './pob.mjs';
import { checkResolveOverrides } from './source-cache.mjs';
import { loadCatalog as loadCraftCatalog } from '../experiments/craft-lab/v2/catalog.mjs';

export function bootstrap(id = 'main', { buildsDirectory = undefined, ledger = undefined } = {}) {
  const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
  return { game: lock.game, patch: lock.patch, mode: lock.mode, root: projectRoot, network_required: false,
    versions: lock.versions, snapshots: lock.snapshots, build: briefBuild(loadBuild(id, buildsDirectory)), lab: ledgerBrief(ledger),
    tasks: { design: '.agents/skills/poe-build-design/SKILL.md', audit: '.agents/skills/poe-build-audit/SKILL.md',
      upgrade: '.agents/skills/poe-upgrade/SKILL.md', research: '.agents/skills/poe-discovery/SKILL.md' },
    help: 'agent.mjs help -> command groups; agent.mjs <group> [operation] --help -> options',
    rules: ['Reference/client presence does not prove league acquisition.', 'Unknown values remain null; alternatives are not simultaneous.',
      'Gem numeric units are source-native; quality requires explicit handling.', 'Preserve activation conditions and report missing evidence.',
      'A PoB calculation is conditional, not an in-game test.', 'Historical originals and local migrations are separate; quarantined references are invalid.',
      'Market prices are dated and variant-specific; resolve currency conversion warnings before totaling a budget.',
      'Before trusting a number read engine_warnings, unparsed_* and the scenario config; not_modelled means not calculated.'],
    next: 'Open the skill for the task in tasks; let commands compute, read only the fields you need; resolve unknown user requirements before a final build.' };
}

export function doctor({ deep = false } = {}) {
  const checks = [];
  const check = (id, operation) => {
    try { const details = operation(); checks.push({ id, status: 'ok', ...details }); }
    catch (error) { checks.push({ id, status: 'error', message: error.message }); }
  };
  const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
  check('node', () => { if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js >=24 required'); return { version: process.versions.node }; });
  for (const [name, file] of [['uniques','poe-3.30.sqlite'],['knowledge','knowledge-3.30.sqlite']]) check(name, () => {
    const db = new DatabaseSync(path.join(dbRoot, 'data', file), { readOnly: true });
    try {
      const m = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(x => [x.key, x.value]));
      if (m.patch !== lock.patch || m.game !== lock.game || m.snapshot_id !== lock.snapshots[name]) throw new Error(`Snapshot mismatch for ${name}; review changes before updating the lock`);
      if (deep && (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)) throw new Error('SQLite integrity/foreign-key failure');
      return { snapshot_id: m.snapshot_id, ...(deep ? { integrity: 'ok' } : {}) };
    } finally { db.close(); }
  });
  check('craft-sim', () => { const c = loadCraftCatalog(); return { version: 'craft-lab-v2', pinned_sources: c.lock.sources.length, modifiers: c.mods.size, recipes: c.recipes.size, game_validated: false }; });
  check('build-state', () => { const state = loadBuild(); return { build_id: state.id, revision: state.revision }; });
  check('dependencies', () => { const installed = readJson(path.join(dbRoot, 'node_modules/fast-xml-parser/package.json')); if (installed.version !== lock.versions.xml_parser) throw new Error('Run npm ci --ignore-scripts in poe-db'); return { xml_parser: installed.version }; });
  check('pob-source', () => {
    const commit = execFileSync('git', ['-C', path.join(dbRoot, 'vendor/pob'), 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    if (commit !== lock.versions.pob_commit) throw new Error('Unexpected PoB commit');
    if (!fs.existsSync(path.join(dbRoot, 'vendor/pob/src/HeadlessWrapper.lua'))) throw new Error('PoB checkout incomplete');
    const manifest=readJson(path.join(dbRoot,'vendor/pob-source.json'));
    if(manifest.commit!==commit)throw new Error('PoB file manifest mismatch');
    if(deep)for(const entry of manifest.files)if(hashFile(path.join(dbRoot,'vendor/pob',entry.file))!==entry.sha256)throw new Error(`Changed PoB file: ${entry.file}`);
    return { commit, verified_files:deep?manifest.files.length:undefined };
  });
  // Runnability, not just presence: PowerShell host + pinned LuaJIT must actually execute.
  check('pob-engine', () => smokeEngine());
  check('mechanics', () => {
    const cards = readJson(path.join(dbRoot, 'mechanics/cards.json'));
    const sources = readJson(path.join(dbRoot, 'mechanics/sources.json'));
    const ids = new Set(sources.map(s => s.id));
    for (const card of cards) if (!card.sources.length || card.sources.some(id => !ids.has(id))) throw new Error(`Unresolved source: ${card.id}`);
    if (deep) for (const source of sources) if (source.file && hashFile(path.resolve(dbRoot, source.file)) !== source.sha256) throw new Error(`Source changed: ${source.id}`);
    const db=new DatabaseSync(path.join(dbRoot,'data/mechanics-3.30.sqlite'),{readOnly:true});
    try {
      if(db.prepare('SELECT COUNT(*) n FROM cards').get().n!==cards.length)throw new Error('Mechanic card count mismatch');
      if(deep&&(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length))throw new Error('Mechanics database integrity failure');
    }finally{db.close();}
    return { cards: cards.length, sources: sources.length };
  });
  check('enemies', () => {
    const db = readJson(path.join(dbRoot, 'scenarios/enemies.json'));
    if (db.provenance.pob_commit !== lock.versions.pob_commit || db.provenance.repoe !== lock.versions.repoe) throw new Error('Enemy database built from other engine/data versions; run: agent.mjs analyze enemies build');
    // Deep: every pinned source must still hash to the value recorded at build time.
    if (deep) for (const s of db.provenance.sources) if (hashFile(path.join(dbRoot, s.file)) !== s.sha256) throw new Error(`Enemy database source changed: ${s.file}; rebuild with analyze enemies build`);
    return { map_mods: Object.keys(db.map_mods).length, archetypes: Object.keys(db.archetypes).length, bosses: Object.keys(db.bosses).length, verified_sources: deep ? db.provenance.sources.length : undefined };
  });
  check('workbench',()=>{
    const db=new DatabaseSync(path.join(dbRoot,'data/workbench-3.30.sqlite'),{readOnly:true});
    try {
      if(deep&&(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length))throw new Error('Workbench database integrity failure');
      let verifiedPriceSources=0,verifiedExampleReports=0;
      if(deep) {
        const digest=value=>createHash('sha256').update(value).digest('hex');
        for(const row of db.prepare('SELECT id,payload_json FROM price_snapshots').all()) {
          const payload=JSON.parse(row.payload_json);
          if(digest(JSON.stringify(payload))!==row.id)throw new Error(`Changed price snapshot: ${row.id}`);
          if(db.prepare('SELECT COUNT(*) n FROM prices WHERE snapshot_id=?').get(row.id).n!==payload.lines.length)throw new Error(`Incomplete price index: ${row.id}`);
          if(payload.source_sha256) {
            const prefix=digest(payload.source_url),files=[`${prefix}-${payload.source_sha256}.body`,`${prefix}.body`].map(file=>path.join(dbRoot,'cache/research',file));
            if(!files.some(file=>fs.existsSync(file)&&hashFile(file)===payload.source_sha256))throw new Error(`Missing/changed raw price source: ${payload.category}`);
            verifiedPriceSources++;
          }
        }
        for(const row of db.prepare('SELECT id,kind,sha256,xml,notes_json FROM examples').all()) {
          if(digest(row.xml)!==row.sha256)throw new Error(`Changed reference XML: ${row.id}`);
          const notes=JSON.parse(row.notes_json),analysis=notes.analysis,provenance=notes.provenance;
          if(provenance?.stored_original_file&&hashFile(path.resolve(dbRoot,provenance.stored_original_file))!==provenance.original_bytes_sha256)throw new Error(`Original archive hash mismatch: ${row.id}`);
          if(Array.isArray(provenance?.source_mapping_evidence))for(const evidence of provenance.source_mapping_evidence)if(hashFile(path.resolve(dbRoot,evidence.file))!==evidence.sha256)throw new Error(`Reference provenance hash mismatch: ${row.id}`);
          if(row.kind==='quarantined'||!analysis?.reports)continue;
          const migration=readJson(path.resolve(dbRoot,analysis.reports.migration));
          if(migration.migration.trees.length!==analysis.node_deltas.length)throw new Error(`Incomplete reference tree import: ${row.id}`);
          for(const [scenario,file]of Object.entries(analysis.reports)) {
            const result=readJson(path.resolve(dbRoot,file));
            if(!analysis.calculations.some(c=>c.id===result.calculation_id))throw new Error(`Reference report mismatch: ${row.id}/${scenario}`);
            if(scenario!=='migration'&&result.input_sha256!==row.sha256)throw new Error(`Reference baseline mismatch: ${row.id}/${scenario}`);
            verifiedExampleReports++;
          }
        }
      }
      return {examples:db.prepare('SELECT COUNT(*) n FROM examples').get().n,price_snapshots:db.prepare('SELECT COUNT(*) n FROM price_snapshots').get().n,price_observations:db.prepare('SELECT COUNT(*) n FROM prices').get().n,craft_plans:db.prepare('SELECT COUNT(*) n FROM craft_plans').get().n,...(deep?{verified_price_sources:verifiedPriceSources,verified_reference_reports:verifiedExampleReports}:{})};
    }finally{db.close();}
  });
  if (deep) check('source-cache', () => {
    const manifests = ['cache/knowledge/manifest.json','cache/manifest.json'].map(file=>readJson(path.join(dbRoot,file)));
    for(const manifest of manifests)for (const source of manifest.sources) if (hashFile(path.resolve(dbRoot, source.file)) !== source.sha256) throw new Error(`Hash mismatch: ${source.file}`);
    return { verified_files: manifests.reduce((n,m)=>n+m.sources.length,0) };
  });
  if(deep)check('network-overrides',()=>checkResolveOverrides());
  if(deep)check('pob-control',()=>{
    const expected=readJson(path.join(dbRoot,'fixtures/fireball-control.expected.json'));
    // noCache: a cached control result must not hide a broken engine.
    const input=fs.readFileSync(path.join(dbRoot,'fixtures/fireball-control.xml'),'utf8');
    // Single-shot path (one PoB process) and the persistent host pool must give identical numbers.
    const result=runPob({input,noCache:true,full:true,persistent:false});
    for(const [key,value]of Object.entries(expected.expected))if(!Number.isFinite(result.output[key])||Math.abs(result.output[key]-value)>Math.max(1,Math.abs(value))*expected.relative_tolerance)throw new Error(`Control calculation mismatch: ${key}`);
    const pooled=runPob({input,noCache:true,full:true,persistent:true});
    const differing=[...new Set([...Object.keys(result.output),...Object.keys(pooled.output)])].filter(key=>!Object.is(result.output[key],pooled.output[key]));
    if(differing.length)throw new Error(`Persistent PoB host differs from the single-shot path: ${differing.slice(0,10).join(', ')}`);
    return {engine:result.engine.version,calculation_id:result.calculation_id,checked_stats:Object.keys(expected.expected),persistent_host:{identical_outputs:Object.keys(result.output).length}};
  });
  return { game: lock.game, patch: lock.patch, ready: checks.every(c => c.status === 'ok'), deep, network_required: false, checks };
}

export function backup(label) {
  safeId(label);
  const target = path.join(projectRoot, 'backups', `${new Date().toISOString().replaceAll(':','-')}-${label}`);
  fs.mkdirSync(target, { recursive: true });
  const files = ['data/poe-3.30.sqlite','data/knowledge-3.30.sqlite','data/mechanics-3.30.sqlite','data/workbench-3.30.sqlite','data/uniques-3.30.jsonl','schema.sql','knowledge-schema.sql','environment.lock.json','package.json','package-lock.json','cache/manifest.json','cache/knowledge/manifest.json'];
  const copied = [];
  for (const relative of files) {
    const original = path.join(dbRoot, relative), output = path.join(target, 'poe-db', relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (relative.endsWith('.sqlite')) {
      const db = new DatabaseSync(original, { readOnly: true });
      try { db.exec(`VACUUM INTO '${output.replaceAll("'", "''")}'`); } finally { db.close(); }
    } else fs.copyFileSync(original, output, fs.constants.COPYFILE_EXCL);
    copied.push({ file: `poe-db/${relative}`, sha256: hashFile(output) });
  }
  const copyOptions={recursive:true,errorOnExist:false,force:false,filter:source=>path.basename(source)!=='.write-lock'&&!source.endsWith('.tmp')};
  for (const folder of ['poe-db/data/knowledge','poe-db/mechanics','.agents','poe-db/scripts','poe-db/docs','poe-db/fixtures','poe-db/references','poe-db/test','poe-db/evaluations','poe-db/reports','poe-db/vendor','poe-db/node_modules','poe-db/cache/knowledge','poe-db/cache/research','research/330']) if (fs.existsSync(path.join(projectRoot, folder))) fs.cpSync(path.join(projectRoot, folder), path.join(target, folder), copyOptions);
  const builds=path.join(projectRoot,'builds');
  if(fs.existsSync(builds))for(const entry of fs.readdirSync(builds,{withFileTypes:true})) {
    if(!entry.isDirectory())continue;
    const source=path.join(builds,entry.name),lock=path.join(source,'.write-lock');
    const fd=fs.openSync(lock,'wx');
    try {fs.cpSync(source,path.join(target,'builds',entry.name),copyOptions);}
    finally {fs.closeSync(fd);fs.unlinkSync(lock);}
  }
  for(const file of ['AGENTS.md','KNOWLEDGE.md','poe.ps1','poe-db/README.md'])if(fs.existsSync(path.join(projectRoot,file)))fs.copyFileSync(path.join(projectRoot,file),path.join(target,file));
  for(const source of readJson(path.join(dbRoot,'cache/manifest.json')).sources) {
    const output=path.join(target,'poe-db',source.file);
    fs.mkdirSync(path.dirname(output),{recursive:true});
    if(!fs.existsSync(output))fs.copyFileSync(path.join(dbRoot,source.file),output,fs.constants.COPYFILE_EXCL);
  }
  atomicJson(path.join(target, 'manifest.json'), { at: new Date().toISOString(), files: copied, includes_builds: true,
    restoration: 'Open this backup as a separate project copy and run doctor --deep before replacing the working project. Includes source caches, required PoB runtime and npm dependencies; calculations are recomputed if their cache was not copied.' });
  return { directory: target, database_files: 4, hashes: copied };
}
