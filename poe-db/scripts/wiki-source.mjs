// Explicit, cached PoE Wiki (poewiki.net) downloads with sha256 provenance.
// Network is used only by fetch-* scripts; build/query code reads the cache offline.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dbRoot, atomicJson, readJson } from './workspace.mjs';

export const wikiCache = path.join(dbRoot, 'cache/wiki');
export const wikiManifestFile = path.join(wikiCache, 'manifest.json');
const API = 'https://www.poewiki.net/w/api.php';
const UA = 'LocalPoEWorkbench/0.3 (single-user research; cached snapshots)';

export function loadWikiManifest() {
  return fs.existsSync(wikiManifestFile) ? readJson(wikiManifestFile) : { source: 'https://www.poewiki.net', sources: {} };
}

async function getJson(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    if (response.ok) {
      const json = await response.json();
      if (json.error) throw new Error(`Wiki API error ${json.error.code}: ${json.error.info}`);
      return { url, json };
    }
    if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}: ${url}`);
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`Wiki API unavailable: ${url}`);
}

function store(manifest, name, value, meta) {
  fs.mkdirSync(wikiCache, { recursive: true });
  const text = JSON.stringify(value);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const file = path.join(wikiCache, `${name}.json`);
  fs.writeFileSync(file, text);
  manifest.sources[name] = { ...meta, file: path.relative(dbRoot, file).replaceAll('\\', '/'), sha256, bytes: Buffer.byteLength(text), obtained_at: new Date().toISOString() };
  atomicJson(wikiManifestFile, manifest);
  return manifest.sources[name];
}

// Cargo query with paging; rows are returned as the API "title" objects.
export async function fetchCargo(manifest, name, { tables, fields, where = '', orderBy = '_pageName', pageSize = 500 }) {
  const rows = [];
  let firstUrl = null;
  for (let offset = 0; ; offset += pageSize) {
    const { url, json } = await getJson({ action: 'cargoquery', tables, fields, where, order_by: orderBy, limit: String(pageSize), offset: String(offset) });
    firstUrl ??= url;
    const page = (json.cargoquery ?? []).map(r => r.title);
    rows.push(...page);
    if (page.length < pageSize) break;
    await new Promise(r => setTimeout(r, 400));
  }
  return { rows, meta: store(manifest, name, rows, { kind: 'cargo', tables, fields, where, url: firstUrl, rows: rows.length }) };
}

export async function fetchWikitext(manifest, name, page) {
  const { url, json } = await getJson({ action: 'parse', page, prop: 'wikitext|revid', formatversion: '2' });
  const value = { title: json.parse.title, revid: json.parse.revid, wikitext: json.parse.wikitext };
  return { value, meta: store(manifest, name, value, { kind: 'page', page, revid: value.revid, url, page_url: `https://www.poewiki.net/wiki/${encodeURIComponent(page.replaceAll(' ', '_'))}?oldid=${value.revid}` }) };
}

export function readWikiCache(name) {
  const manifest = loadWikiManifest();
  const meta = manifest.sources[name];
  if (!meta) throw new Error(`Wiki source "${name}" not cached; run the matching fetch-* script (network, explicit)`);
  const text = fs.readFileSync(path.join(dbRoot, meta.file), 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== meta.sha256) throw new Error(`Wiki cache checksum mismatch: ${name}`);
  return { value: JSON.parse(text), meta };
}

export const decodeEntities = s => s == null ? s : String(s).replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
