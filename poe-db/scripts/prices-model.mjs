// WP11 p. 3: one answer to "what does this component cost", for every component the generator and
// `design optimize` can add: uniques, skill gems, currency, cluster jewels, rare items.
//
// Sources are only the dated local snapshots already imported by fetch-economy.mjs / `price refresh`
// (poe.ninja economy API, league Covens of Umbra, platform pc). Nothing here touches the network:
// `networkPlan()` only describes what a refresh would need and what the user still has to decide.
//
// Every quote carries {source, date, platform, confidence} and a cost class:
//   exact     — a dated observation for this very component/variant exists in a snapshot;
//   estimated — derived by a stated rule from snapshot data (cluster group, rare affix band);
//   unknown   — no data. Never 0, never silently merged with exact numbers.
//
// Chaos and Divine are kept as the source reported them. Snapshots whose item-implied chaos/divine
// rate conflicts with the Currency feed (project-known conflict, ~190 vs ~116) are never totalled:
// quoteBundle() reports exact and estimated separately and refuses a single divine total when the
// categories it touched are flagged inconsistent.
import { referenceDb } from './reference-store.mjs';
import { priceFreshness, currencyConsistency, defaultStaleDays, economyCategories } from './price-refresh.mjs';

export const LEAGUE = 'Covens of Umbra';
export const DEFAULT_PLATFORM = 'pc';
export const UNIQUE_CATEGORIES = ['UniqueWeapon', 'UniqueArmour', 'UniqueAccessory', 'UniqueFlask', 'UniqueJewel', 'UniqueTincture'];
export const COMPONENT_KINDS = ['unique', 'gem', 'currency', 'cluster', 'rare'];

// Which economy categories of the project's allowed poe.ninja endpoints cover which component kind.
export const KIND_CATEGORIES = {
  unique: UNIQUE_CATEGORIES,
  gem: ['SkillGem'],
  currency: ['Currency'],
  cluster: ['ClusterJewel'],
  rare: ['BaseType'], // base only: no feed prices a finished rare item
};

// Rule for rares (no feed exists): affix difficulty band over the dated base price.
// These multipliers are an explicit model assumption, not an observation — hence confidence 'low'
// and cost_class 'estimated'. Bands are chosen so that a plain 6-mod rare with no top tiers stays
// near its base price and a multi-T1 influenced item lands one to two orders above it.
export const RARE_BANDS = [
  { band: 'base_only', max_score: 0, multiplier: [1, 1.5] },
  { band: 'cheap', max_score: 3, multiplier: [1.5, 5] },
  { band: 'moderate', max_score: 7, multiplier: [5, 25] },
  { band: 'expensive', max_score: 12, multiplier: [25, 120] },
  { band: 'extreme', max_score: Infinity, multiplier: [120, 600] },
];
export const RARE_WEIGHTS = { t1: 3, t2: 2, other_natural: 1, fractured: 2, crafted: 0.5, influence: 1 };

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = list => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const normalize = text => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function openPriceDb(filename) { return referenceDb(filename, { readOnly: true }); }

// ---------- snapshot access ----------
// Latest snapshot per (league, platform, category) — the same selection priceQuery() uses without --history.
export function latestSnapshots(db, { platform = DEFAULT_PLATFORM, league = LEAGUE } = {}) {
  const rows = db.prepare(`SELECT s.id, s.category, s.observed_at, s.source_url FROM price_snapshots s
    WHERE s.platform=? AND s.league=? AND s.id=(SELECT l.id FROM price_snapshots l WHERE l.league=s.league AND l.platform=s.platform AND l.category=s.category
      ORDER BY julianday(l.observed_at) DESC, l.rowid DESC LIMIT 1) ORDER BY s.category`).all(platform, league);
  return new Map(rows.map(r => [r.category, r]));
}

function linesOf(db, snapshotId, { name = null } = {}) {
  const sql = `SELECT p.name, p.chaos, p.variant_json FROM prices p WHERE p.snapshot_id=?${name == null ? '' : ' AND p.name=? COLLATE NOCASE'} ORDER BY p.ordinal`;
  const rows = name == null ? db.prepare(sql).all(snapshotId) : db.prepare(sql).all(snapshotId, name);
  return rows.map(({ variant_json, ...row }) => ({ ...row, variant: JSON.parse(variant_json) }));
}

function ageHours(observedAt, now) { return (now - Date.parse(observedAt)) / 3600000; }

