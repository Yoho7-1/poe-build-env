import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import https from 'node:https';
import {isIP} from 'node:net';
import {dbRoot,atomicJson,readJson} from './workspace.mjs';

export const hosts=new Set(['poe.ninja','pobb.in','api.pob.codes','pastebin.com','www.poebuilds.cc','www.reddit.com','mobalytics.gg','www.poe-vault.com','beta.craftofexile.com']);
// Local network fix (not a bypass of the source's own rules): some networks drop a host's published CDN addresses
// (pobb.in on Cloudflare 188.114.96/97.x). An edge of the same CDN serves the same site by TLS SNI, so the request,
// host name, certificate check and rate limits are unchanged. Opt-in only: env POE_SOURCE_RESOLVE="pobb.in=104.21.0.1"
// or poe-db/cache/network.json {"resolve":{"pobb.in":"104.21.0.1"}} (local, git-ignored).
export const networkFile=()=>path.join(dbRoot,'cache/network.json');
export function resolveOverrides({file=networkFile(),env=process.env.POE_SOURCE_RESOLVE}={}){
  const map={};
  if(file&&fs.existsSync(file))Object.assign(map,readJson(file).resolve??{});
  for(const pair of String(env??'').split(',').map(s=>s.trim()).filter(Boolean)){const [h,ip]=pair.split('=');if(h&&ip)map[h.trim()]=ip.trim();}
  return map;
}
// doctor --deep: overrides must name approved hosts and literal IP addresses (offline check, no connection is made).
export function checkResolveOverrides(options={}){
  const map=resolveOverrides(options),problems=[];
  for(const [h,ip]of Object.entries(map)){if(!hosts.has(h))problems.push(`${h}: host is not approved`);if(!isIP(String(ip)))problems.push(`${h}: ${ip} is not an IP address`);}
  if(problems.length)throw new Error(`Invalid source resolve override: ${problems.join('; ')}`);
  return {overrides:map,count:Object.keys(map).length};
}
function fetchVia(url,ip,headers){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers,timeout:30000,lookup:(host,opts,cb)=>opts?.all?cb(null,[{address:ip,family:ip.includes(':')?6:4}]):cb(null,ip,ip.includes(':')?6:4)},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const body=Buffer.concat(chunks);
        resolve({status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,headers:{get:k=>{const v=res.headers[k.toLowerCase()];return v==null?null:String(v);}},arrayBuffer:async()=>body});});
    });
    req.on('timeout',()=>req.destroy(new Error(`timed out: ${url}`)));req.on('error',reject);
  });
}
export async function cachedSource(url,{offline=false,minimumAgeMs=900000,maxBytes=20*1024*1024}={}) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||!hosts.has(parsed.hostname))throw new Error('Source host/protocol is not approved for this collector');
  if(parsed.hostname==='poe.ninja'&&!parsed.pathname.startsWith('/poe1/api/economy/')&&parsed.pathname!=='/docs/api')throw new Error('Only documented public economy endpoints are used; builds/profiles APIs are excluded');
  const key=createHash('sha256').update(url).digest('hex'),directory=path.join(dbRoot,'cache/research');
  fs.mkdirSync(directory,{recursive:true});
  const metaFile=path.join(directory,`${key}.json`);
  const old=fs.existsSync(metaFile)?readJson(metaFile):null;
  const readCached=()=>{
    const bytes=fs.readFileSync(path.resolve(dbRoot,old.file));
    if(createHash('sha256').update(bytes).digest('hex')!==old.sha256)throw new Error(`Cached source checksum mismatch: ${url}`);
    return {bytes,metadata:old,cache_hit:true};
  };
  const serverMaxAge=Number(old?.cache_control?.match(/(?:^|,)\s*max-age=(\d+)/)?.[1]??0)*1000;
  if(old&&(offline||Date.now()-Date.parse(old.checked_at)<Math.max(minimumAgeMs,serverMaxAge)))return readCached();
  if(offline)throw new Error(`Source not cached: ${url}`);
  const headers={'User-Agent':'LocalPoEWorkbench/0.2 (single-user research; manual cached snapshots; local project contact)'};
  if(old?.etag)headers['If-None-Match']=old.etag;
  if(old?.last_modified)headers['If-Modified-Since']=old.last_modified;
  const edge=resolveOverrides()[parsed.hostname];
  const response=edge?await fetchVia(url,edge,headers):await fetch(url,{headers,signal:AbortSignal.timeout(30000)});
  const checked_at=new Date().toISOString();
  if(response.status===304&&old) {
    old.checked_at=checked_at;
    atomicJson(metaFile,old);
    return readCached();
  }
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${url}; no stale data was relabelled as fresh`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>maxBytes)throw new Error(`Source exceeds ${maxBytes} bytes`);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const bodyFile=path.join(directory,`${key}-${sha256}.body`);
  const metadata={url,via_edge:edge??undefined,sha256,bytes:bytes.length,obtained_at:checked_at,checked_at,
    etag:response.headers.get('etag'),last_modified:response.headers.get('last-modified'),http_date:response.headers.get('date'),
    cache_control:response.headers.get('cache-control'),content_type:response.headers.get('content-type'),
    file:path.relative(dbRoot,bodyFile).replaceAll('\\','/')};
  if(!fs.existsSync(bodyFile))fs.writeFileSync(bodyFile,bytes,{flag:'wx'});
  atomicJson(metaFile,metadata);
  return {bytes,metadata,cache_hit:false};
}
