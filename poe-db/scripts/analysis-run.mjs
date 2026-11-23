// Engine-backed analysis operations: Node Power, stat weights, upgrade ranking and boss survival from a build file.
// One baseline calculation fixes the calculation contract; every candidate must match it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPob, decodeBuild } from './pob.mjs';
import { loadTree, readXmlSpec } from './tree-graph.mjs';
import { referenceDb, priceQuery } from './reference-store.mjs';
import { evaluateCandidates, cacheMisses, AnalysisCache } from './analysis-core.mjs';
import { rankRows, flagTradeoffs, attachPrice, budgetSummary, rankByPrice } from './analysis-rank.mjs';
import { nodeCandidates, notableOrKeystone } from './analysis-nodes.mjs';
import { packageInteraction } from './analysis-upgrades.mjs';
import { bossChanges, evaluateSurvival } from './analysis-bosses.mjs';
import { runBatch, batchRunner, defaultConcurrency } from './analysis-engine.mjs';

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

function withTempXml(file, fn) {
  const xml = decodeBuild(fs.readFileSync(file)).xml;
  const tmp = path.join(os.tmpdir(), `poe-analysis-${randomUUID()}.xml`);
  fs.writeFileSync(tmp, xml);
  try { return fn(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

export function analyzeNodes({ file, scenario = 'sustained', metric = 'dps', radius = 3, top = 10, include = 'notable', base = {}, concurrency = defaultConcurrency, limit = 200 }) {
  const started = Date.now();
  const t = loadTree();
  const spec = withTempXml(file, readXmlSpec);
  if (spec.treeVersion && spec.treeVersion !== '3_30') throw new Error(`Tree ${spec.treeVersion} is not 3_30; migrate first`);
  const cls = t.classes[spec.classId];
  if (!cls) throw new Error('Class of the active tree spec is unknown');
  const allocated = new Set([String(cls.start), ...spec.nodes.filter(id => { const n = t.nodes.get(id); return n && !n.ascendancy; }).map(String)]);
  const adjacency = new Map([...t.nodes].map(([id, n]) => [String(id), [...n.links].map(String)]));
  const info = new Map([...t.nodes].map(([id, n]) => [String(id), { name: n.name, kind: n.type, ascendancy: n.ascendancy,
    is_class_start: n.type === 'class_start', is_mastery: n.type === 'mastery', blocked: n.proxy || n.eligibility !== 'tree_defined' || n.type === 'ascendancy_start' }]));
  const filter = include === 'all' ? i => i.kind !== 'jewel_socket' : notableOrKeystone;
  const found = nodeCandidates({ allocated, adjacency, nodes: info, radius, include: filter, limit });
  const candidates = found.map(c => ({ id: c.id, label: `${c.name} (${c.kind})`, cost: c.cost, meta: { graph_path: c.path },
    changes: { ...base, tree: { ...(base.tree ?? {}), allocate: [Number(c.id)], allow_over_budget: true } } }));
  const baseline = baselineRun(file, scenario, base);
  const extract = r => { const a = r.edit_report?.tree?.allocated?.[0]; return a ? { points: a.points, path: a.path.map(p => p.name) } : null; };
  const evaluated = runCandidates({ file, scenario, baseline, candidates, kind: 'nodes', metricsWanted: ['dps', 'ehp', 'maxhit', 'life', 'mana_sustain'], concurrency, extract });
  // The engine path is authoritative for cost; the graph BFS only selects candidates.
  const rows = flagTradeoffs(evaluated.rows.map(r => r.extra?.points ? { ...r, cost: { points: r.extra.points, graph_points: r.cost?.points } } : r));
  const ranked = rankRows(rows, { metric, per: 'points', top });
  return { game: 'poe1', patch: '3.30', analysis: 'node_power', metric, scenario, radius, include,
    baseline: { calculation_id: baseline.calculation_id, values: evaluated.baseline_values, contract: evaluated.contract, class: cls.name },
    candidates: candidates.length, top: ranked.top.map(compactRow), excluded: ranked.excluded,
    timing: { total_ms: Date.now() - started, engine_runs: evaluated.engine.runs, concurrency: evaluated.engine.concurrency, cache: evaluated.cache },
    assumptions: ['Each candidate is added on top of the current tree with allow_over_budget: true (points beyond the budget are hypothetical).', 'Cost = points of the path PoB actually allocated; small nodes on the path contribute to the gain.'],
    disclaimer };
}

export function analyzeStats({ file, scenario = 'sustained', metric = 'dps', candidates, base = {}, concurrency = defaultConcurrency }) {
  const started = Date.now();
  const baseline = baselineRun(file, scenario, base);
  const evaluated = runCandidates({ file, scenario, baseline, candidates, kind: 'stats', metricsWanted: ['dps', 'ehp', 'maxhit', 'life', 'mana_sustain'], concurrency });
  const ranked = rankRows(evaluated.rows, { metric, per: 'none', top: candidates.length });
  return { game: 'poe1', patch: '3.30', analysis: 'stat_weights', experiment: 'custom_mods', metric, scenario,
    baseline: { calculation_id: baseline.calculation_id, values: evaluated.baseline_values, contract: evaluated.contract },
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
    baseline: { calculation_id: baseline.calculation_id, values: evaluated.baseline_values, contract: evaluated.contract },
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
