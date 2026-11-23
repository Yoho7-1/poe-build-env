// Research corpus (research/) -> data/meta-research.sqlite. Everything here is dated and league/patch
// labelled; none of it is 3.30 meta. Allflame (2026-07-24..2026-11-11) is the 3.29 league.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dbRoot, projectRoot, readJson, flags } from './workspace.mjs';

export const metaFile = path.join(dbRoot, 'data/meta-research.sqlite');
const research = rel => path.join(projectRoot, 'research', rel);
// League -> patch: league start equals the Wiki "Version 3.29.0" release date (2026-07-24).
const LEAGUES = [
  { file: 'Allflame.items.csv', league: 'Allflame', patch: '3.29', mode: 'softcore', basis: 'poe.ninja dump Allflame.zip 2026-07-24..2026-11-11; 3.29.0 released 2026-07-24' },
  { file: 'Hardcore Allflame.items.csv', league: 'Hardcore Allflame', patch: '3.29', mode: 'hardcore', basis: 'same dump, hardcore league' }
];
const ITEM_TYPES = /^(SkillGem|Unique[A-Za-z]+)$/;
const WARNING = 'Research corpus collected 2026-11-12 (before 3.30.0 release on 2026-11-13) and 3.29 Allflame economy. Not 3.30 meta; prices are not popularity.';
const norm = s => String(s ?? '').toLowerCase().trim();
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function aggregateCsv(spec, insert) {
  const file = research(spec.file);
  if (!fs.existsSync(file)) return null;
  const groups = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let header = null, lines = 0;
  for await (const line of rl) {
    if (!header) { header = line.split(';'); continue; }
    const [league, date, , type, name, base, variant, links, value, confidence] = line.split(';');
    if (!ITEM_TYPES.test(type)) continue;
    lines++;
    const key = `${type}\u0000${name}\u0000${base}\u0000${variant}\u0000${links}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { type, name, base, variant, links, rows: [] });
    g.rows.push([date, Number(value), confidence]);
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => a[0].localeCompare(b[0]));
    const high = g.rows.filter(r => r[2] === 'High');
    const use = high.length ? high : g.rows;
    const values = use.map(r => r[1]).filter(Number.isFinite).sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)] : null;
    const firstWeek = use.filter(r => r[0] <= addDays(g.rows[0][0], 6)).map(r => r[1]);
    insert.run(spec.league, spec.patch, spec.mode, g.type, g.name, g.base || null, g.variant || null, g.links || null, g.rows.length, high.length,
      g.rows[0][0], g.rows.at(-1)[0], values[0] ?? null, median, values.at(-1) ?? null,
      firstWeek.length ? firstWeek.reduce((s, x) => s + x, 0) / firstWeek.length : null, use.at(-1)[1]);
  }
  return { file: `research/${spec.file}`, sha256: sha(file), rows: lines, groups: groups.size, league: spec.league, patch: spec.patch, basis: spec.basis };
}
function addDays(date, days) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

function findingsSections(text) {
  const out = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { current = { heading: h[2].trim(), level: h[1].length, body: [] }; out.push(current); continue; }
    if (current) current.body.push(line);
  }
  return out.map(s => ({ ...s, body: s.body.join('\n').trim() }));
}

export async function buildMeta() {
  const gems = readJson(path.join(dbRoot, 'cache/knowledge/gems.json'));
  const gemNames = [...new Set(Object.values(gems).filter(g => g.base_item?.release_state === 'released').map(g => g.base_item.display_name))].sort((a, b) => b.length - a.length);
  const temp = path.join(dbRoot, 'data', `meta-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(temp);
  const provenance = { warning: WARNING, files: [] };
  try {
    db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE builds(id TEXT PRIMARY KEY, name TEXT NOT NULL, ascendancy TEXT, author TEXT, tier TEXT, pob_patch TEXT, guide_patch TEXT,
        patch_status TEXT, patch_note TEXT, compatible INTEGER, confidence TEXT, checked_at TEXT NOT NULL, origin TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE build_skills(build_id TEXT REFERENCES builds(id), skill TEXT NOT NULL, basis TEXT NOT NULL, PRIMARY KEY(build_id, skill));
      CREATE TABLE sources(id INTEGER PRIMARY KEY, title TEXT, url TEXT, type TEXT, versions TEXT, topics TEXT, access TEXT, assessment TEXT, checked_at TEXT NOT NULL);
      CREATE TABLE findings(id INTEGER PRIMARY KEY, heading TEXT NOT NULL, level INTEGER, body TEXT, written_at TEXT NOT NULL, scope TEXT NOT NULL);
      CREATE TABLE prices(league TEXT, patch TEXT, mode TEXT, type TEXT, name TEXT, base_type TEXT, variant TEXT, links TEXT, observations INTEGER, high_confidence INTEGER,
        first_date TEXT, last_date TEXT, min_chaos REAL, median_chaos REAL, max_chaos REAL, first_week_mean_chaos REAL, last_chaos REAL);
      CREATE INDEX prices_name ON prices(name COLLATE NOCASE); CREATE INDEX skills_name ON build_skills(skill COLLATE NOCASE);
      BEGIN;`);
    const insBuild = db.prepare('INSERT OR REPLACE INTO builds VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insSkill = db.prepare('INSERT OR IGNORE INTO build_skills VALUES (?,?,?)');
    for (const file of ['verified-builds.json', 'additional-builds.json']) {
      const full = research(file);
      if (!fs.existsSync(full)) continue;
      const j = readJson(full);
      provenance.files.push({ file: `research/${file}`, sha256: sha(full), checked_at: j.checkedAt, builds: j.builds.length });
      for (const b of j.builds) {
        insBuild.run(b.id, b.name, b.ascendancy ?? null, b.author ?? null, b.tier ?? null, b.pobPatch ?? null, b.guidePatch ?? null, b.patchStatus ?? null, b.patchNote ?? null,
          b.compatible == null ? null : b.compatible ? 1 : 0, b.confidence ?? null, j.checkedAt, `research/${file}`, JSON.stringify(b));
        let rest = ` ${b.name} `;
        for (const g of gemNames) {
          const re = new RegExp(`(^|[^A-Za-z'])${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z']|$)`);
          if (re.test(rest)) { insSkill.run(b.id, g, 'gem name in build title'); rest = rest.replace(re, '$1 $2'); }
        }
      }
    }
    const sourcesFile = research('sources.json');
    if (fs.existsSync(sourcesFile)) {
      const s = readJson(sourcesFile);
      provenance.files.push({ file: 'research/sources.json', sha256: sha(sourcesFile), checked_at: s.checked_at, sources: s.sources.length });
      const ins = db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)');
      for (const x of s.sources) ins.run(x.id, x.title, x.url, x.type, JSON.stringify(x.versions ?? []), JSON.stringify(x.topics ?? []), x.access ?? null, x.assessment ?? null, s.checked_at);
    }
    const findingsFile = research('FINDINGS.md');
    if (fs.existsSync(findingsFile)) {
      provenance.files.push({ file: 'research/FINDINGS.md', sha256: sha(findingsFile), written_at: '2026-11-12' });
      const ins = db.prepare('INSERT INTO findings(heading, level, body, written_at, scope) VALUES (?,?,?,?,?)');
      for (const s of findingsSections(fs.readFileSync(findingsFile, 'utf8'))) ins.run(s.heading, s.level, s.body, '2026-11-12', 'pre-3.30 research (3.29 and older guides)');
    }
    const insPrice = db.prepare('INSERT INTO prices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const spec of LEAGUES) { const r = await aggregateCsv(spec, insPrice); if (r) provenance.files.push(r); }
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('provenance', JSON.stringify(provenance));
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('built_at', new Date().toISOString());
    db.exec('COMMIT');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('meta integrity failure');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); fs.rmSync(temp, { force: true }); throw error; }
  db.close();
  fs.renameSync(temp, metaFile);
  return { file: 'data/meta-research.sqlite', provenance };
}

function open() {
  if (!fs.existsSync(metaFile)) throw new Error('data/meta-research.sqlite missing: run node scripts/meta.mjs build (offline, reads research/)');
  return new DatabaseSync(metaFile, { readOnly: true });
}
const buildRow = r => { const j = JSON.parse(r.json); return { id: r.id, name: r.name, ascendancy: r.ascendancy, tier: r.tier, pob_patch: r.pob_patch, guide_patch: r.guide_patch,
  patch_status: r.patch_status, patch_note: r.patch_note, compatible: r.compatible == null ? null : !!r.compatible, checked_at: r.checked_at, origin: r.origin,
  stale: r.pob_patch !== '3.30', guide: j.guide ?? null, pob: j.pob ?? null }; };

export function metaSkill(name, db) {
  const v = norm(name);
  const skills = db.prepare('SELECT build_id FROM build_skills WHERE skill = ? COLLATE NOCASE').all(name).map(r => r.build_id);
  const byText = db.prepare("SELECT * FROM builds WHERE lower(name) LIKE ? OR lower(patch_note) LIKE ?").all(`%${v}%`, `%${v}%`);
  const ids = new Set([...skills, ...byText.map(b => b.id)]);
  const builds = [...ids].map(id => buildRow(db.prepare('SELECT * FROM builds WHERE id = ?').get(id)));
  const prices = db.prepare("SELECT * FROM prices WHERE type = 'SkillGem' AND (name = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE) ORDER BY league, name, variant LIMIT 40").all(name, `${name} of %`);
  const findings = db.prepare('SELECT heading, written_at, scope, substr(body, 1, 600) AS excerpt FROM findings WHERE lower(heading) LIKE ? OR lower(body) LIKE ?').all(`%${v}%`, `%${v}%`);
  const sources = db.prepare('SELECT id, title, url, versions FROM sources WHERE lower(title) LIKE ? OR lower(topics) LIKE ? LIMIT 15').all(`%${v}%`, `%${v}%`).map(s => ({ ...s, versions: JSON.parse(s.versions) }));
  return { skill: name, warning: WARNING, builds, price_history_3_29: prices.map(priceRow), findings, sources,
    notes: ['builds.stale=true when the PoB is not 3.30; check changes get <skill> before reuse.', 'price_history_3_29 is Allflame (3.29) economy, not 3.30 and not popularity.'] };
}
const priceRow = p => ({ league: p.league, patch: p.patch, mode: p.mode, type: p.type, name: p.name, base_type: p.base_type, variant: p.variant, links: p.links,
  observations: p.observations, first_date: p.first_date, last_date: p.last_date, first_week_mean_chaos: round(p.first_week_mean_chaos), median_chaos: round(p.median_chaos), last_chaos: round(p.last_chaos), min_chaos: round(p.min_chaos), max_chaos: round(p.max_chaos) });
const round = x => x == null ? null : Math.round(x * 10) / 10;

export function metaCommand(args) {
  const [operation, ...rest] = args;
  const { positional, options } = flags(rest, ['tier', 'status', 'league', 'limit', 'version'], []);
  if (operation === 'build') throw new Error('meta build reads 300+ MB of CSV: run node scripts/meta.mjs build');
  const db = open();
  try {
    const limit = Number(options.limit ?? 20);
    if (operation === 'skill') { if (!positional.length) throw new Error('meta skill <name> required'); return metaSkill(positional.join(' '), db); }
    if (operation === 'builds') {
      const rows = db.prepare('SELECT * FROM builds ORDER BY tier, name').all().filter(r => (!options.tier || r.tier === options.tier) && (!options.status || r.patch_status === options.status)).map(buildRow);
      return { warning: WARNING, total: rows.length, results: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit) };
    }
    if (operation === 'item' || operation === 'price') {
      const name = positional.join(' ');
      if (!name) throw new Error('meta item <exact name> required');
      const rows = db.prepare('SELECT * FROM prices WHERE name = ? COLLATE NOCASE AND (? IS NULL OR league = ?) ORDER BY league, variant, links').all(name, options.league ?? null, options.league ?? null);
      return { warning: WARNING, name, total: rows.length, results: rows.slice(0, limit).map(priceRow), omitted: Math.max(0, rows.length - limit) };
    }
    if (operation === 'sources') {
      const rows = db.prepare('SELECT * FROM sources ORDER BY id').all().map(s => ({ ...s, versions: JSON.parse(s.versions), topics: JSON.parse(s.topics) }))
        .filter(s => !options.version || s.versions.includes(options.version)).filter(s => !positional.length || norm(`${s.title} ${s.topics.join(' ')}`).includes(norm(positional.join(' '))));
      return { warning: WARNING, total: rows.length, results: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit) };
    }
    if (operation === 'findings') {
      const v = norm(positional.join(' '));
      const rows = db.prepare('SELECT heading, level, written_at, scope, body FROM findings').all().filter(r => !v || norm(`${r.heading}\n${r.body}`).includes(v));
      return { warning: WARNING, total: rows.length, results: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit) };
    }
    if (operation === 'info') {
      const meta = Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map(r => [r.key, r.key === 'provenance' ? JSON.parse(r.value) : r.value]));
      return { ...meta, counts: Object.fromEntries(['builds', 'build_skills', 'sources', 'findings', 'prices'].map(t => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n])) };
    }
    throw new Error('Use meta skill|builds|item|sources|findings|info|build');
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  (args.length && args[0] !== 'build' ? Promise.resolve().then(() => metaCommand(args)) : buildMeta()).then(r => console.log(JSON.stringify(r, null, 2)), e => { console.error(e.message); process.exitCode = 1; });
}