// count = number of source observations behind the line; stale snapshots can never be 'high'.
export function lineConfidence(line, { stale, count = line?.variant?.count } = {}) {
  const n = Number.isFinite(count) ? count : null;
  if (n == null) return 'low';
  if (stale) return n >= 10 ? 'medium' : 'low';
  return n >= 10 ? 'high' : n >= 3 ? 'medium' : 'low';
}

function quote(fields) {
  return {
    cost_class: 'unknown', chaos: null, divine: null, chaos_range: null,
    source: null, date: null, platform: null, league: null, category: null,
    confidence: null, method: null, basis: [], warnings: [], ...fields,
  };
}

function unknown(component, reason, extra = {}) {
  return quote({ component, cost_class: 'unknown', confidence: null, method: 'no_data', warnings: [{ code: 'no_price_data', detail: reason }], ...extra });
}

function fromLine(component, line, snapshot, { platform, league, stale, method = 'snapshot_exact_variant', basis = [] }) {
  return quote({
    component, cost_class: 'exact', chaos: round(line.chaos), divine: Number.isFinite(line.variant?.divineValue) ? round(line.variant.divineValue, 3) : null,
    source: `poe.ninja economy ${snapshot.category} snapshot ${snapshot.id.slice(0, 12)}`, source_url: snapshot.source_url,
    date: snapshot.observed_at, platform, league, category: snapshot.category,
    confidence: lineConfidence(line, { stale }), method,
    snapshot_id: snapshot.id, variant: line.variant, observations: line.variant?.count ?? null,
    basis: [`matched line "${line.name}"`, ...basis],
    warnings: stale ? [{ code: 'stale_snapshot', detail: 'Snapshot older than the freshness threshold; a dated estimate, not a current offer.' }] : [],
  });
}

// ---------- context ----------
export function priceContext({ db, platform = DEFAULT_PLATFORM, league = LEAGUE, now = Date.now(), staleDays = defaultStaleDays } = {}) {
  if (!db) throw new Error('priceContext needs an open reference db (openPriceDb())');
  const freshness = priceFreshness(db, { now, staleDays, conversion: false });
  const stale = new Map(freshness.groups.filter(g => g.platform === platform && g.league === league).map(g => [g.category, g.stale]));
  const conversion = currencyConsistency(db, freshness.groups.filter(g => g.platform === platform && g.league === league));
  const inconsistent = new Set(conversion.categories.filter(c => c.status === 'inconsistent_currency_conversion').map(c => c.category));
  return { db, platform, league, now, staleDays, snapshots: latestSnapshots(db, { platform, league }), stale, conversion, inconsistent_categories: inconsistent };
}

function snapshotFor(ctx, category) {
  const snapshot = ctx.snapshots.get(category);
  return snapshot ? { snapshot, stale: ctx.stale.get(category) ?? true } : null;
}

// ---------- named feed components: unique / gem / currency ----------
function matchesVariant(line, filters) {
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value == null) continue;
    const actual = line.variant?.[key];
    if (typeof value === 'boolean' ? Boolean(actual) !== value : normalize(actual) !== normalize(value)) return false;
  }
  return true;
}

