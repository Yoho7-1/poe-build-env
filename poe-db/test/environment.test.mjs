import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { dbRoot, readJson } from '../scripts/workspace.mjs';
import { compactQuery } from '../scripts/compact-query.mjs';
import { queryCatalog } from '../scripts/query.mjs';
import { createBuild, loadBuild, updateBuild, appendBuildEvent } from '../scripts/build-store.mjs';
import { queryMechanics } from '../scripts/mechanics.mjs';
import { decodeBuild, inspectBuild, runPob, compareResults } from '../scripts/pob.mjs';

const fixture=fs.readFileSync(path.join(dbRoot,'fixtures/fireball-control.xml'),'utf8');

test('compact queries reduce payload while retaining units, conditions and numeric ranges',()=>{
  const args=['knowledge','gem','Fireball','--level','20'];
  const full=queryCatalog(args),brief=compactQuery(args);
  assert.ok(JSON.stringify(brief).length<JSON.stringify(full).length*0.7);
  assert.deepEqual(brief.results[0].level_data.stats,full.results[0].level_data.stats);
  assert.equal(brief.results[0].quality.applied,false);
  assert.ok(compactQuery([...args,'--fields','level_data']).results[0].units);
  const stat=compactQuery(['stat','base_spell_suppression_chance_%','--min','24']);
  assert.ok(stat.results.every(r=>r.min_value>=24&&r.is_random===0&&r.source.url));
  const unique=compactQuery(['item',"Watcher's Eye"]);
  assert.equal(unique.results[0].effects.explicit_fixed,queryCatalog(['item',"Watcher's Eye"]).results[0].effects.explicit_fixed);
  assert.equal(unique.results[0].random_pool.present,true);
  assert.equal(unique.results[0].random_pool.omitted,true);
  assert.ok(unique.results[0].acquisition_text);
  assert.throws(()=>compactQuery([...args,'--fields','invented']));
});

test('build state persists unknown preferences, enforces revisions and rejects path traversal',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'poe-state-'));
  try {
    const initial=createBuild('sample','Test',directory);
    assert.equal(initial.profile.trade_mode,null);
    assert.equal(loadBuild('sample',directory).revision,1);
    assert.throws(()=>createBuild('sample','Overwrite',directory));
    assert.throws(()=>createBuild('../escape','bad',directory));
    assert.throws(()=>createBuild('con','bad',directory));
    const updated=updateBuild('sample',1,{profile:{trade_mode:'ssf'}},directory);
    assert.equal(updated.profile.budget,null);
    assert.equal(updated.profile.trade_mode,'ssf');
    assert.throws(()=>updateBuild('sample',1,{name:'lost-update'},directory),/Revision conflict/);
    assert.equal(loadBuild('sample',directory).name,'Test');
    assert.throws(()=>updateBuild('sample',2,{profile:{budget:{amount:-10,currency:'divine'}}},directory));
    assert.throws(()=>updateBuild('sample',2,{patch:'3.29'},directory));
    const decision=appendBuildEvent('sample',2,'decisions',{statement:'Test hypothesis',reason:'Evidence pending',evidence:[],status:'deferred'},directory);
    assert.equal(decision.revision,3);
    assert.equal(loadBuild('sample',directory).decisions[0].status,'deferred');
    assert.equal(fs.readdirSync(path.join(directory,'sample/history')).length,3);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('poe-state-'));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('mechanic retrieval gives versioned rules, separate caveats and source provenance',()=>{
  assert.equal(queryMechanics('search','броня').results[0].id,'armour');
  const rule=queryMechanics('get','increased-more',{related:true}).results[0];
  assert.equal(rule.patch,'3.30');
  assert.ok(rule.sources.every(s=>s.sha256.length===64));
  assert.ok(rule.conditions.length&&rule.pitfalls.length&&rule.related.length);
  assert.equal(queryMechanics('get','absent').count,0);
  assert.equal(queryMechanics('search',"' OR 1=1 --").results.length,0);
});

test('PoB import handles compressed codes and rejects unsafe XML and wrong version',()=>{
  const code=deflateSync(fixture).toString('base64url');
  assert.equal(decodeBuild(code).xml,fixture.trim());
  const inspection=inspectBuild(code);
  assert.equal(inspection.tree_version,'3_30');
  assert.equal(inspection.skills[0].gems[0].name,'Fireball');
  assert.equal(inspection.saved_stats_are_recomputed,false);
  assert.throws(()=>decodeBuild('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///secret">]><PathOfBuilding><Build/></PathOfBuilding>'),/DTD/);
  assert.throws(()=>decodeBuild('<PathOfBuilding><Build></PathOfBuilding>'),/Invalid/);
  assert.throws(()=>runPob({input:fixture.replaceAll('3_30','3_29')}),/standard 3_30/);
  assert.throws(()=>runPob({input:fixture.replaceAll('3_30','3_30_ruthless')}),/standard 3_30/);
});

test('pinned PoB independently recalculates controls, reports requirements, and distinguishes incompatible supports',{timeout:60000},()=>{
  const expected=readJson(path.join(dbRoot,'fixtures/fireball-control.expected.json'));
  const base=runPob({input:fixture});
  for(const [key,value]of Object.entries(expected.expected))assert.ok(Math.abs(base.output[key]-value)<=Math.max(1,Math.abs(value))*expected.relative_tolerance,key);
  assert.ok(base.engine_warnings.some(x=>x.includes('Intelligence')));
  const inc=runPob({input:fixture,changes:{custom_mods:'100% increased Fire Damage'}});
  assert.ok(Math.abs(inc.output.AverageDamage/base.output.AverageDamage-2)<0.000001);
  assert.ok(compareResults(base,inc).differences.some(x=>x.stat==='AverageDamage'&&x.percent>99.99));
  const incompatible=runPob({input:fixture,changes:{add_support:'Melee Physical Damage'}});
  assert.equal(incompatible.applied_supports.length,0);
  assert.equal(incompatible.output.AverageDamage,base.output.AverageDamage);
  const support=runPob({input:fixture,changes:{add_support:'Controlled Destruction'}});
  assert.ok(support.applied_supports.some(x=>x.id==='SupportControlledDestruction'));
  assert.ok(support.output.AverageDamage>base.output.AverageDamage);
  const armour=runPob({input:fixture,changes:{replace_items:[{slot:'Body Armour',text:'Rarity: RARE\nTest Robe\nSimple Robe\nImplicits: 0\n+100 to maximum Life'}]}});
  assert.equal(armour.output.Life,base.output.Life+100);
  const cached=runPob({input:fixture});
  assert.equal(cached.cache_hit,true);
  assert.equal(cached.calculation_id,base.calculation_id);
  assert.throws(()=>compareResults(base,{...inc,scenario:'burst'}),/same engine/);
  assert.throws(()=>runPob({input:fixture,changes:{config:{notARealOption:true}}}),/Unknown configuration option/);
});

test('bootstrap is portable and contains no invented user choices',()=>{
  const child=spawnSync(process.execPath,[path.join(dbRoot,'scripts/agent.mjs'),'bootstrap'],{cwd:os.tmpdir(),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(child.stdout);
  assert.equal(result.network_required,false);
  assert.equal(result.build.profile.trade_mode,null);
  assert.equal(result.build.design.main_skill,null);
  assert.ok(JSON.stringify(result).length<6500);
});
