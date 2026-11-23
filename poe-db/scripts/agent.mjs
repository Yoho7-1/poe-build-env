import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbRoot, projectRoot, readJson, atomicJson, flags } from './workspace.mjs';
import { compactQuery } from './compact-query.mjs';
import { bootstrap, doctor, backup } from './environment.mjs';
import { queryMechanics, buildMechanics } from './mechanics.mjs';
import { loadBuild, createBuild, updateBuild, appendBuildEvent, briefBuild } from './build-store.mjs';
import { inspectBuild, runPob, compareResults, scenarios, decodeBuild } from './pob.mjs';
import { pobBuildCommand, pobHelp } from './pob-cli.mjs';
import { analyze, evaluate, analysisHelp } from './analysis-cli.mjs';
import { referenceDb,importExample,exampleQuery,importPrices,priceQuery,importCraftPlan,craftQuery } from './reference-store.mjs';
import { dataCommands, dataCommand, dataHelp } from './data-cli.mjs';
import { cli as craftSim } from '../experiments/craft-lab/v2/cli.mjs';

export function agent(args) {
  const [command,...rest] = args;
  if(command==='query') return compactQuery(rest);
  if(command==='bootstrap') return bootstrap(rest[0] ?? 'main');
  if(command==='analyze') return analyze(rest);
  if(command==='eval') return evaluate(rest);
  if(dataCommands.has(command)) return dataCommand(command,rest);
  if(command==='doctor') {
    const { options }=flags(rest,['report'],['deep']);
    const result=doctor({deep:!!options.deep});
    if(options.report)atomicJson(path.resolve(options.report),result);
    return result;
  }
  if(command==='backup')return backup(rest[0] ?? 'manual');
  if(command==='craftsim')return craftSim(rest.length?rest:['help']);
  if(['example','price','craft'].includes(command)) {
    const {positional,options}=flags(rest,['file','platform','limit','variant','links','gem-level','gem-quality','base-type','corrupted'],['history']);
    const [operation='list',...query]=positional;
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
    const {positional,options}=flags(rest,['limit'],['related']);
    if(positional[0]==='build')return buildMechanics();
    return queryMechanics(positional[0] ?? 'list',positional.slice(1).join(' '),{limit:options.limit==null?5:Number(options.limit),related:!!options.related});
  }
  if(command==='build') {
    const {positional,options}=flags(rest,['file','expected-revision','name','scenario','changes'],['full']);
    const [operation,id='main']=positional;
    if(operation==='init')return briefBuild(createBuild(id,options.name ?? id));
    if(operation==='show') { const state=loadBuild(id); return options.full?state:briefBuild(state); }
    if(operation==='calculate') {
      if(!options.file||options['expected-revision']==null)throw new Error('--file and --expected-revision required');
      const state=loadBuild(id);
      if(state.revision!==Number(options['expected-revision']))throw new Error('Revision conflict; reload state before calculating');
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
    const {positional,options}=flags(rest,['scenario','changes','out','save-xml','class','ascendancy','bloodline','level','code','save-code'],['full','raw']);
    const [operation,file]=positional;
    if(operation==='scenarios')return scenarios;
    if(['new','export-code','import-code'].includes(operation)) {
      const result=pobBuildCommand(operation,file,options);
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
    throw new Error('Use pob inspect/run/new/export-code/import-code/migrate/control/compare/scenarios');
  }
  if(command==='help'||command==null)return {root:projectRoot,network_required:false,commands:{
    'bootstrap [build-id]':'Small starting context and current build state',
    'doctor [--deep] [--report file.json]':'Offline environment, snapshot and provenance checks',
    'backup [label]':'Consistent local SQLite snapshots, build state and knowledge cards',
    'query <existing query syntax> [--view brief|full] [--fields a,b]':'Compact data interface; search defaults to five results',
    'mechanic list|search <text>|get <id> [--related]':'Versioned explanations with source links and conditions',
    'build init <id> --name <name>':'Create without overwriting',
    'build show [id] [--full]':'Durable state across sessions',
    'build update|decision|calculation <id> --file file.json --expected-revision N':'Validated changes with revision conflict protection',
    'build calculate <id> --file build.xml --expected-revision N [--scenario sustained] [--changes file.json]':'Run and record a calculation together with an immutable input copy',
    'pob inspect <file.xml|file.code>':'Audit imported configuration; saved PlayerStat values are not recalculated',
    'pob run <file> [--scenario imported|sustained|burst|unbuffed] [--changes file.json] [--out file.json] [--save-xml file.xml]':'Calculate through the pinned local engine',
    'pob migrate <old-file> --save-xml <new-file> [--out report.json]':'Explicit native conversion of standard 3_28/3_29 trees to 3_30; original retained, node changes reported',
    'pob compare <before.json> <after.json>':'Compare equal baselines/scenarios/calculation contracts',
    'pob control':'Synthetic Fireball control, not a playable recommendation',
    ...pobHelp,
    ...analysisHelp,
    ...dataHelp
    ,'example list|get <id>|import --file descriptor.json':'Audited reference/synthetic/historical PoB library'
    ,'price list|get <exact name>|import --file snapshot.json':'Offline dated price observations; --variant, --corrupted true|false, --links, --gem-level, --gem-quality, --base-type, --history; platform pc by default'
    ,'craft list|get <id>|import --file plan.json':'Recorded craft plans; identifiers are checked, probabilities are not simulated (simulate with craftsim)'
    ,'craftsim help|status|coverage|rules|tiers|pool|new|step|preview|replay|export|train ...':'3.30 crafting simulator (craft-lab v2): step-by-step crafts, Monte Carlo policies, rule ids and confidence per step; model, not a game test'
  }};
  throw new Error(`Unknown command: ${command}`);
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const result=agent(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.ready===false)process.exitCode=1;
  } catch(error) {process.stderr.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;}
}