export function quoteNamed(component, ctx) {
  const categories = KIND_CATEGORIES[component.kind] ?? [];
  const filters = { variant: component.variant ?? null, baseType: component.base_type ?? null, corrupted: component.corrupted ?? null,
    links: component.links ?? null, gemLevel: component.gem_level ?? null, gemQuality: component.gem_quality ?? null };
  const seen = [];
  for (const category of categories) {
    const found = snapshotFor(ctx, category);
    if (!found) continue;
    const lines = linesOf(ctx.db, found.snapshot.id, { name: component.name });
    if (!lines.length) continue;
    seen.push(category);
    const exact = lines.filter(line => matchesVariant(line, filters));
    if (exact.length) {
      const cheapest = exact.reduce((a, b) => (b.chaos < a.chaos ? b : a));
      const q = fromLine(component, cheapest, found.snapshot, { platform: ctx.platform, league: ctx.league, stale: found.stale });
      if (exact.length > 1) q.warnings.push({ code: 'variant_selection_required', detail: `${exact.length} lines match; the cheapest is quoted. Narrow with variant/corrupted/links/gem level.` });
      return q;
    }
    // Name is priced but the asked-for variant is not: a group estimate, kept apart from exact.
    const values = lines.map(l => l.chaos);
    return quote({
      component, cost_class: 'estimated', chaos: round(median(values)), chaos_range: [round(Math.min(...values)), round(Math.max(...values))],
      source: `poe.ninja economy ${category} snapshot ${found.snapshot.id.slice(0, 12)} (variant group)`, source_url: found.snapshot.source_url,
      date: found.snapshot.observed_at, platform: ctx.platform, league: ctx.league, category, snapshot_id: found.snapshot.id,
      confidence: 'low', method: 'rule:median_of_name_variants', observations: lines.length,
      basis: [`no line matches the requested variant ${JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null)))}`,
        `median over ${lines.length} priced variants of "${component.name}"`],
      warnings: [{ code: 'variant_not_priced', detail: 'Requested variant is absent from the snapshot; median over the item\'s other variants.' },
        ...(found.stale ? [{ code: 'stale_snapshot', detail: 'Snapshot older than the freshness threshold.' }] : [])],
    });
  }
  return unknown(component, seen.length ? `"${component.name}" has no priced line in ${seen.join(', ')}`
    : `No ${categories.join('/')} snapshot for ${ctx.platform}/${ctx.league}, or "${component.name}" is not in the feed`);
}

// ---------- cluster jewels ----------
// The ClusterJewel feed is keyed by enchant text + "<N> passives" on a Large/Medium/Small base,
// which is exactly what the generator picks, so most cluster layers get an exact quote.
export function clusterBaseType(component) {
  const size = normalize(component.size ?? component.base_type);
  if (/large/.test(size)) return 'Large Cluster Jewel';
  if (/medium/.test(size)) return 'Medium Cluster Jewel';
  if (/small/.test(size)) return 'Small Cluster Jewel';
  return null;
}

export function quoteCluster(component, ctx) {
  const found = snapshotFor(ctx, 'ClusterJewel');
  if (!found) return unknown(component, `No ClusterJewel snapshot for ${ctx.platform}/${ctx.league}`);
  const base = clusterBaseType(component);
  const passives = Number.isFinite(component.passives) ? component.passives : null;
  const enchant = component.enchant ?? component.name ?? null;
  const all = linesOf(ctx.db, found.snapshot.id);
  const sameBase = base ? all.filter(l => normalize(l.variant?.baseType) === normalize(base)) : all;
  const sameSlot = passives == null ? sameBase : sameBase.filter(l => normalize(l.variant?.variant) === `${passives} passives`);
  if (enchant) {
    const exact = sameSlot.filter(l => normalize(l.name) === normalize(enchant));
    if (exact.length) {
      const cheapest = exact.reduce((a, b) => (b.chaos < a.chaos ? b : a));
      return fromLine(component, cheapest, found.snapshot, { platform: ctx.platform, league: ctx.league, stale: found.stale,
        basis: [`${base ?? 'any base'} / ${passives == null ? 'any' : passives} passives`] });
    }
  }
  // Enchant (or its passive count) not in the feed: median of the same base and passive count.
  const pool = sameSlot.length ? sameSlot : sameBase;
  if (!pool.length) return unknown(component, `ClusterJewel snapshot has no line for ${base ?? 'this base'}${passives == null ? '' : ` / ${passives} passives`}`);
  const values = pool.map(l => l.chaos);
  return quote({
    component, cost_class: 'estimated', chaos: round(median(values)), chaos_range: [round(Math.min(...values)), round(Math.max(...values))],
    source: `poe.ninja economy ClusterJewel snapshot ${found.snapshot.id.slice(0, 12)} (group median)`, source_url: found.snapshot.source_url,
    date: found.snapshot.observed_at, platform: ctx.platform, league: ctx.league, category: 'ClusterJewel', snapshot_id: found.snapshot.id,
    confidence: pool.length >= 10 ? 'medium' : 'low', method: 'rule:median_of_cluster_group', observations: pool.length,
    basis: [enchant ? `enchant "${enchant}" is not priced in this snapshot` : 'no enchant given',
      `median over ${pool.length} lines of ${base ?? 'all bases'}${sameSlot.length ? `${passives == null ? '' : ` / ${passives} passives`}` : ' (any passive count)'}`],
    warnings: [{ code: 'enchant_not_priced', detail: 'Group median across cluster enchants; a specific notable can cost far more or less.' },
      ...(found.stale ? [{ code: 'stale_snapshot', detail: 'Snapshot older than the freshness threshold.' }] : [])],
  });
}

