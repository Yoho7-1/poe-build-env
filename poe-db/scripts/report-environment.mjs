import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbRoot,projectRoot,readJson,atomicJson } from './workspace.mjs';
import { queryCatalog } from './query.mjs';
import { compactQuery } from './compact-query.mjs';
import { bootstrap } from './environment.mjs';

const cases=[['knowledge','gem','Fireball','--level','20'],['item','Mageblood'],['item',"Watcher's Eye"],['search','Suppress Spell','--limit','5']].map(args=>{
  const full=JSON.stringify(queryCatalog(args)).length,brief=JSON.stringify(compactQuery(args)).length;
  return {command:args.join(' '),full_characters:full,brief_characters:brief,reduction_percent:Math.round((1-brief/full)*10000)/100};
});
const benchmark={metric:'Compact JSON string length in JavaScript characters, not model tokens.',
  bootstrap_characters:JSON.stringify(bootstrap()).length,agents_file_characters:fs.readFileSync(path.join(projectRoot,'AGENTS.md'),'utf8').length,cases};
atomicJson(path.join(dbRoot,'reports/context-benchmark.json'),benchmark);
const db=new DatabaseSync(path.join(dbRoot,'data/workbench-3.30.sqlite'),{readOnly:true});
let workbench;
try {workbench={examples:db.prepare('SELECT kind,COUNT(*) records FROM examples GROUP BY kind').all(),price_snapshots:db.prepare('SELECT COUNT(*) n FROM price_snapshots').get().n,price_observations:db.prepare('SELECT COUNT(*) n FROM prices').get().n,craft_plans:db.prepare('SELECT COUNT(*) n FROM craft_plans').get().n};}finally{db.close();}
const mechanics=readJson(path.join(dbRoot,'mechanics/cards.json')),sources=readJson(path.join(dbRoot,'mechanics/sources.json'));
const engine=readJson(path.join(dbRoot,'vendor/pob-source.json'));
const status={at:new Date().toISOString(),game:'poe1',patch:'3.30',scope:'Local research and calculation environment; does not certify the entire game or a player build.',
  implemented:['Pinned data/engine, offline diagnostics and backup/restore command','Compact retrieval, explicit field projection and context bootstrap',
    `${mechanics.length} sourced mechanics cards and dependency links`,'PoB XML/code audit, calculation, supports/item/gem/selection changes, scenario comparison and cache',
    'Revision-protected durable build state, decision history and stored calculation inputs','Design/audit/upgrade skills and staged progression method',
    'Dated economy snapshots with variant filters, age and inconsistent currency conversion warnings',
    'Real author archives and explicit native tree migrations; partial imports rejected and old invalid result quarantined',
    'Conditional bench plans with pinned recipe action/base-class verification; no full craft probability simulation'],
  versions:readJson(path.join(dbRoot,'environment.lock.json')).versions,workbench,
  mechanics:{cards:mechanics.length,sources:sources.length},engine:{verified_source_files:engine.files.length,timeless_types:engine.timeless_types??[]},
  remaining:['Complete independent acquisition verification and Foulborn combination rules','More mechanic cards for selected archetypes and independently reviewed in-game cases',
    'Resolve source currency conversion disagreement before combining a build budget; price snapshots require explicit refresh',
    'Actual item crafting projects with eligibility/probability checks and matched market quotes',
    'Independent gameplay validation and progression-stage audits for migrated references; current author uploads not verified',
    'Full recipe catalogs and specialized seed databases when needed','Independent LLM evaluation of evaluations/cases.json; software tests are not a model reasoning score'],
  user_build:'main is intentionally in requirements phase; unprovided preferences remain null.'};
atomicJson(path.join(dbRoot,'reports/environment-progress.json'),status);
console.log(JSON.stringify({benchmark,status},null,2));
