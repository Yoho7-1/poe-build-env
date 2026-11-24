// Engine-backed analysis operations: Node Power, stat weights, upgrade ranking and boss survival from a build file.
// One baseline calculation fixes the calculation contract; every candidate must match it.
import fs from 'node:fs';
import path from 'node:path';
import { runPob } from './pob.mjs';
import { loadTree } from './tree-graph.mjs';
import { referenceDb, priceQuery } from './reference-store.mjs';
import { evaluateCandidates, cacheMisses, AnalysisCache } from './analysis-core.mjs';
import { rankRows, flagTradeoffs, attachPrice, budgetSummary, rankByPrice } from './analysis-rank.mjs';
import { packageInteraction } from './analysis-upgrades.mjs';
import { bossChanges, evaluateSurvival } from './analysis-bosses.mjs';
import { runBatch, batchRunner, runVariants, variantRunner, defaultConcurrency } from './analysis-engine.mjs';

const disclaimer = 'Numeric engine experiment; not a game test. Check configuration, requirements, engine warnings and the actual availability of every change.';

function baselineRun(file, scenario, changes) {
  const result = runPob({ input: fs.readFileSync(file), scenario, changes });
  if (!result.calculation_contract_sha256) throw new Error('Baseline calculation has no contract');
  return result;
}

function runCandidates({ file, scenario, baseline, candidates, kind, metricsWanted, concurrency, extract }) {
  const cache = new AnalysisCache();
  const pending = cacheMisses({ baseline, candidates, cache, kind });
  const batch = pending.length ? runBatch({ file, scenario, changesList: pending.map(c => c.changes), concurrency }) : { results: new Map(), elapsed_ms: 0, runs: 0, concurrency };
  const evaluated = evaluateCandidates({ baseline, candidates, runner: batchRunner(batch), metricsWanted, cache, kind, extract });
  const baseWarnings = new Set(baseline.engine_warnings ?? []);
  evaluated.rows = evaluated.rows.map(r => r.error ? r : { ...r, new_warnings: (r.engine_warnings ?? []).filter(w => !baseWarnings.has(w)) });
  return { ...evaluated, engine: { runs: batch.runs, concurrency: batch.concurrency, batch_elapsed_ms: batch.elapsed_ms } };
}

const compactRow = r => ({ rank: r.rank, id: r.id, label: r.label, cost: r.cost, score: r.score,
  deltas: Object.fromEntries(Object.entries(r.deltas ?? {}).map(([k, d]) => [k, { before: d.before, after: d.after, pct: d.pct == null ? null : Math.round(d.pct * 100) / 100 }])),
  tradeoffs: r.tradeoffs, review: /(keystone)/.test(r.label ?? '') ? 'Keystone: inspect the PoB condition it assumes (e.g. Elemental Overload is treated as active whenever crit chance > 0).' : undefined, new_warnings: r.new_warnings?.length ? r.new_warnings : undefined, path: r.extra?.path, price: r.price });


// Node Power through PoB itself: the engine lists unallocated notables/keystones within pathDist <= radius and
// evaluates each with its calculator (addNodes along node.path, as PoB's power report); a few processes in total.
export function analyzeNodes({ file, scenario = 'sustained', metric = 'dps', radius = 3, top = 10, include = 'notable', base = {}, concurrency = defaultConcurrency, limit = 500 }) {
  const started = Date.now();
  if (base.tree || base.jewels || base.sets || base.remove_nodes) throw new Error('analyze nodes evaluates the saved tree; apply tree edits with pob run --save-xml first');
  const baseline = baselineRun(file, scenario, base);
  const types = include === 'all' ? ['Notable', 'Keystone', 'Normal'] : ['Notable', 'Keystone'];
  const vr = runVariants({ file, scenario, base, nodePower: { max_dist: radius, types }, concurrency });
  const t = loadTree();
  const ids = [...vr.results.keys()].filter(id => id.startsWith('add:')).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))).slice(0, limit);
  const candidates = ids.map(id => { const node = t.nodes.get(Number(id.slice(4))); const v = vr.results.get(id);
    return { id: id.slice(4), label: `${node?.name ?? id} (${node?.type ?? 'node'})`, cost: { points: v.points }, changes: { variant: id, base }, meta: { path: (v.added_nodes ?? []).map(n => n.name) } }; });
  const evaluated = evaluateCandidates({ baseline, candidates, runner: variantRunner(vr), metricsWanted: ['dps', 'ehp', 'maxhit', 'life', 'mana_sustain'], cache: new AnalysisCache(), kind: 'nodes-v2',
    extract: r => ({ points: r.points, path: (r.added_nodes ?? []).map(n => n.name) }) });
  const rows = flagTradeoffs(evaluated.rows.map(r => ({ ...r, cost: r.extra?.points ? { points: r.extra.points } : r.cost })));
  const ranked = rankRows(rows, { metric, per: 'points', top });
  return { game: 'poe1', patch: '3.30', analysis: 'node_power', metric, scenario, radius, include,
    baseline: { calculation_id: baseline.calculation_id, values: evaluated.baseline_values, dps_basis: evaluated.dps_basis, contract: evaluated.contract, class: baseline.class },
    candidates: candidates.length, top: ranked.top.map(compactRow), excluded: ranked.excluded,
    timing: { total_ms: Date.now() - started, engine_runs: vr.runs, variants: vr.variants, concurrency, cache: evaluated.cache },
    assumptions: ['Candidates and paths come from PoB (pathDist, node.path); each is evaluated with the PoB calculator (addNodes) on top of the current tree; points beyond the budget are hypothetical.', 'Cost = nodes on the PoB path; small nodes on the path contribute to the gain.'],
    disclaimer };
}

