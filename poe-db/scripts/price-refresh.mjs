// Price snapshot freshness and explicit refresh (stage 4). `price status` reads the local SQLite only;
// `price refresh` is the single networked operation: it goes through source-cache (sha256 + raw bodies kept)
// and the existing normalizeOverview/importPrices path. Older snapshots stay in the table as history.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dbRoot, readJson, flags } from './workspace.mjs';
import { cachedSource } from './source-cache.mjs';
import { referenceDb, importPrices, reindexPriceVariants } from './reference-store.mjs';
import { normalizeOverview } from './fetch-economy.mjs';

// Same list and endpoints as fetch-economy.mjs main() (not exported there).
export const economyCategories = ['Currency', 'UniqueWeapon', 'UniqueArmour', 'UniqueAccessory', 'UniqueFlask', 'UniqueJewel', 'UniqueTincture', 'SkillGem', 'ClusterJewel', 'BaseType'];
export const leagueId = 'Covens';
export const leaguesUrl = 'https://poe.ninja/poe1/api/economy/leagues';
export const overviewUrl = (category, league = leagueId) =>
  `https://poe.ninja/poe1/api/economy/stash/current/${category === 'Currency' ? 'currency' : 'item'}/overview?league=${league}&type=${category}`;
export const defaultStaleDays = 3;
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = list => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- Freshness ----------
export function priceFreshness(db, { now = Date.now(), staleDays = defaultStaleDays, conversion = true } = {}) {
  if (!Number.isFinite(staleDays) || staleDays <= 0) throw new Error('stale threshold must be a positive number of days');
  const rows = db.prepare(`SELECT s.id, s.league, s.platform, s.category, s.observed_at, (SELECT COUNT(*) FROM price_snapshots o WHERE o.league=s.league AND o.platform=s.platform AND o.category=s.category) snapshots,
      (SELECT COUNT(*) FROM prices p WHERE p.snapshot_id=s.id) lines
    FROM price_snapshots s WHERE s.id=(SELECT l.id FROM price_snapshots l WHERE l.league=s.league AND l.platform=s.platform AND l.category=s.category ORDER BY julianday(l.observed_at) DESC, l.rowid DESC LIMIT 1)
    ORDER BY s.league, s.platform, s.category`).all();
  const groups = rows.map(r => {
    const ageHours = (now - Date.parse(r.observed_at)) / 3600000;
    return { league: r.league, platform: r.platform, category: r.category, newest_observed_at: r.observed_at, snapshot_id: r.id, lines: r.lines, snapshots_stored: r.snapshots,
      age_hours: round(ageHours), age_days: round(ageHours / 24, 2), stale: !(ageHours <= staleDays * 24) };
  });
  const result = { threshold_days: staleDays, checked_at: new Date(now).toISOString(), groups, stale_any: groups.some(g => g.stale) || !groups.length,
    stale_categories: groups.filter(g => g.stale).map(g => `${g.league}/${g.platform}/${g.category}`),
    oldest_newest_snapshot_at: groups.map(g => g.newest_observed_at).sort()[0] ?? null,
    time_basis: 'observed_at = HTTP response time of the collector; underlying market samples may be older.' };
  if (conversion) result.currency_conversion = currencyConsistency(db, groups);
  if (!groups.length) result.warning = 'No price snapshots stored.';
  else if (result.stale_any) result.warning = `Price snapshots older than ${staleDays} days: ${result.stale_categories.join(', ')}. Quotes are dated estimates; refresh with price refresh or treat as stale.`;
  return result;
}