// ---------- rare items ----------
// Score counts how hard the affix set is, from data the appraiser already produces (RePoE tiers),
// not from a guess about the market: T1 count, T1–T2 count, other natural affixes, fractured,
// crafted, influence affixes.
export function rareAffixScore(affixes = {}) {
  const t1 = Number(affixes.t1 ?? affixes.natural_t1 ?? 0);
  const t12 = Number(affixes.t1_t2 ?? affixes.natural_t1_t2 ?? t1);
  const count = Number(affixes.count ?? affixes.natural_count ?? Math.max(t12, 0));
  const t2 = Math.max(0, t12 - t1), other = Math.max(0, count - t12);
  const fractured = Number(affixes.fractured ?? 0), crafted = Number(affixes.crafted ?? 0), influence = Number(affixes.influence ?? 0);
  const score = t1 * RARE_WEIGHTS.t1 + t2 * RARE_WEIGHTS.t2 + other * RARE_WEIGHTS.other_natural
    + fractured * RARE_WEIGHTS.fractured + crafted * RARE_WEIGHTS.crafted + influence * RARE_WEIGHTS.influence;
  const band = RARE_BANDS.find(b => score <= b.max_score) ?? RARE_BANDS.at(-1);
  return { score: round(score), parts: { t1, t2, other, fractured, crafted, influence }, band: band.band, multiplier: band.multiplier };
}

// Base price: the BaseType feed is keyed by base name + influence variant + required level.
// Pick the lines of the asked influence whose levelRequired is closest to (and not above) the item level.
function baseLines(ctx, component, snapshot) {
  const lines = linesOf(ctx.db, snapshot.id, { name: component.base ?? component.base_type ?? component.name });
  if (!lines.length) return { lines: [], note: 'base not in the BaseType feed' };
  const wanted = component.influence == null ? null : normalize(Array.isArray(component.influence) ? component.influence.join('/') : component.influence);
  const byInfluence = wanted == null ? lines.filter(l => l.variant?.variant == null) : lines.filter(l => normalize(l.variant?.variant) === wanted);
  const pool = byInfluence.length ? byInfluence : lines;
  const ilvl = Number.isFinite(component.item_level) ? component.item_level : null;
  if (ilvl == null) return { lines: pool, note: byInfluence.length ? 'influence matched, any item level' : 'influence not matched, all variants of the base' };
  const atOrBelow = pool.filter(l => Number.isFinite(l.variant?.levelRequired) && l.variant.levelRequired <= ilvl);
  if (!atOrBelow.length) return { lines: pool, note: 'no line at or below the requested item level; all variants used' };
  const best = Math.max(...atOrBelow.map(l => l.variant.levelRequired));
  return { lines: atOrBelow.filter(l => l.variant.levelRequired === best), note: `item level ${best} lines (requested ${ilvl})` };
}

export function quoteRare(component, ctx) {
  const found = snapshotFor(ctx, 'BaseType');
  const affixes = rareAffixScore(component.affixes ?? {});
  if (!found) return unknown(component, `No BaseType snapshot for ${ctx.platform}/${ctx.league}; rare items have no feed of their own`, { affix_band: affixes });
  const { lines, note } = baseLines(ctx, component, found.snapshot);
  if (!lines.length) {
    return unknown(component, `"${component.base ?? component.name}" is not in the BaseType feed; the affix band alone gives no currency value`,
      { affix_band: affixes, category: 'BaseType', date: found.snapshot.observed_at, platform: ctx.platform, league: ctx.league });
  }
  const basePrice = median(lines.map(l => l.chaos));
  const observations = lines.reduce((n, l) => n + (Number(l.variant?.count) || 0), 0);
  const [lo, hi] = affixes.multiplier;
  return quote({
    component, cost_class: 'estimated', chaos: round(basePrice * (lo + hi) / 2), chaos_range: [round(basePrice * lo), round(basePrice * hi)],
    source: `rule over poe.ninja economy BaseType snapshot ${found.snapshot.id.slice(0, 12)}`, source_url: found.snapshot.source_url,
    date: found.snapshot.observed_at, platform: ctx.platform, league: ctx.league, category: 'BaseType', snapshot_id: found.snapshot.id,
    confidence: 'low', method: 'rule:affix_tier_band_over_base_price', observations: observations || null,
    base_price_chaos: round(basePrice), affix_band: affixes,
    basis: [`base price from ${lines.length} BaseType line(s): ${note}`,
      `affix score ${affixes.score} (T1 ${affixes.parts.t1}, T2 ${affixes.parts.t2}, other ${affixes.parts.other}, fractured ${affixes.parts.fractured}, crafted ${affixes.parts.crafted}, influence ${affixes.parts.influence}) → band ${affixes.band}`,
      `band multiplier ${lo}–${hi}× the base price (model assumption, not an observation)`],
    warnings: [{ code: 'rare_price_modelled', detail: 'No feed prices finished rare items. Base price is dated data; the affix multiplier is this module\'s stated rule. Use the band, not the midpoint, and check comparable listings manually (item appraise gives the filters).' },
      ...(found.stale ? [{ code: 'stale_snapshot', detail: 'Snapshot older than the freshness threshold.' }] : [])],
  });
}

