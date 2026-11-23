import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { dbRoot, projectRoot, readJson, hashFile, atomicJson } from './workspace.mjs';
import { cards, sourceFiles } from '../mechanics/catalog.mjs';

export function buildMechanics() {
  const lock = readJson(path.join(dbRoot,'environment.lock.json'));
  const sources = Object.entries(sourceFiles).map(([id,file]) => ({ id,kind:'engine_implementation',version:lock.versions.pob,
    url:`https://github.com/PathOfBuildingCommunity/PathOfBuilding/blob/${lock.versions.pob_commit}/${file}`,
    file:`vendor/pob/${file}`,sha256:hashFile(path.join(dbRoot,'vendor/pob',file)) }));
  sources.push({id:'ggg.tree',kind:'official_data',version:'3.30.0',file:'../research/330/ggg-passive-tree.json',
    url:'https://github.com/grindinggear/skilltree-export/blob/550fb34ae7fca9ec4d760a2ac845bb2ba1032ec3/data.json',sha256:hashFile(path.join(projectRoot,'research/330/ggg-passive-tree.json'))},
    {id:'project.catalog-rules',kind:'local_methodology',version:'1',file:'scripts/model.mjs',url:'local:poe-db/scripts/model.mjs',sha256:hashFile(path.join(dbRoot,'scripts/model.mjs'))});
  sources.push({id:'project.reference-rules',kind:'local_methodology',version:'2',file:'scripts/reference-store.mjs',url:'local:poe-db/scripts/reference-store.mjs',sha256:hashFile(path.join(dbRoot,'scripts/reference-store.mjs'))});
  const sourceIds=new Set(sources.map(s=>s.id)), ids=new Set(cards.map(c=>c.id));
  if(ids.size!==cards.length)throw new Error('Duplicate mechanic identifiers');
  for(const card of cards) {
    if(card.sources.some(s=>!sourceIds.has(s)))throw new Error(`Unknown source in ${card.id}`);
    if(card.relations.some(r=>!ids.has(r.target)))throw new Error(`Broken relation in ${card.id}`);
  }
  const snapshot=createHash('sha256').update(JSON.stringify({cards,sources})).digest('hex').slice(0,16);
  const temp=path.join(dbRoot,'data',`mechanics-${randomUUID()}.sqlite`), db=new DatabaseSync(temp);
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE sources(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE cards(id TEXT PRIMARY KEY,title TEXT NOT NULL,json TEXT NOT NULL); CREATE TABLE citations(card_id TEXT REFERENCES cards(id),source_id TEXT REFERENCES sources(id),PRIMARY KEY(card_id,source_id)); CREATE TABLE relations(card_id TEXT REFERENCES cards(id),type TEXT NOT NULL,target TEXT REFERENCES cards(id),PRIMARY KEY(card_id,type,target)); CREATE VIRTUAL TABLE card_search USING fts5(id UNINDEXED,title,body,tokenize="unicode61"); BEGIN;');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('snapshot_id',snapshot);
    for(const s of sources)db.prepare('INSERT INTO sources VALUES (?,?)').run(s.id,JSON.stringify(s));
    for(const c of cards) {
      db.prepare('INSERT INTO cards VALUES (?,?,?)').run(c.id,c.title,JSON.stringify(c));
      db.prepare('INSERT INTO card_search VALUES (?,?,?)').run(c.id,c.title,[c.id,...c.aliases,c.summary,...c.rules,...c.conditions,...c.pitfalls].join('\n'));
    }
    for(const c of cards) {
      for(const s of c.sources)db.prepare('INSERT INTO citations VALUES (?,?)').run(c.id,s);
      for(const r of c.relations)db.prepare('INSERT INTO relations VALUES (?,?,?)').run(c.id,r.type,r.target);
    }
    db.exec('COMMIT');
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Mechanics integrity failure');
  } finally {db.close();}
  fs.renameSync(temp,path.join(dbRoot,'data/mechanics-3.30.sqlite'));
  atomicJson(path.join(dbRoot,'mechanics/cards.json'),cards);
  atomicJson(path.join(dbRoot,'mechanics/sources.json'),sources);
  atomicJson(path.join(dbRoot,'reports/mechanics-summary.json'),{game:'poe1',patch:'3.30',snapshot_id:snapshot,cards:cards.length,sources:sources.length,
    relations:cards.reduce((n,c)=>n+c.relations.length,0),scope:'Curated engine explanations, not comprehensive in-game mechanical proof.',integrity:'ok'});
  return {snapshot_id:snapshot,cards:cards.length,sources:sources.length};
}

export function queryMechanics(command,text='',{limit=5,related=false}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('Mechanics limit must be 1–20');
  const db=new DatabaseSync(path.join(dbRoot,'data/mechanics-3.30.sqlite'),{readOnly:true});
  try {
    const snapshot_id=db.prepare('SELECT value FROM metadata WHERE key=?').get('snapshot_id').value;
    const context={game:'poe1',patch:'3.30',snapshot_id};
    if(command==='list')return {...context,results:db.prepare('SELECT id,title FROM cards ORDER BY id').all()};
    if(command==='search') {
      if(!text.trim())throw new Error('Mechanic search text required');
      const query=text.trim().split(/\s+/).map(s=>`"${s.replaceAll('"','""')}"`).join(' AND ');
      const rows=db.prepare('SELECT c.json FROM card_search JOIN cards c ON c.id=card_search.id WHERE card_search MATCH ? ORDER BY rank LIMIT ?').all(query,limit);
      return {...context,results:rows.map(r=>{const c=JSON.parse(r.json);return {id:c.id,title:c.title,summary:c.summary,confidence:c.confidence};})};
    }
    if(command!=='get')throw new Error('Use mechanic list, search <text>, get <id>');
    const found=db.prepare('SELECT json FROM cards WHERE id=?').get(text);
    if(!found)return {...context,count:0,results:[]};
    const card=JSON.parse(found.json);
    const sources=card.sources.map(id=>JSON.parse(db.prepare('SELECT json FROM sources WHERE id=?').get(id).json));
    const neighbors=related?card.relations.map(r=>{const c=JSON.parse(db.prepare('SELECT json FROM cards WHERE id=?').get(r.target).json);return {relation:r.type,id:c.id,title:c.title,summary:c.summary};}):undefined;
    return {...context,count:1,results:[{...card,sources,related:neighbors}]};
  } finally {db.close();}
}