// Item-implied chaos/divine (chaos / divineValue) against the Divine Orb line of the nearest Currency snapshot,
// same 25% rule as priceQuery. Reported per category; values are not merged into one rate.
export function currencyConsistency(db, groups) {
  const out = [];
  const divineAt = db.prepare("SELECT p.chaos, s.observed_at, s.id FROM prices p JOIN price_snapshots s ON s.id=p.snapshot_id WHERE p.name='Divine Orb' AND s.category='Currency' AND s.platform=? AND s.league=? AND julianday(s.observed_at) BETWEEN julianday(?)-1 AND julianday(?)+5.0/1440 ORDER BY ABS(julianday(s.observed_at)-julianday(?)), s.rowid DESC LIMIT 1");
  const implied = db.prepare("SELECT p.chaos / json_extract(p.variant_json,'$.divineValue') rate FROM prices p WHERE p.snapshot_id=? AND json_extract(p.variant_json,'$.divineValue')>=1");
  for (const g of groups) {
    if (g.category === 'Currency') continue;
    const rates = implied.all(g.snapshot_id).map(r => r.rate).filter(Number.isFinite);
    if (!rates.length) continue;
    const divine = divineAt.get(g.platform, g.league, g.newest_observed_at, g.newest_observed_at, g.newest_observed_at);
    const conflicts = divine?.chaos > 0 ? rates.filter(r => Math.abs(r / divine.chaos - 1) > 0.25).length : null;
    out.push({ league: g.league, platform: g.platform, category: g.category, compared_lines: rates.length, item_implied_chaos_per_divine_median: round(median(rates)),
      currency_feed_chaos_per_divine: divine?.chaos ?? null, currency_snapshot_id: divine?.id ?? null, conflicting_lines: conflicts,
      status: divine == null ? 'currency_snapshot_unavailable' : conflicts > 0 ? 'inconsistent_currency_conversion' : 'consistent' });
  }
  const flagged = out.filter(c => c.status === 'inconsistent_currency_conversion');
  return { code: flagged.length ? 'inconsistent_currency_conversion' : null, categories: out,
    note: flagged.length ? 'Item feeds imply a different chaos/divine rate than the Currency feed (>25% on some lines). Keep both source estimates; do not total Chaos and Divine quotes as one budget.' : 'No conversion conflict above 25% in the latest snapshots.' };
}

// Attach a staleness warning to a priceQuery() result (or any {results:[{category,platform,league}]}).
export function attachFreshness(priceResult, freshness) {
  const key = r => `${r.league}/${r.platform}/${r.category}`;
  const byKey = new Map(freshness.groups.map(g => [key(g), g]));
  const results = (priceResult.results ?? []).map(r => {
    const g = byKey.get(key(r));
    const stale = g ? g.stale : true;
    return { ...r, freshness: { snapshot_newest_for_category: g?.newest_observed_at ?? null, quote_is_latest_snapshot: g ? g.snapshot_id === r.snapshot_id : null, stale,
      warning: stale ? `Snapshot older than ${freshness.threshold_days} days (or unknown); treat as a stale estimate.` : undefined } };
  });
  return { ...priceResult, results, freshness_threshold_days: freshness.threshold_days, stale_any: results.some(r => r.freshness.stale) };
}

// ---------- Refresh ----------
function cacheState(url) {
  const meta = path.join(dbRoot, 'cache/research', `${createHash('sha256').update(url).digest('hex')}.json`);
  if (!fs.existsSync(meta)) return { cached: false, would_fetch: true };
  const m = readJson(meta);
  const maxAge = Math.max(900000, Number(m.cache_control?.match(/(?:^|,)\s*max-age=(\d+)/)?.[1] ?? 0) * 1000);
  const age = Date.now() - Date.parse(m.checked_at);
  return { cached: true, obtained_at: m.obtained_at, checked_at: m.checked_at, sha256: m.sha256, would_fetch: !(age < maxAge) };
}
export function parseCategories(text) {
  if (text == null) return economyCategories;
  const wanted = text.split(',').map(s => s.trim()).filter(Boolean);
  const unknown = wanted.filter(c => !economyCategories.includes(c));
  if (unknown.length || !wanted.length) throw new Error(`Unknown categories: ${unknown.join(', ') || '(none)'}; use ${economyCategories.join(',')}`);
  return economyCategories.filter(c => wanted.includes(c));
}

