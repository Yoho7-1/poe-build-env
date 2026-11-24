// Local build corpus (WP2) without network: PoB files or share codes already on disk -> explicit PoB migration to
// the 3.30 tree when needed -> BuildCard with provenance. Reuses pob import/migrate (runPob) and build-card; stores
// the calculated XML next to the cards (research/lab/corpus, local and git-ignored). Popularity is not evidence; a
// migrated 3.29 build is a local transfer, not the author's 3.30 build (trust and origin_patch say so).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectRoot, readJson, flags } from './workspace.mjs';
import { runPob, decodeBuild, inspectBuild } from './pob.mjs';
import { buildCard, saveCard, listCards, cardDirectory } from './build-card.mjs';

export const corpusDirectory = () => path.join(projectRoot, 'research/lab/corpus');
const trusts = ['own', 'author', 'community', 'generated', 'unknown'];

// [name, url] pair lists (research/*-pobs.json) and {id|name, pob, versions[]} build lists -> Map(file stem -> url).
export function sourceMap(files = []) {
  const map = new Map();
  for (const f of files) {
    const j = readJson(f);
    const list = Array.isArray(j) ? j : j.builds ?? [];
    for (const x of list) {
      if (Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string') map.set(x[0], x[1]);
      else if (x && typeof x === 'object' && x.id && typeof x.pob === 'string') map.set(x.id, x.pob);
    }
  }
  return map;
}

// One file or share code into the corpus. Standard 3_28/3_29 trees are migrated explicitly (node changes counted).
export function addToCorpus({ file, source = null, trust = 'unknown', originPatch = null, scenario = 'sustained', directory = corpusDirectory(), cards = cardDirectory() }) {
  if (!trusts.includes(trust)) throw new Error(`--trust must be ${trusts.join('|')}`);
  const raw = fs.readFileSync(file);
  const { xml } = decodeBuild(raw);
  const audit = inspectBuild(xml);
  const sha = createHash('sha256').update(xml).digest('hex');
  fs.mkdirSync(path.join(directory, 'xml'), { recursive: true });
  let target = path.join(directory, 'xml', `${sha.slice(0, 16)}.xml`), migration = null;
  if (audit.tree_version === '3_30') { if (!fs.existsSync(target)) fs.writeFileSync(target, xml); }
  else if (['3_28', '3_29'].includes(audit.tree_version)) {
    target = path.join(directory, 'xml', `${sha.slice(0, 16)}-to-3_30.xml`);
    if (!fs.existsSync(target)) {
      const r = runPob({ input: raw, scenario: 'imported', migrate: true, saveXml: target });
      migration = { from: audit.tree_version, trees: (r.migration?.trees ?? []).map(t => ({ index: t.index, title: t.title, removed: t.removed_nodes, added: t.added_nodes, changed: t.changed_nodes })) };
    } else migration = { from: audit.tree_version, note: 'migrated earlier' };
  } else throw new Error(`Tree ${audit.tree_version} is not supported (3_28/3_29 migrate, 3_30 direct)`);
  const card = buildCard({ file: target, scenario, source: source ?? path.basename(file), trust });
  card.identity.origin = { file: path.basename(file), source_sha256: sha, origin_patch: originPatch ?? (audit.tree_version === '3_30' ? '3.30' : audit.tree_version.replace('_', '.')), migration };
  const stored = saveCard(card, cards);
  return { name: path.basename(file), signature: card.signature, class: card.features.class, ascendancy: card.features.ascendancy, main_skill: card.features.main_skill,
    form: card.features.primary_form, type: card.features.primary_type, dps: card.damage.effective_dps, scope: card.damage.scope, migrated: !!migration, same_signature: stored.same_signature, card: stored.saved };
}

// Share-code hosts PoB itself imports from. One request per link (cached, conditional), never a crawl: links come from
// guides the user chose (Maxroll, YouTube, forum pages are read by the user; their sites forbid automated scraping).
export function rawUrl(url) {
  const u = new URL(url);
  if (u.hostname === 'pobb.in') return `https://pobb.in${u.pathname.replace(/\/raw\/?$/, '').replace(/\/$/, '')}/raw`;
  // pob.codes: same endpoint PoB's BuildSiteTools uses (pob.codes/b/<id> -> api.pob.codes/<id>/raw).
  if (u.hostname === 'pob.codes' || u.hostname === 'api.pob.codes') { const id = u.pathname.replace(/^\/(b\/)?/, '').replace(/\/raw\/?$/, '').replace(/\/$/, ''); if (!id) throw new Error('pob.codes link has no build id: expected https://pob.codes/b/<id>'); return `https://api.pob.codes/${id}/raw`; }
  if (u.hostname === 'pastebin.com') return `https://pastebin.com/raw/${u.pathname.replace(/^\/(raw\/)?/, '').replace(/\/$/, '')}`;
  throw new Error(`Unsupported host ${u.hostname}: use a pobb.in, pob.codes or pastebin.com link, or paste the code with --code / a .txt file`);
}
export async function addFromUrl({ url, source = null, trust = 'community', originPatch = null, fetchSource = null, directory = corpusDirectory(), cards = cardDirectory() }) {
  const raw = rawUrl(url);
  const fetcher = fetchSource ?? (await import('./source-cache.mjs')).cachedSource;
  let data;
  try { data = await fetcher(raw, { minimumAgeMs: 7 * 86400000 }); }
  catch (e) { throw new Error(`${e.message}${/fetch failed|ECONN|ETIMEDOUT|timed out/i.test(e.message) ? ' — the host is unreachable from this network; open the link in a browser that can reach it and pass the code with corpus add --code' : ''}`); }
  const code = Buffer.from(data.bytes).toString('utf8').trim();
  fs.mkdirSync(path.join(directory, 'codes'), { recursive: true });
  const file = path.join(directory, 'codes', `${createHash('sha256').update(code).digest('hex').slice(0, 16)}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, code);
  return { url, ...addToCorpus({ file, source: source ?? url, trust, originPatch, directory, cards }) };
}
// Links already in the corpus: the URL part of each card's identity.source, normalised to the raw paste address.
export function corpusSources(cards = cardDirectory()) {
  const set = new Set();
  if (!fs.existsSync(cards)) return set;
  for (const f of fs.readdirSync(cards).filter(f => f.endsWith('.json'))) {
    const url = String(readJson(path.join(cards, f)).identity?.source ?? '').split(/\s/)[0];
    try { set.add(rawUrl(url)); } catch { /* local file or pasted code: not a link */ }
  }
  return set;
}
// List file: one link per line, optional "<TAB>source note" (guide page, author, tier); '#' comments. Links already in
// the corpus are skipped, so a rerun resumes; failures go to <list>.failed.txt (itself a list, error as a comment).
export async function addFromList({ file, trust = 'community', originPatch = null, delayMs = 2000, fetchSource = null, directory, cards = cardDirectory() }) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const known = corpusSources(cards), seen = new Set();
  const failedFile = file.replace(/\.txt$/i, '') + '.failed.txt';
  const added = [], failed = [], skipped = [];
  const writeFailed = () => fs.writeFileSync(failedFile, `# corpus add-list failures from ${path.basename(file)} (${new Date().toISOString()}); rerun: corpus add-list <this file>\n`
    + failed.map(f => `# ${f.error.replace(/\s+/g, ' ')}\n${f.line}`).join('\n') + '\n');
  let fetched = 0;
  for (const line of lines) {
    const [url, note] = line.split('\t');
    let key = url;
    try { key = rawUrl(url); } catch { /* reported by addFromUrl below */ }
    if (known.has(key) || seen.has(key)) { skipped.push(url); continue; }
    seen.add(key);
    if (delayMs && fetched++) await new Promise(r => setTimeout(r, delayMs));
    try { const r = await addFromUrl({ url, source: note ? `${url} (${note})` : url, trust, originPatch, fetchSource, directory, cards }); added.push(r); known.add(key); }
    catch (e) { failed.push({ url, line, error: e.message.slice(0, 300) }); writeFailed(); }
  }
  if (!failed.length && fs.existsSync(failedFile)) fs.rmSync(failedFile);
  return { added: added.length, skipped_already_in_corpus: skipped.length, failed: failed.map(({ line, ...f }) => f), failed_file: failed.length ? failedFile : null, builds: added };
}

export function importDirectory({ dir, sources = new Map(), trust = 'community', originPatch = null, scenario = 'sustained', directory, cards }) {
  const files = fs.readdirSync(dir).filter(f => /\.(xml|txt|code)$/i.test(f)).sort();
  const added = [], failed = [];
  for (const f of files) {
    const stem = f.replace(/\.(xml|txt|code)$/i, '');
    try { added.push(addToCorpus({ file: path.join(dir, f), source: sources.get(stem) ?? null, trust, originPatch, scenario, directory, cards })); }
    catch (e) { failed.push({ file: f, error: e.message.slice(0, 300) }); }
  }
  return { dir: path.resolve(dir), added: added.length, failed, builds: added };
}

// Coverage of the corpus: counts by class/ascendancy, main skill, damage form/type and defense pool; duplicates.
export function corpusSummary(cards = cardDirectory()) {
  const list = listCards(cards);
  const count = key => list.reduce((m, c) => { const k = c[key] ?? 'unknown'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const bySig = list.reduce((m, c) => { (m[c.signature] ??= []).push(c.name); return m; }, {});
  return { cards: list.length, by_ascendancy: count('ascendancy'), by_skill: count('main_skill'), by_form: count('form'), by_type: count('type'), by_pool: count('pool'),
    duplicates: Object.values(bySig).filter(v => v.length > 1) };
}

export function corpusCommand(args) {
  const { positional, options } = flags(args, ['source', 'trust', 'origin-patch', 'scenario', 'sources', 'code', 'delay-ms']);
  const [op, target] = positional;
  if (op === 'summary') return corpusSummary();
  if (op === 'list') return { cards: listCards() };
  if (op === 'add-url') { if (!target) throw new Error('Use corpus add-url <pobb.in|pob.codes|pastebin link> [--source text] [--trust t] [--origin-patch p]'); return addFromUrl({ url: target, source: options.source ?? null, trust: options.trust ?? 'community', originPatch: options['origin-patch'] ?? null }); }
  if (op === 'add-list') { if (!target) throw new Error('Use corpus add-list <links.txt> (one link per line, optional TAB note)'); return addFromList({ file: path.resolve(target), trust: options.trust ?? 'community', originPatch: options['origin-patch'] ?? null, delayMs: Number(options['delay-ms'] ?? 2000) }); }
  if (op === 'add' && options.code) {
    const dir = path.join(corpusDirectory(), 'codes'); fs.mkdirSync(dir, { recursive: true });
    const code = options.code.trim(); const file = path.join(dir, `${createHash('sha256').update(code).digest('hex').slice(0, 16)}.txt`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, code);
    return addToCorpus({ file, source: options.source ?? 'pasted code', trust: options.trust ?? 'unknown', originPatch: options['origin-patch'] ?? null, scenario: options.scenario ?? 'sustained' });
  }
  if (op === 'add') { if (!target) throw new Error('Use corpus add <file.xml|code.txt> [--source url] [--trust t] [--origin-patch 3.29]'); return addToCorpus({ file: path.resolve(target), source: options.source ?? null, trust: options.trust ?? 'unknown', originPatch: options['origin-patch'] ?? null, scenario: options.scenario ?? 'sustained' }); }
  if (op === 'import-dir') {
    if (!target) throw new Error('Use corpus import-dir <dir> [--sources a.json,b.json] [--trust community] [--origin-patch 3.29]');
    const sources = sourceMap((options.sources ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => path.resolve(s)));
    return importDirectory({ dir: path.resolve(target), sources, trust: options.trust ?? 'community', originPatch: options['origin-patch'] ?? null, scenario: options.scenario ?? 'sustained' });
  }
  throw new Error('Use corpus add|add-url|add-list|import-dir|list|summary|ablate-all|learn|insights');
}
export const corpusHelp = {
  'corpus add <file.xml|code.txt> [--source url] [--trust own|author|community|generated|unknown] [--origin-patch 3.29] | corpus import-dir <dir> [--sources lists.json,...]':
    'Local corpus without network: explicit PoB migration of 3_28/3_29 trees, BuildCard with provenance (research/lab/corpus, research/lab/cards)',
  'corpus list | corpus summary': 'Corpus cards and coverage by ascendancy, skill, damage form/type, defense pool; structural duplicates',
  'corpus add-url <pobb.in|pob.codes|pastebin link> | corpus add-list <links.txt> | corpus add --code <share code>': 'One cached request per link (no crawling); Maxroll/YouTube/forum pages are read by the user, the system fetches only the PoB paste. add-list skips links already in the corpus (identity.source) and writes failures to <list>.failed.txt (a list again: rerun it to resume). Link lists: corpus discover poebuilds'
};
