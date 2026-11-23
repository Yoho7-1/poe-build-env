import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dbRoot, readJson, safeId } from './workspace.mjs';
import { inspectBuild, decodeBuild } from './pob.mjs';

export function referenceDb(filename=path.join(dbRoot,'data/workbench-3.30.sqlite'),{readOnly=false}={}) {
  const db=new DatabaseSync(filename,{readOnly});
  if(readOnly)return db;
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS examples(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,tree_version TEXT,source_url TEXT NOT NULL,sha256 TEXT NOT NULL,xml TEXT NOT NULL,audit_json TEXT NOT NULL,notes_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS price_snapshots(id TEXT PRIMARY KEY,league TEXT NOT NULL,platform TEXT NOT NULL,observed_at TEXT NOT NULL,source_url TEXT NOT NULL,category TEXT NOT NULL,payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prices(snapshot_id TEXT REFERENCES price_snapshots(id),ordinal INTEGER,name TEXT NOT NULL,chaos REAL NOT NULL,variant_json TEXT NOT NULL,PRIMARY KEY(snapshot_id,ordinal));
    CREATE INDEX IF NOT EXISTS prices_name ON prices(name);
    CREATE TABLE IF NOT EXISTS craft_plans(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
  `);
  return db;
}
function url(value) {if(typeof value!=='string'||!/^https:\/\//.test(value)&&!/^local:/.test(value))throw new Error('Source must be https:// or local:');return value;}

export function importExample(descriptor,db) {
  safeId(descriptor.id);
  if(!['synthetic','reference','historical'].includes(descriptor.kind)||!descriptor.title||!Array.isArray(descriptor.lessons)||!descriptor.lessons.length)throw new Error('Example needs title, kind and lessons[]');
  const {xml}=decodeBuild(fs.readFileSync(path.resolve(descriptor.file)));
  const audit=inspectBuild(xml);
  if(descriptor.kind==='reference'&&audit.tree_version!=='3_30')throw new Error('Current references require the standard 3_30 tree; classify old builds as historical');
  const sha=createHash('sha256').update(xml).digest('hex');
  const notes={lessons:descriptor.lessons,mechanics:descriptor.mechanics??[],provenance:descriptor.provenance??null,analysis:descriptor.analysis??null,independently_playtested:false,
    validation:'Imported and structurally audited. Stored PlayerStat values are not recalculated; an engine calculation and gameplay validation are separate.'};
  db.prepare('INSERT INTO examples VALUES (?,?,?,?,?,?,?,?,?)').run(descriptor.id,descriptor.title,descriptor.kind,audit.tree_version,url(descriptor.source_url),sha,xml,JSON.stringify(audit),JSON.stringify(notes));
  return {id:descriptor.id,kind:descriptor.kind,tree_version:audit.tree_version,sha256:sha,independently_playtested:false};
}
export function exampleQuery(command,text,db) {
  if(command==='list')return {results:db.prepare("SELECT id,title,kind,tree_version,source_url,json_extract(notes_json,'$.analysis.status') validation_status FROM examples ORDER BY id").all()};
  const row=db.prepare('SELECT id,title,kind,tree_version,source_url,sha256,audit_json,notes_json FROM examples WHERE id=?').get(text);
  if(!row)return {count:0,results:[]};
  const {audit_json,notes_json,...record}=row;
  const audit=JSON.parse(audit_json),{saved_stats,...compactAudit}=audit;
  return {count:1,results:[{...record,audit:compactAudit,...JSON.parse(notes_json)}]};
}
export function refreshExampleAudits(db) {
  for(const row of db.prepare('SELECT id,xml FROM examples').all())db.prepare('UPDATE examples SET audit_json=? WHERE id=?').run(JSON.stringify(inspectBuild(row.xml)),row.id);
}

export function importPrices(snapshot,db) {
  if(snapshot.game!=='poe1'||snapshot.patch!=='3.30'||snapshot.mode!=='softcore'||snapshot.league!=='Covens of Umbra')throw new Error('Price snapshot must explicitly target PoE 1 / 3.30 / Softcore / Covens of Umbra');
  if(!snapshot.platform||!snapshot.category||!snapshot.observed_at||!/(Z|[+-]\d\d:\d\d)$/.test(snapshot.observed_at)||!Number.isFinite(Date.parse(snapshot.observed_at))||Date.parse(snapshot.observed_at)>Date.now()+300000)throw new Error('Platform, category and past timestamp with timezone required');
  url(snapshot.source_url);
  if(!Array.isArray(snapshot.lines)||!snapshot.lines.length)throw new Error('Non-empty lines[] required');
  for(const line of snapshot.lines)if(typeof line.name!=='string'||!line.name||typeof line.chaosValue!=='number'||!Number.isFinite(line.chaosValue)||line.chaosValue<0)throw new Error('Each price needs name and non-negative numeric chaosValue');
  const id=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO price_snapshots VALUES (?,?,?,?,?,?,?)').run(id,snapshot.league,snapshot.platform,snapshot.observed_at,snapshot.source_url,snapshot.category,JSON.stringify(snapshot));
    for(const [index,line]of snapshot.lines.entries()) {
      const variant=priceVariant(line);
      db.prepare('INSERT INTO prices VALUES (?,?,?,?,?)').run(id,index,line.name,line.chaosValue,JSON.stringify(variant));
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {snapshot_id:id,observed_at:snapshot.observed_at,records:snapshot.lines.length,acquisition_verified:false};
}
function priceVariant(line) {
  const variant={};
  for(const key of ['baseType','variant','corrupted','links','gemLevel','gemQuality','divineValue','count','listingCount','detailsId','tradeInfo','mutatedModifiers','itemLevel','levelRequired','influences'])if(line[key]!==undefined)variant[key]=line[key];
  const times=[line.pay?.sample_time_utc,line.receive?.sample_time_utc].filter(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))).sort((a,b)=>Date.parse(b)-Date.parse(a));
  if(times.length)variant.latest_market_sample_at=times[0];
  return variant;
}
export function reindexPriceVariants(db) {
  db.exec('BEGIN');
  try {
    for(const row of db.prepare('SELECT id,payload_json FROM price_snapshots').all())for(const [ordinal,line]of JSON.parse(row.payload_json).lines.entries())db.prepare('UPDATE prices SET variant_json=? WHERE snapshot_id=? AND ordinal=?').run(JSON.stringify(priceVariant(line)),row.id,ordinal);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function priceQuery(command,text,db,{platform='pc',limit=5,history=false,filters={}}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Price limit must be 1–100');
  if(command==='list')return {results:db.prepare('SELECT id,league,platform,observed_at,source_url,category FROM price_snapshots ORDER BY julianday(observed_at) DESC').all()};
  if(!text)throw new Error('Price item name required');
  const conditions=['p.name=? COLLATE NOCASE','s.platform=?'],params=[text,platform];
  if(!history)conditions.push('s.id=(SELECT latest.id FROM price_snapshots latest WHERE latest.platform=s.platform AND latest.league=s.league AND latest.category=s.category ORDER BY julianday(latest.observed_at) DESC,latest.rowid DESC LIMIT 1)');
  for(const [key,value]of Object.entries(filters)) {
    if(!['variant','corrupted','links','gemLevel','gemQuality','baseType'].includes(key))throw new Error(`Unknown price filter ${key}`);
    if(key==='corrupted'&&typeof value!=='boolean')throw new Error('corrupted must be boolean');
    if(['links','gemLevel','gemQuality'].includes(key)&&(!Number.isInteger(value)||value<0))throw new Error(`Invalid numeric price filter ${key}`);
    conditions.push(`json_extract(p.variant_json,'$.${key}')=?`);params.push(typeof value==='boolean'?Number(value):value);
  }
  const from=`FROM prices p JOIN price_snapshots s ON s.id=p.snapshot_id WHERE ${conditions.join(' AND ')}`;
  const total=db.prepare(`SELECT COUNT(*) n ${from}`).get(...params).n;
  const rows=db.prepare(`SELECT p.name,p.chaos,p.variant_json,s.id snapshot_id,s.league,s.platform,s.observed_at,s.source_url,s.category ${from} ORDER BY julianday(s.observed_at) DESC,s.rowid DESC,p.ordinal LIMIT ?`).all(...params,limit);
  const currencyAt=db.prepare("SELECT p.chaos,s.observed_at,s.id snapshot_id FROM prices p JOIN price_snapshots s ON s.id=p.snapshot_id WHERE p.name='Divine Orb' AND s.category='Currency' AND s.platform=? AND s.league=? AND julianday(s.observed_at) BETWEEN julianday(?)-1 AND julianday(?)+5.0/1440 ORDER BY ABS(julianday(s.observed_at)-julianday(?)),s.rowid DESC LIMIT 1");
  return {game:'poe1',patch:'3.30',mode:'softcore',total_matches:total,limit,variant_selection_required:total>1,results:rows.map(({variant_json,...row})=>{
    const variant=JSON.parse(variant_json),itemRate=variant.divineValue>0?row.chaos/variant.divineValue:null;
    const divine=currencyAt.get(platform,row.league,row.observed_at,row.observed_at,row.observed_at);
    const conflict=divine?.chaos>0&&variant.divineValue>=1&&Math.abs(itemRate/divine.chaos-1)>0.25;
    return {...row,variant,age_hours:(Date.now()-Date.parse(row.observed_at))/3600000,sample_warning:typeof variant.count==='number'&&variant.count<5?'Fewer than five source observations; inspect the exact variant and confidence.':undefined,
      currency_comparison:variant.divineValue>=1?{status:divine?'nearby_snapshot':'unavailable',observed_at:divine?.observed_at??null,snapshot_id:divine?.snapshot_id??null,scope:'Nearest stored currency snapshot from the prior 24 hours, allowing five minutes collection skew; HTTP timestamps do not establish identical market sampling.'}:undefined,
      quote_warning:conflict?{code:'inconsistent_currency_conversion',item_implied_chaos_per_divine:itemRate,currency_feed_chaos_per_divine:divine.chaos,currency_snapshot_id:divine.snapshot_id,note:'Keep both source estimates; do not convert or total them as one consistent exchange rate.'}:undefined};}),
    selection:history?'all stored snapshots':'latest complete snapshot per category and platform',filters,
    note:'Dated estimates by exact item/variant. Not a current offer or proof of acquisition. Missing variant fields remain unknown; prices can be stale.'};
}

export function importCraftPlan(plan,db) {
  safeId(plan.id);
  if(plan.game!=='poe1'||plan.patch!=='3.30'||!plan.title||!plan.base_id||!Number.isInteger(plan.item_level)||plan.item_level<1||plan.item_level>100||!Array.isArray(plan.target_mod_ids)||!plan.target_mod_ids.length||!Array.isArray(plan.steps)||!plan.steps.length||!plan.tool_version||!plan.observed_at)throw new Error('Craft plan requires scope, title, base_id, item_level, target_mod_ids[], steps[], tool_version and observed_at');
  url(plan.source_url);
  const knowledge=new DatabaseSync(path.join(dbRoot,'data/knowledge-3.30.sqlite'),{readOnly:true});
  let sourceRecipe=null;
  try {
    const baseRow=knowledge.prepare("SELECT payload_json FROM records WHERE category='base_items' AND id=?").get(plan.base_id);
    if(!baseRow)throw new Error('Unknown base_id');
    for(const id of plan.target_mod_ids)if(!knowledge.prepare("SELECT 1 FROM records WHERE category='mods' AND id=?").get(id))throw new Error(`Unknown mod: ${id}`);
    if(plan.bench_craft_id!=null) {
      const craftRow=knowledge.prepare("SELECT payload_json FROM records WHERE category='bench_crafts' AND id=?").get(String(plan.bench_craft_id));
      if(!craftRow)throw new Error('Unknown bench craft');
      const craft=JSON.parse(craftRow.payload_json),base=JSON.parse(baseRow.payload_json),mod=craft.actions?.add_explicit_mod;
      if(!mod||plan.target_mod_ids.length!==1||plan.target_mod_ids[0]!==mod)throw new Error('Target mods do not match the bench recipe');
      if(!craft.item_classes.includes(base.item_class))throw new Error('Bench recipe does not allow the base item class');
      sourceRecipe={bench_craft_id:String(plan.bench_craft_id),item_class:base.item_class,source_cost:craft.cost,scope:'Recipe action and base class checked against pinned RePoE. Actual item affix room, mod groups, unlock and crafting state still require checking.'};
    }
  } finally {knowledge.close();}
  const stored={...plan,source_recipe:sourceRecipe,validation:sourceRecipe?sourceRecipe.scope:'Identifiers checked only; process legality, probabilities, cost, mod eligibility and acquisition remain unverified.',simulated_locally:false};
  db.prepare('INSERT INTO craft_plans VALUES (?,?)').run(plan.id,JSON.stringify(stored));
  return {id:plan.id,validation:stored.validation};
}
export function craftQuery(command,id,db) {
  if(command==='list')return {results:db.prepare('SELECT id FROM craft_plans ORDER BY id').all()};
  const row=db.prepare('SELECT payload_json FROM craft_plans WHERE id=?').get(id);
  return {count:row?1:0,results:row?[JSON.parse(row.payload_json)]:[]};
}