export function analyzeStats({ file, scenario = 'sustained', metric = 'dps', candidates, base = {}, concurrency = defaultConcurrency }) {
  const started = Date.now();
  const baseline = baselineRun(file, scenario, base);
  const evaluated = runCandidates({ file, scenario, baseline, candidates, kind: 'stats', metricsWanted: ['dps', 'ehp', 'maxhit', 'life', 'mana_sustain'], concurrency });
  const ranked = rankRows(evaluated.rows, { metric, per: 'none', top: candidates.length });
  return { game: 'poe1', patch: '3.30', analysis: 'stat_weights', experiment: 'custom_mods', metric, scenario,
    baseline: { calculation_id: baseline.calculation_id, values: evaluated.baseline_values, dps_basis: evaluated.dps_basis, contract: evaluated.contract },
    weights: ranked.top.map(compactRow), excluded: ranked.excluded,
    timing: { total_ms: Date.now() - started, engine_runs: evaluated.engine.runs, cache: evaluated.cache },
    note: 'Gain per one synthetic unit added through PoB custom modifiers. Translate into realistic magnitudes of actual items/nodes before comparing.', disclaimer };
}

function quoteFor(price, db) {
  if (!price) return null;
  // price.filters (e.g. { links: 6 }) narrows variants that differ by links or gem level; variant stays exact.
  return priceQuery('get', price.name, db, { platform: price.platform ?? 'pc', limit: 1, history: false, filters: { ...(price.filters ?? {}), ...(price.variant ? { variant: price.variant } : {}) } });
}

export function analyzeUpgrades({ file, scenario = 'sustained', metric = 'dps', candidates, base = {}, top = 20, concurrency = defaultConcurrency }) {
  const started = Date.now();
  const withBase = candidates.map(c => ({ ...c, changes: { ...base, ...c.changes } }));
  const baseline = baselineRun(file, scenario, base);
  const evaluated = runCandidates({ file, scenario, baseline, candidates: withBase, kind: 'upgrades', metricsWanted: ['dps', 'ehp', 'maxhit', 'life', 'mana_sustain'], concurrency });
  const db = referenceDb(undefined, { readOnly: true });
  let rows;
  try {
    const byId = new Map(withBase.map(c => [c.id, c]));
    rows = evaluated.rows.map(r => {
      const c = byId.get(r.id);
      if (c.meta?.type === 'package') {
        const parts = c.meta.member_prices.map(p => attachPrice({ id: p.name }, quoteFor(p, db)));
        const summary = budgetSummary(parts);
        return { ...r, price: { status: summary.total_chaos == null ? summary.reason : 'observed', chaos: summary.total_chaos, comparable_in_chaos: summary.total_chaos != null, members: parts.map(p => p.price) } };
      }
      return attachPrice(r, quoteFor(c.price, db));
    });
  } finally { db.close(); }
  rows = flagTradeoffs(rows);
  const ranked = rankRows(rows, { metric, per: 'none', top });
  return { game: 'poe1', patch: '3.30', analysis: 'upgrades', metric, scenario,
    baseline: { calculation_id: baseline.calculation_id, values: evaluated.baseline_values, dps_basis: evaluated.dps_basis, contract: evaluated.contract },
    ranking: ranked.top.map(compactRow), excluded: ranked.excluded,
    by_price: rankByPrice(rows.filter(r => !r.error), metric), packages: packageInteraction(rows, metric),
    budget: budgetSummary(rows.filter(r => !r.error && r.meta?.type === 'single' && r.price?.status !== 'not_requested')),
    timing: { total_ms: Date.now() - started, engine_runs: evaluated.engine.runs, cache: evaluated.cache },
    note: 'Requirements: inspect new_warnings (unmet attributes, disabled skills). Prices are dated, variant-specific observations; totals are refused across currency conflicts.', disclaimer };
}

export function surviveFromFile({ file, scenario = 'sustained', profile, tier, base = {}, concurrency = defaultConcurrency }) {
  const runs = bossChanges(profile, tier, base);
  const batch = runBatch({ file, scenario, changesList: runs.map(r => r.changes), concurrency, full: true });
  const results = runs.map(r => { const res = batchRunner(batch)(r.changes); return res; });
  return { ...evaluateSurvival(profile, tier, results), timing: { engine_runs: batch.runs, batch_elapsed_ms: batch.elapsed_ms } };
}
