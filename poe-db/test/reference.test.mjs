import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {dbRoot} from '../scripts/workspace.mjs';
import {referenceDb,importPrices,priceQuery,importExample,exampleQuery,importCraftPlan} from '../scripts/reference-store.mjs';

test('price imports preserve zero, variants and timestamps and reject wrong league',()=>{
  const db=referenceDb(':memory:');
  try {
    const snapshot={game:'poe1',patch:'3.30',mode:'softcore',league:'Covens of Umbra',platform:'pc',category:'UniqueAccessory',observed_at:'2026-11-20T00:00:00Z',source_url:'local:test-only',
      lines:[{name:'Test item',chaosValue:0,variant:'A',corrupted:false},{name:'Test item',chaosValue:10,variant:'B',corrupted:true}]};
    assert.throws(()=>importPrices({...snapshot,league:'Standard'},db),/Covens/);
    assert.throws(()=>importPrices({...snapshot,lines:[{name:'Unknown',chaosValue:null}]},db),/numeric/);
    const stored=importPrices(snapshot,db);
    const found=priceQuery('get','Test item',db).results;
    assert.equal(found.length,2);
    assert.equal(found[0].chaos,0);
    assert.equal(found[0].variant.corrupted,false);
    assert.equal(found[1].variant.corrupted,true);
    assert.ok(found.every(x=>x.snapshot_id===stored.snapshot_id&&x.age_hours>0));
    assert.equal(priceQuery('get','Test item',db,{platform:'xbox'}).results.length,0);
    assert.throws(()=>importPrices(snapshot,db));
  } finally {db.close();}
});

test('reference library keeps synthetic and historical records distinct',()=>{
  const db=referenceDb(':memory:');
  try {
    const descriptor={id:'control',title:'Control only',kind:'synthetic',file:path.join(dbRoot,'fixtures/fireball-control.xml'),source_url:'local:fixture',lessons:['Check requirements'],mechanics:['resource-sustain']};
    const result=importExample(descriptor,db);
    assert.equal(result.tree_version,'3_30');
    const found=exampleQuery('get','control',db).results[0];
    assert.equal(found.kind,'synthetic');
    assert.equal(found.independently_playtested,false);
    assert.equal(found.audit.saved_stats_are_recomputed,false);
    assert.throws(()=>importExample({...descriptor,id:'../bad'},db));
    assert.throws(()=>importCraftPlan({id:'bad'},db),/requires/);
  } finally {db.close();}
});
