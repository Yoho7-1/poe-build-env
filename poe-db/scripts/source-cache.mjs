import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {dbRoot,atomicJson,readJson} from './workspace.mjs';

const hosts=new Set(['poe.ninja','pobb.in','www.reddit.com','mobalytics.gg','www.poe-vault.com','beta.craftofexile.com']);
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
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(30000)});
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
  const metadata={url,sha256,bytes:bytes.length,obtained_at:checked_at,checked_at,
    etag:response.headers.get('etag'),last_modified:response.headers.get('last-modified'),http_date:response.headers.get('date'),
    cache_control:response.headers.get('cache-control'),content_type:response.headers.get('content-type'),
    file:path.relative(dbRoot,bodyFile).replaceAll('\\','/')};
  if(!fs.existsSync(bodyFile))fs.writeFileSync(bodyFile,bytes,{flag:'wx'});
  atomicJson(metaFile,metadata);
  return {bytes,metadata,cache_hit:false};
}
