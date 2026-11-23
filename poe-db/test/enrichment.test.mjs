import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {dbRoot,hashFile,readJson} from '../scripts/workspace.mjs';
import {referenceDb,importPrices,priceQuery,importCraftPlan} from '../scripts/reference-store.mjs';
import {normalizeOverview} from '../scripts/fetch-economy.mjs';
import {runPob,decodeBuild,inspectBuild,compareResults} from '../scripts/pob.mjs';
import {cachedSource} from '../scripts/source-cache.mjs';

test('price lookup uses the latest complete category snapshot, explicit variants and timezone-aware ordering',()=>{
  const db=referenceDb(':memory:');
  try {
    const context={game:'poe1',patch:'3.30',mode:'softcore',league:'Covens of Umbra',platform:'pc',category:'UniqueAccessory',source_url:'local:regression'};
    importPrices({...context,observed_at:'2026-11-20T23:00:00Z',lines:[{name:'Removed item',chaosValue:5},{name:'Test belt',chaosValue:10,variant:'A'}]},db);
    importPrices({...context,observed_at:'2026-11-21T00:00:00+03:00',lines:[{name:'Test belt',chaosValue:1,variant:'A'}]},db);
    importPrices({...context,observed_at:'2026-11-21T01:00:00Z',lines:[{name:'Test belt',chaosValue:20,variant:'A',corrupted:false},{name:'Test belt',chaosValue:30,variant:'B',corrupted:true}]},db);
    const latest=priceQuery('get','Test belt',db);
    assert.equal(latest.total_matches,2);
    assert.equal(latest.variant_selection_required,true);
    assert.equal(latest.results[0].chaos,20);
    assert.equal(priceQuery('get','Removed item',db).results.length,0);
    assert.equal(priceQuery('get','Removed item',db,{history:true}).results.length,1);
    assert.equal(priceQuery('get','Test belt',db,{filters:{variant:'B',corrupted:true}}).results[0].chaos,30);
    assert.throws(()=>priceQuery('get','Test belt',db,{filters:{corrupted:'false'}}));
  }finally{db.close();}
});

test('conflicting currency estimates are preserved and surfaced, not reconciled silently',()=>{
  const db=referenceDb(':memory:');
  try {
    const context={game:'poe1',patch:'3.30',mode:'softcore',league:'Covens of Umbra',platform:'pc',observed_at:'2026-11-21T00:00:00Z',source_url:'local:rate-regression'};
    importPrices({...context,category:'Currency',lines:[{name:'Divine Orb',chaosValue:100}]},db);
    importPrices({...context,category:'UniqueAccessory',lines:[{name:'Test item',chaosValue:2000,divineValue:10,count:1}]},db);
    importPrices({...context,observed_at:'2026-11-22T00:00:00Z',category:'Currency',lines:[{name:'Divine Orb',chaosValue:200}]},db);
    const row=priceQuery('get','Test item',db).results[0];
    assert.equal(row.chaos,2000);assert.equal(row.variant.divineValue,10);
    assert.equal(row.quote_warning.code,'inconsistent_currency_conversion');assert.ok(row.sample_warning);
    assert.equal(row.quote_warning.currency_feed_chaos_per_divine,100);
    assert.equal(row.currency_comparison.observed_at,context.observed_at);
  }finally{db.close();}
});

test('economy normalization preserves zero and excludes unknown prices without inventing values',()=>{
  const source={url:'https://poe.ninja/poe1/api/economy/stash/current/currency/overview?league=Covens&type=Currency',sha256:'a'.repeat(64),obtained_at:'2026-11-21T00:00:00Z',http_date:null};
  const result=normalizeOverview({lines:[{currencyTypeName:'Free sample',chaosEquivalent:0},{currencyTypeName:'Unknown',chaosEquivalent:null}]},{category:'Currency',source,leagueId:'Covens'});
  assert.equal(result.snapshot.lines[0].chaosValue,0);assert.equal(result.excluded.length,1);
  assert.equal(result.snapshot.api_league_id,'Covens');
  assert.throws(()=>normalizeOverview({lines:[]},{category:'Currency',source,leagueId:'Standard'}));
});

test('cached research sources are readable offline and private ninja APIs cannot be collected',async()=>{
  const source=readJson(path.join(dbRoot,'reports/economy-summary.json')).sources[0];
  const before=hashFile(path.resolve(dbRoot,source.file));
  const result=await cachedSource(source.url,{offline:true});
  assert.equal(result.metadata.sha256,source.sha256);assert.equal(hashFile(path.resolve(dbRoot,source.file)),before);
  await assert.rejects(()=>cachedSource('https://poe.ninja/poe1/api/builds/anything',{offline:true}),/Only documented/);
});

test('conditional bench plans verify recipe action and base class, not just identifiers',()=>{
  const db=referenceDb(':memory:');
  try {
    const plan=readJson(path.join(dbRoot,'references/crafting/bench-movement-speed-330.json'));
    importCraftPlan(plan,db);
    const value=JSON.parse(db.prepare('SELECT payload_json FROM craft_plans WHERE id=?').get(plan.id).payload_json);
    assert.equal(value.source_recipe.item_class,'Boots');assert.equal(value.simulated_locally,false);
    assert.throws(()=>importCraftPlan({...plan,id:'wrong-base',base_id:'Metadata/Items/Amulets/Amulet3'},db),/item class/);
    assert.throws(()=>importCraftPlan({...plan,id:'wrong-action',target_mod_ids:['Strength1']},db),/do not match/);
  }finally{db.close();}
});

test('explicit migration preserves all ten real tree specs and rejects ordinary calculation of the original',{timeout:60000},()=>{
  const directory=path.join(dbRoot,'references/originals');
  const file=path.join(directory,fs.readdirSync(directory).find(name=>name.startsWith('tornado-shads-balormage-archive-')));
  const before=hashFile(file),input=fs.readFileSync(file);
  assert.equal(inspectBuild(input).tree_specs.length,10);
  assert.throws(()=>runPob({input}),/standard 3_30/);
  const converted=runPob({input,migrate:true,changes:{selection:{tree_spec:9,item_set:4,skill_set:2,character_level:95,main_socket_group:2}}});
  assert.equal(converted.migration.trees.length,10);
  assert.ok(converted.migration.trees.every(tree=>tree.after_version==='3_30'));
  assert.equal(converted.selection.tree_spec,9);assert.equal(converted.level,95);
  assert.equal(hashFile(file),before);
  assert.ok(converted.engine.timeless_types.includes('GloriousVanity'));
});

test('protected PoB engine errors are fatal and comparison rejects incompatible adapter/data contracts',{timeout:30000},()=>{
  const input=fs.readFileSync(path.join(dbRoot,'fixtures/fireball-control.xml'),'utf8');
  const invalid=input.replace('classId="0"','classId="999"');
  assert.throws(()=>runPob({input:invalid}),/PoB engine error/);
  const valid=runPob({input});
  assert.throws(()=>compareResults(valid,{...valid,calculation_contract_sha256:'different'}),/contract/);
  const fakeMinionBefore={...valid,minion_output:{CombinedDPS:100}},fakeMinionAfter={...valid,minion_output:{CombinedDPS:120}};
  assert.equal(compareResults(fakeMinionBefore,fakeMinionAfter).differences.find(r=>r.stat==='minion.CombinedDPS').delta,20);
});
