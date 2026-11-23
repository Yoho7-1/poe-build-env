import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dbRoot,atomicJson} from './workspace.mjs';
import {cachedSource} from './source-cache.mjs';
import {referenceDb,importPrices,reindexPriceVariants} from './reference-store.mjs';

export function normalizeOverview(body,{category,source,leagueId}) {
  if(leagueId!=='Covens')throw new Error('Only explicitly selected standard Softcore Covens is accepted');
  if(!Array.isArray(body.lines))throw new Error('Unexpected economy schema: missing lines');
  const currency=category==='Currency';
  const lines=[],excluded=[];
  for(const row of body.lines) {
    const name=currency?row.currencyTypeName:row.name,value=currency?row.chaosEquivalent:row.chaosValue;
    if(typeof name!=='string'||typeof value!=='number'||!Number.isFinite(value)||value<0) {excluded.push({name:name??null,reason:'missing_or_invalid_price'});continue;}
    lines.push({...row,name,chaosValue:value});
  }
  if(!lines.length)throw new Error(`No valid price observations in ${category}`);
  return {snapshot:{game:'poe1',patch:'3.30',mode:'softcore',league:'Covens of Umbra',api_league_id:leagueId,platform:'pc',
    category,source_url:source.url,source_sha256:source.sha256,observed_at:source.obtained_at,
    time_basis:'HTTP response received; underlying market observation times may differ',http_date:source.http_date,
    quote_kind:currency?'stash_currency_estimate':'stash_item_estimate',lines},excluded};
}

async function main() {
  const offline=process.argv.includes('--cached-only');
  const categories=['Currency','UniqueWeapon','UniqueArmour','UniqueAccessory','UniqueFlask','UniqueJewel','UniqueTincture','SkillGem','ClusterJewel','BaseType'];
  const leaguesSource=await cachedSource('https://poe.ninja/poe1/api/economy/leagues',{offline});
  const leagues=JSON.parse(leaguesSource.bytes.toString('utf8'));
  if(!Array.isArray(leagues)||!leagues.some(l=>l.id==='Covens'&&l.name==='Covens'))throw new Error('Covens is not in the advertised economy league list');
  const db=referenceDb(),results=[],sources=[leaguesSource.metadata],excluded=[];
  try {
    for(const category of categories) {
      const kind=category==='Currency'?'currency':'item';
      const url=`https://poe.ninja/poe1/api/economy/stash/current/${kind}/overview?league=Covens&type=${category}`;
      const data=await cachedSource(url,{offline});sources.push(data.metadata);
      const normalized=normalizeOverview(JSON.parse(data.bytes.toString('utf8')),{category,source:data.metadata,leagueId:'Covens'});
      excluded.push(...normalized.excluded.map(e=>({...e,category})));
      const snapshot=normalized.snapshot;
      const id=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const stored=db.prepare('SELECT id FROM price_snapshots WHERE id=?').get(id);
      const result=stored?{snapshot_id:id,records:snapshot.lines.length,already_imported:true}:importPrices(snapshot,db);
      results.push({category,...result,cache_hit:data.cache_hit});
      console.log(`${category}: ${snapshot.lines.length} observations${stored?' (already imported)':''}`);
      if(!offline&&!data.cache_hit)await new Promise(resolve=>setTimeout(resolve,1100));
    }
    reindexPriceVariants(db);
  } finally {db.close();}
  const report={at:new Date().toISOString(),game:'poe1',patch:'3.30',league:'Covens of Umbra',api_league_id:'Covens',platform:'pc',
    categories:results,total_observations:results.reduce((n,r)=>n+r.records,0),sources,excluded,documentation:'https://poe.ninja/docs/api',
    limitations:['Estimates and dated observations, not guaranteed offers or acquisition proof.','Exact item variants, corruption, links and gem levels/quality must match.','No live rare-item appraisal or build/profile API scraping.']};
  atomicJson(path.join(dbRoot,'reports/economy-summary.json'),report);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
