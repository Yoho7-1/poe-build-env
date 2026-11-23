// Ranking of evaluated candidates and price attachment. Pure logic over rows from analysis-core.evaluateCandidates.
const finite = v => typeof v === 'number' && Number.isFinite(v);

// Score = percentage gain of the chosen metric per unit of cost (passive points by default; cost 0 counts as 1).
export function rankRows(rows, { metric = 'dps', per = 'points', top = 10, requireFinite = true } = {}) {
  const ranked = [], excluded = [];
  for (const row of rows) {
    if (row.error) { excluded.push({ id: row.id, reason: 'calculation_error', detail: row.error }); continue; }
    const d = row.deltas?.[metric];
    if (!d || (requireFinite && !finite(d.pct) && !finite(d.abs))) { excluded.push({ id: row.id, reason: 'metric_unavailable' }); continue; }
    if (row.skill_disabled_reason) { excluded.push({ id: row.id, reason: 'skill_disabled', detail: row.skill_disabled_reason }); continue; }
    const units = per === 'none' ? 1 : Math.max(1, Number(row.cost?.[per] ?? 1));
    const gain = finite(d.pct) ? d.pct : null;
    ranked.push({ ...row, score: { metric, per, units, gain_pct: gain, gain_abs: d.abs, value: (gain ?? d.abs ?? 0) / units,
      basis: gain == null ? 'absolute delta per unit (baseline not positive)' : 'percent per unit' } });
  }
  if (ranked.some(r => r.score.gain_pct == null)) for (const r of ranked) { r.score.value = (r.score.gain_abs ?? 0) / r.score.units; r.score.basis = 'absolute delta per unit (baseline not positive)'; }
  ranked.sort((a, b) => b.score.value - a.score.value || (b.score.gain_abs ?? 0) - (a.score.gain_abs ?? 0) || String(a.id).localeCompare(String(b.id)));
  return { metric, per, top: ranked.slice(0, top).map((r, i) => ({ rank: i + 1, ...r })), total_ranked: ranked.length, excluded,
    note: 'Ranking of numeric engine deltas; not a game test. Inspect engine warnings, requirements and configuration of the top rows.' };
}

// Trade-offs: candidates that lose more than `tolerancePct` on a guarded metric are flagged, not hidden.
export function flagTradeoffs(rows, guards = { ehp: -3, maxhit: -3 }) {
  return rows.map(row => {
    const losses = Object.entries(guards).filter(([m, limit]) => finite(row.deltas?.[m]?.pct) && row.deltas[m].pct < limit)
      .map(([m]) => ({ metric: m, pct: row.deltas[m].pct }));
    return losses.length ? { ...row, tradeoffs: losses } : row;
  });
}

// Attach one price observation (output of `price get`) without converting across inconsistent currency sources.
export function attachPrice(row, quote) {
  if (!quote) return { ...row, price: { status: 'not_requested' } };
  const r = quote.results?.[0];
  if (!r) return { ...row, price: { status: 'no_observation', note: 'Unknown remains unknown; not free.' } };
  if (quote.variant_selection_required) return { ...row, price: { status: 'variant_required', matches: quote.total_matches } };
  const conflict = r.quote_warning?.code === 'inconsistent_currency_conversion';
  return { ...row, price: { status: 'observed', name: r.name, variant: r.variant?.variant ?? null, chaos: r.chaos ?? null, divine: r.variant?.divineValue ?? null,
    observed_at: r.observed_at, snapshot_id: r.snapshot_id, platform: r.platform, league: r.league,
    currency_conflict: conflict, comparable_in_chaos: !conflict,
    note: conflict ? 'Item-implied and currency-feed Chaos/Divine rates disagree; keep both estimates, do not total.' : 'Dated estimate, not a current offer.' } };
}

// Budget totals only when every priced row comes from one snapshot set without currency conflict.
export function budgetSummary(rows) {
  const priced = rows.filter(r => r.price?.status === 'observed');
  const unknown = rows.filter(r => r.price && r.price.status !== 'observed' && r.price.status !== 'not_requested').map(r => r.id);
  const conflicted = priced.filter(r => r.price.currency_conflict).map(r => r.id);
  const snapshots = [...new Set(priced.map(r => r.price.snapshot_id))];
  if (conflicted.length) return { total_chaos: null, reason: 'inconsistent_currency_conversion', conflicted, unknown, snapshots };
  if (unknown.length) return { total_chaos: null, reason: 'unknown_prices', unknown, snapshots };
  return { total_chaos: priced.reduce((s, r) => s + (r.price.chaos ?? 0), 0), snapshots, priced: priced.length,
    note: snapshots.length > 1 ? 'Several snapshots are combined; dates differ.' : 'One snapshot.' };
}

// Gain per chaos for priced rows; rows without a comparable price are listed separately.
export function rankByPrice(rows, metric = 'dps') {
  const ok = [], other = [];
  for (const r of rows) {
    const d = r.deltas?.[metric]?.pct;
    if (r.price?.status === 'observed' && r.price.comparable_in_chaos && r.price.chaos > 0 && finite(d)) ok.push({ id: r.id, gain_pct: d, chaos: r.price.chaos, pct_per_100c: d / r.price.chaos * 100 });
    else other.push({ id: r.id, reason: r.price?.status === 'observed' ? (r.price.comparable_in_chaos ? 'zero_or_missing_gain' : 'currency_conflict') : r.price?.status ?? 'not_priced' });
  }
  ok.sort((a, b) => b.pct_per_100c - a.pct_per_100c || a.id.localeCompare(b.id));
  return { metric, ranked: ok, not_comparable: other };
}
