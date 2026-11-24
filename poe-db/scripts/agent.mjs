import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { projectRoot, readJson, atomicJson, flags } from './workspace.mjs';
// Static: fetch-economy.mjs (imported by price-refresh) has top-level await, which require(esm) cannot load.
import { priceCommand, priceHelp, priceOperations } from './price-refresh.mjs';

// Command modules load on first use (synchronous require of ES modules, Node 22.12+), so a call pays only for the
// modules of its own command group instead of the whole tool (~0.5 s per process; analysis batches start one
// process per calculation). agent() stays synchronous. A lazily loaded module must not use top-level await.
const require = createRequire(import.meta.url);
const lazy = file => { let m; return () => (m ??= require(file)); };
const mod = {
  query: lazy('./compact-query.mjs'), environment: lazy('./environment.mjs'), mechanics: lazy('./mechanics.mjs'),
  store: lazy('./build-store.mjs'), pob: lazy('./pob.mjs'), pobPool: lazy('./pob-pool.mjs'), pobCli: lazy('./pob-cli.mjs'), analysis: lazy('./analysis-cli.mjs'),
  reference: lazy('./reference-store.mjs'), data: lazy('./data-cli.mjs'), craftSim: lazy('../experiments/craft-lab/v2/cli.mjs'),
  item: lazy('./item-builder.mjs'), appraise: lazy('./item-appraise.mjs'), observe: lazy('./observations.mjs'), lab: lazy('./lab.mjs'),
  bench: lazy('./lab-bench.mjs'), card: lazy('./build-card.mjs'), corpus: lazy('./corpus.mjs'), learn: lazy('./corpus-learn.mjs'),
  discover: lazy('./corpus-discover.mjs'), novelty: lazy('./novelty.mjs'), norms: lazy('./corpus-norms.mjs'), design: lazy('./design-generate.mjs'),
  taxonomy: lazy('./mechanic-taxonomy.mjs'), principles: lazy('./corpus-principles.mjs')
};
export const lazyModules = mod;

// `agent.mjs <group> [operation] --help` (or `-h`): the help entries of that group, narrowed to the operation if given.
export function groupHelp(command, rest) {
  const all = agent(['help', '--full']).commands;
  const op = rest.find(x => !x.startsWith('-') && x !== 'help');
  const group = Object.fromEntries(Object.entries(all).filter(([k]) => k === command || k.startsWith(`${command} `) || k.split('|').some(p => p.trim().startsWith(`${command} `))));
  if (!Object.keys(group).length) throw new Error(`Unknown command: ${command}; run agent.mjs help`);
  const narrowed = op ? Object.fromEntries(Object.entries(group).filter(([k]) => new RegExp(`(^|[ |])${op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([ |]|$)`).test(k.slice(command.length)))) : {};
  return { command, operation: op ?? null, commands: Object.keys(narrowed).length ? narrowed : group };
}
// Machine-readable error class for the CLI wrapper; the message stays the human explanation.
export function errorCode(message) {
  if (/Revision conflict|locked/i.test(message)) return 'conflict';
  if (/ needs |exceeds the supporting evidence|requires --reason|cannot change after|Only observation evidence/i.test(message)) return 'gate';
  if (/not found|does not exist|ENOENT/i.test(message)) return 'not_found';
  if (/^Unknown (command|option)|^Use |required|must be|Missing value|^--/i.test(message)) return 'usage';
  if (/Change error|Calculation requires|engine/i.test(message)) return 'engine';
  return 'error';
}

// Default help is a compact index (group -> operations); the full entry list is `help --full` or `<group> --help`.
export function helpIndex(full, commands) {
  if (full) return { root: projectRoot, network_required: false, commands };
  const groups = {};
  for (const key of Object.keys(commands)) {
    let bare = key;
    while (/\[[^\[\]]*\]|<[^<>]*>/.test(bare)) bare = bare.replace(/\[[^\[\]]*\]|<[^<>]*>/g, ' ');
    const group = bare.trim().split(/\s+/)[0];
    if (!/^[a-z][a-z-]*$/.test(group)) continue;
    const ops = (groups[group] ??= new Set());
    let flagValues = false; // "--type a|b|c": the alternatives after a flag are its values, not operations
    for (const part of bare.split('|')) {
      const raw = part.trim().split(/\s+/);
      const words = raw.filter(w => /^[a-z][a-z-]*$/.test(w));
      if (raw[0] === group) { if (words[1]) ops.add(words[1]); }
      else if (!flagValues && raw.length === 1 && words[0]) ops.add(words[0]);
      flagValues = raw.length > 1 ? raw[raw.length - 2].startsWith('--') : flagValues;
    }
  }
  return { network_required: false, usage: 'agent.mjs <group> [operation] --help for options; agent.mjs help --full for every entry',
    groups: Object.fromEntries(Object.entries(groups).map(([g, ops]) => [g, [...ops].join(' ')])) };
}