export async function refreshPrices({ categories = economyCategories, dryRun = false, db: givenDb = null, source = cachedSource, delayMs = 1100 } = {}) {
  if (dryRun) {
    const db = givenDb ?? referenceDb(undefined, { readOnly: true });
    try {
      return { dry_run: true, network_used: false, league: leagueId, platform: 'pc', plan: [{ url: leaguesUrl, ...cacheState(leaguesUrl) }, ...categories.map(c => ({ category: c, url: overviewUrl(c), ...cacheState(overviewUrl(c)) }))],
        freshness_before: priceFreshness(db, { conversion: false }), note: 'No network request and no database write. would_fetch=false means source-cache would reuse the stored body (minimum 15 min / server max-age).' };
    } finally { if (!givenDb) db.close(); }
  }
  const lock = path.join(dbRoot, 'cache/price-refresh.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error(`Another price refresh holds ${path.relative(dbRoot, lock)}; remove it only if no refresh is running.`); }
  const db = givenDb ?? referenceDb();
  const report = { dry_run: false, network_used: true, league: 'Covens of Umbra', api_league_id: leagueId, platform: 'pc', started_at: new Date().toISOString(), categories: [], errors: [], sources: [] };
  try {
    let leagues;
    try {
      const l = await source(leaguesUrl);
      report.sources.push(l.metadata);
      leagues = JSON.parse(l.bytes.toString('utf8'));
    } catch (error) { report.errors.push({ stage: 'leagues', error: error.message }); return finish(); }
    if (!Array.isArray(leagues) || !leagues.some(l => l.id === leagueId && l.name === leagueId)) {
      report.errors.push({ stage: 'leagues', error: `League id ${leagueId} is not in the advertised economy league list; refresh stopped without guessing a replacement.`,
        advertised: Array.isArray(leagues) ? leagues.map(l => ({ id: l.id ?? null, name: l.name ?? null })).slice(0, 20) : null });
      return finish();
    }
    for (const category of categories) {
      try {
        const data = await source(overviewUrl(category));
        report.sources.push(data.metadata);
        const normalized = normalizeOverview(JSON.parse(data.bytes.toString('utf8')), { category, source: data.metadata, leagueId });
        const snapshot = normalized.snapshot;
        const id = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
        const stored = db.prepare('SELECT id FROM price_snapshots WHERE id=?').get(id);
        const result = stored ? { snapshot_id: id, records: snapshot.lines.length, already_imported: true } : { ...importPrices(snapshot, db), already_imported: false };
        report.categories.push({ category, ...result, observed_at: snapshot.observed_at, excluded: normalized.excluded.length, cache_hit: data.cache_hit, source_sha256: data.metadata.sha256 });
        if (!data.cache_hit && delayMs) await new Promise(r => setTimeout(r, delayMs));
      } catch (error) { report.errors.push({ stage: category, error: error.message }); }
    }
    if (report.categories.some(c => !c.already_imported)) reindexPriceVariants(db);
    return finish();
  } finally {
    if (!givenDb) db.close();
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
  function finish() {
    report.finished_at = new Date().toISOString();
    report.added_snapshots = report.categories.filter(c => !c.already_imported).length;
    report.added_observations = report.categories.filter(c => !c.already_imported).reduce((n, c) => n + c.records, 0);
    report.ok = !report.errors.length;
    report.freshness_after = priceFreshness(db);
    report.limitations = ['Estimates and dated observations, not offers or acquisition proof.', 'Older snapshots are kept; price get uses the latest per category, --history shows all.', 'Rare items are not priced (no trade API access).'];
    return report;
  }
}

// ---------- CLI ----------
export function priceCommand(rest) {
  const [operation, ...args] = rest;
  if (operation === 'status') {
    const { options } = flags(args, ['stale-days'], []);
    const db = referenceDb(undefined, { readOnly: true });
    try { return priceFreshness(db, { staleDays: options['stale-days'] == null ? defaultStaleDays : Number(options['stale-days']) }); } finally { db.close(); }
  }
  if (operation === 'refresh') {
    const { options } = flags(args, ['categories'], ['dry-run']);
    return refreshPrices({ categories: parseCategories(options.categories), dryRun: !!options['dry-run'] });
  }
  throw new Error('Use price status [--stale-days N] | price refresh [--categories a,b] [--dry-run]');
}
export const priceOperations = new Set(['status', 'refresh']);
export const priceHelp = {
  'price status [--stale-days 3]': 'Offline: newest snapshot age per league/platform/category, stale flag, inconsistent_currency_conversion check',
  'price refresh [--categories Currency,UniqueArmour,...] [--dry-run]': 'Network (poe.ninja economy API via source-cache): import new Covens/PC snapshots, keep old ones as history; --dry-run shows the plan without network'
};