// ---------- dispatcher ----------
export function quoteComponent(component, ctx) {
  if (!component || typeof component !== 'object') throw new Error('component object required');
  const kind = component.kind;
  if (!COMPONENT_KINDS.includes(kind)) throw new Error(`Unknown component kind ${kind}; use ${COMPONENT_KINDS.join('|')}`);
  if (kind === 'cluster') return quoteCluster(component, ctx);
  if (kind === 'rare') return quoteRare(component, ctx);
  if (!component.name) throw new Error(`${kind} component needs a name`);
  return quoteNamed(component, ctx);
}

// Totals: exact and estimated never merge, unknown is counted, not zeroed. A divine total is given
// only when no touched category is flagged inconsistent_currency_conversion.
export function quoteBundle(components, ctx) {
  const quotes = components.map(c => quoteComponent(c, ctx));
  const exact = quotes.filter(q => q.cost_class === 'exact'), estimated = quotes.filter(q => q.cost_class === 'estimated'), unknowns = quotes.filter(q => q.cost_class === 'unknown');
  const categories = [...new Set(quotes.map(q => q.category).filter(Boolean))];
  const conflicted = categories.filter(c => ctx.inconsistent_categories.has(c));
  const divineKnown = exact.every(q => q.divine != null);
  const dates = quotes.map(q => q.date).filter(Boolean).sort();
  return {
    quotes, platform: ctx.platform, league: ctx.league, categories,
    exact: { count: exact.length, chaos: exact.length ? round(exact.reduce((n, q) => n + q.chaos, 0)) : null,
      divine: conflicted.length || !divineKnown || !exact.length ? null : round(exact.reduce((n, q) => n + q.divine, 0), 3) },
    estimated: { count: estimated.length, chaos_range: estimated.length
      ? [round(estimated.reduce((n, q) => n + (q.chaos_range?.[0] ?? q.chaos ?? 0), 0)), round(estimated.reduce((n, q) => n + (q.chaos_range?.[1] ?? q.chaos ?? 0), 0))] : null },
    unknown: { count: unknowns.length, components: unknowns.map(q => q.component?.name ?? q.component?.base ?? q.component?.enchant ?? q.component?.kind ?? null) },
    oldest_snapshot_at: dates[0] ?? null, newest_snapshot_at: dates.at(-1) ?? null,
    conversion: { conflicted_categories: conflicted, code: conflicted.length ? 'inconsistent_currency_conversion' : null,
      note: conflicted.length ? 'Item feeds and the Currency feed imply different chaos/divine rates; chaos and divine quotes are not totalled as one budget.' : ctx.conversion.note },
    note: 'Exact and estimated totals are separate on purpose. Unknown components are missing from both totals, not counted as free.',
  };
}

// ---------- network path (explicit, nothing is fetched here) ----------
export function networkPlan({ staleDays = defaultStaleDays } = {}) {
  return {
    network_used: false,
    refresh_command: 'node poe-db/scripts/agent.mjs price refresh [--categories ...] [--dry-run]',
    allowed_categories: economyCategories,
    covers: KIND_CATEGORIES,
    not_available: ['Finished rare items (no trade API access under the project rules; only BaseType covers the base).',
      'Any platform other than the one the collector requests (feed is per league/platform).'],
    user_decisions: ['profile.platform is null: the market platform (pc / console) must be chosen before a budget is binding.',
      'Network access needs explicit user permission for each refresh.',
      `Freshness threshold in use: ${staleDays} days.`],
  };
}