export function agent(args) {
  const [command,...rest] = args;
  if(command&&command!=='help'&&command!=='craftsim'&&(rest.includes('--help')||rest.includes('-h')))return groupHelp(command,rest.filter(x=>x!=='--help'&&x!=='-h'));
  if(command==='query') return mod.query().compactQuery(rest);
  if(command==='bootstrap') return mod.environment().bootstrap(rest[0] ?? 'main');
  if(command==='analyze') return mod.analysis().analyze(rest);
  if(command==='eval') return mod.analysis().evaluate(rest);
  if(mod.data().dataCommands.has(command)) return mod.data().dataCommand(command,rest);
  if(command==='item'&&rest[0]==='appraise') return mod.appraise().appraiseCommand(rest.slice(1));
  if(command==='item') return mod.item().itemCommand(rest);
  if(command==='observe') return mod.observe().observeCommand(rest);
  if(command==='corpus'&&['ablate-all','learn','insights'].includes(rest[0])) return mod.learn().learnCommand(rest);
  if(command==='corpus'&&rest[0]==='discover') return mod.discover().discoverCommand(rest);
  if(command==='corpus'&&rest[0]==='novelty') return mod.novelty().noveltyCommand(rest);
  if(command==='corpus'&&rest[0]==='norms') return mod.norms().normsCommand(rest);
  if(command==='corpus'&&rest[0]==='principles') return mod.principles().principlesCommand(rest);
  if(command==='corpus') return mod.corpus().corpusCommand(rest);
  if(command==='lab'&&rest[0]==='bench') return mod.bench().benchCommand(rest.slice(1));
  if(command==='lab') return mod.lab().labCommand(rest);
  if(command==='design') return mod.design().designCommand(rest);
  // price status|refresh (freshness, network refresh) live in price-refresh.mjs; list|get|import stay below.
  if(command==='price'&&priceOperations.has(rest[0])) return priceCommand(rest);
  if(command==='doctor') {
    const { options }=flags(rest,['report'],['deep']);
    const result=mod.environment().doctor({deep:!!options.deep});
    if(options.report)atomicJson(path.resolve(options.report),result);
    return result;
  }
  if(command==='backup')return mod.environment().backup(rest[0] ?? 'manual');
  if(command==='craftsim')return mod.craftSim().cli(rest.length?rest:['help']);
  if(['example','price','craft'].includes(command)) {
    const {positional,options}=flags(rest,['file','platform','limit','variant','links','gem-level','gem-quality','base-type','corrupted'],['history']);
    const [operation='list',...query]=positional;
    const {referenceDb,importExample,exampleQuery,importPrices,priceQuery,importCraftPlan,craftQuery}=mod.reference();
    const db=referenceDb(undefined,{readOnly:operation!=='import'});
    try {
      if(operation==='import') {
        if(!options.file)throw new Error('--file descriptor.json required');
        const descriptor=readJson(path.resolve(options.file));
        return command==='example'?importExample(descriptor,db):command==='price'?importPrices(descriptor,db):importCraftPlan(descriptor,db);
      }
      if(!['list','get'].includes(operation))throw new Error('Use list/get/import');
      const priceFilters={};
      for(const [flag,key]of [['variant','variant'],['links','links'],['gem-level','gemLevel'],['gem-quality','gemQuality'],['base-type','baseType'],['corrupted','corrupted']]) {
        if(options[flag]===undefined)continue;
        if(flag==='corrupted'&&!['true','false'].includes(options[flag]))throw new Error('corrupted must be true or false');
        priceFilters[key]=flag==='corrupted'?options[flag]==='true':['links','gem-level','gem-quality'].includes(flag)?Number(options[flag]):options[flag];
      }
      return command==='example'?exampleQuery(operation,query.join(' '),db):command==='price'?priceQuery(operation,query.join(' '),db,{platform:options.platform??'pc',limit:Number(options.limit??5),history:!!options.history,filters:priceFilters}):craftQuery(operation,query.join(' '),db);
    } finally {db.close();}
  }
  if(command==='mechanic') {
    const {queryMechanics,buildMechanics,mechanicGaps,mechanicValidate}=mod.mechanics();
    if(rest[0]==='taxonomy') return mod.taxonomy().taxonomyCommand(rest);
    if(rest[0]==='gaps'){const o=flags(rest.slice(1),['status','axis'],['full']);return mechanicGaps(o.positional[0]??null,{status:o.options.status??null,axis:o.options.axis??null,full:!!o.options.full});}
    if(rest[0]==='validate'){const o=flags(rest.slice(1),['scenario','rules','out'],['run']);return mechanicValidate(o.positional[0],{run:!!o.options.run,scenario:o.options.scenario??'sustained',rules:o.options.rules?o.options.rules.split(','):null,out:o.options.out??null});}
    const {positional,options}=flags(rest,['limit'],['related']);
    if(positional[0]==='build')return buildMechanics();
    return queryMechanics(positional[0] ?? 'list',positional.slice(1).join(' '),{limit:options.limit==null?5:Number(options.limit),related:!!options.related});
  }
  if(command==='build'&&rest[0]==='card') return mod.card().cardCommand(rest.slice(1));
  if(command==='build') {
    const {positional,options}=flags(rest,['file','expected-revision','name','scenario','changes'],['full']);
    const [operation,id='main']=positional;
    const {loadBuild,createBuild,updateBuild,appendBuildEvent,briefBuild}=mod.store();
    if(operation==='init')return briefBuild(createBuild(id,options.name ?? id));
    if(operation==='show') { const state=loadBuild(id); return options.full?state:briefBuild(state); }
    if(operation==='calculate') {
      if(!options.file||options['expected-revision']==null)throw new Error('--file and --expected-revision required');
      const state=loadBuild(id);
      if(state.revision!==Number(options['expected-revision']))throw new Error('Revision conflict; reload state before calculating');
      const {decodeBuild,runPob}=mod.pob();
      const input=decodeBuild(fs.readFileSync(path.resolve(options.file))).xml;
      const result=runPob({input,scenario:options.scenario??'sustained',changes:options.changes?readJson(path.resolve(options.changes)):{}});
      const folder=path.join(projectRoot,'builds',state.id);
      const inputFile=path.join(folder,'inputs',`${result.input_sha256}.xml`);
      fs.mkdirSync(path.dirname(inputFile),{recursive:true});
      if(!fs.existsSync(inputFile))fs.writeFileSync(inputFile,input,{flag:'wx'});
      const resultFile=path.join(folder,'calculations',`${result.calculation_id}.json`);
      atomicJson(resultFile,result);
      const next=appendBuildEvent(id,state.revision,'calculations',{result_file:path.relative(projectRoot,resultFile).replaceAll('\\','/'),
        input_file:path.relative(projectRoot,inputFile).replaceAll('\\','/'),input_sha256:result.input_sha256,scenario:result.scenario,calculation_id:result.calculation_id,engine:result.engine});
      return {build:briefBuild(next),calculation:result};
    }
    if(!['update','decision','calculation'].includes(operation))throw new Error('Use build init/show/update/decision/calculation');
    if(!options.file||options['expected-revision']==null)throw new Error('--file and --expected-revision are required for changes');
    const data=readJson(path.resolve(options.file));
    const expected=Number(options['expected-revision']);
    const updated=operation==='update'?updateBuild(id,expected,data):appendBuildEvent(id,expected,operation==='decision'?'decisions':'calculations',data);
    return briefBuild(updated);
  }
  if(command==='pob') {
    const {positional,options}=flags(rest,['scenario','changes','out','save-xml','class','ascendancy','bloodline','level','code','save-code'],['full','raw','stop']);
    const [operation,file]=positional;
    const {inspectBuild,runPob,compareResults,scenarios}=mod.pob();
    if(operation==='scenarios')return scenarios;
    // Persistent PoB hosts (pob-pool.mjs): list them, or ask them to exit once idle.
    if(operation==='hosts')return options.stop?{stopped:true,hosts:mod.pobPool().stopHosts({wait:15000})}:{enabled:mod.pobPool().persistentEnabled(),max_hosts:mod.pobPool().maxHosts(),hosts:mod.pobPool().listHosts().map(({name,pid,state})=>({name,pid,state}))};
    if(['new','export-code','import-code'].includes(operation)) {
      const result=mod.pobCli().pobBuildCommand(operation,file,options);
      if(options.out)atomicJson(path.resolve(options.out),result);
      return result;
    }
    if(operation==='inspect') { if(!file)throw new Error('Local XML/code file required');return inspectBuild(fs.readFileSync(path.resolve(file))); }
    if(['run','control','migrate'].includes(operation)) {
      if(operation!=='control'&&!file)throw new Error('Local XML/code file required');
      if(operation==='migrate'&&!options['save-xml'])throw new Error('Explicit migration requires --save-xml <new-file>; the original is retained');
      const result=runPob({input:operation==='control'?null:fs.readFileSync(path.resolve(file)),scenario:options.scenario ?? 'imported',
        changes:options.changes?readJson(path.resolve(options.changes)):{},saveXml:options['save-xml']?path.resolve(options['save-xml']):null,full:!!options.full,migrate:operation==='migrate'});
      if(options.out)atomicJson(path.resolve(options.out),result);
      return result;
    }
    if(operation==='compare') {
      if(!file||!positional[2])throw new Error('Two calculation JSON files required');
      return compareResults(readJson(path.resolve(file)),readJson(path.resolve(positional[2])));
    }
    throw new Error('Use pob inspect/run/new/export-code/import-code/migrate/control/compare/scenarios/hosts');
  }
  if(command==='--help'||command==='-h')return agent(['help',...rest]);
  if(command==='help'||command==null)return helpIndex(rest.includes('--full'),{
    'bootstrap [build-id]':'Small starting context and current build state',
    'doctor [--deep] [--report file.json]':'Offline environment, snapshot and provenance checks',
    'backup [label]':'Consistent local SQLite snapshots, build state and knowledge cards',
    'query <existing query syntax> [--view brief|full] [--fields a,b]':'Compact data interface; search defaults to five results',
    'mechanic list|search <text>|get <id> [--related]':'Versioned explanations with source links and conditions',
    'mechanic gaps [id] [--status not_modelled|partial|config_assumed] [--axis A] [--full]':'Registry of mechanics PoB does not (fully) calculate: what PoB does, the gap, approximate model, validator rules, danger axes',
    'mechanic validate <prototype.json|build.xml> [--run] [--rules a,b] [--out f.json]':'Executable mechanic preconditions/conflicts (Profane Bloom curse, curse limit, Blasphemy hex, CI life recovery, EB+MoM, corpses, ascendancy budget, config charges); --run adds PoB explode sources/curse limit/recovery',
    'build init <id> --name <name>':'Create without overwriting',
    'build show [id] [--full]':'Durable state across sessions',
    'build update|decision|calculation <id> --file file.json --expected-revision N':'Validated changes with revision conflict protection',
    'build calculate <id> --file build.xml --expected-revision N [--scenario sustained] [--changes file.json]':'Run and record a calculation together with an immutable input copy',
    'pob inspect <file.xml|file.code>':'Audit imported configuration; saved PlayerStat values are not recalculated',
    'pob run <file> [--scenario imported|sustained|burst|unbuffed] [--changes file.json] [--out file.json] [--save-xml file.xml]':'Calculate through the pinned local engine',
    'pob migrate <old-file> --save-xml <new-file> [--out report.json]':'Explicit native conversion of standard 3_28/3_29 trees to 3_30; original retained, node changes reported',
    'pob compare <before.json> <after.json>':'Compare equal baselines/scenarios/calculation contracts',
    'pob control':'Synthetic Fireball control, not a playable recommendation',
    ...mod.pobCli().pobHelp,
    ...mod.analysis().analysisHelp,
    ...mod.data().dataHelp,
    ...mod.item().itemHelp,
    ...mod.appraise().appraiseHelp,
    ...priceHelp,
    ...mod.observe().observeHelp,
    ...mod.lab().labHelp,
    ...mod.bench().benchHelp,
    ...mod.card().cardHelp,
    ...mod.corpus().corpusHelp,
    ...mod.learn().learnHelp,
    ...mod.discover().discoverHelp,
    ...mod.novelty().noveltyHelp,
    ...mod.norms().normsHelp,
    ...mod.taxonomy().taxonomyHelp,
    ...mod.principles().principlesHelp,
    ...mod.design().designHelp
    ,'example list|get <id>|import --file descriptor.json':'Audited reference/synthetic/historical PoB library'
    ,'price list|get <exact name>|import --file snapshot.json':'Offline dated price observations; --variant, --corrupted true|false, --links, --gem-level, --gem-quality, --base-type, --history; platform pc by default'
    ,'craft list|get <id>|import --file plan.json':'Recorded craft plans; identifiers are checked, probabilities are not simulated (simulate with craftsim)'
    ,'craftsim help|status|coverage|rules|tiers|pool|new|step|preview|replay|export|train ...':'3.30 crafting simulator (craft-lab v2): step-by-step crafts, Monte Carlo policies, rule ids and confidence per step; model, not a game test'
  });
  throw new Error(`Unknown command: ${command}`);
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    // Most commands are synchronous; price refresh returns a Promise (network), so the result is awaited.
    const result=await agent(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.ready===false)process.exitCode=1;
  } catch(error) {process.stderr.write(JSON.stringify({error:error.message,code:errorCode(error.message)})+'\n');process.exitCode=1;}
}
