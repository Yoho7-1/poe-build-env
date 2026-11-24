// Benchmark tasks for calibration (3A.9, 3A.11, 17): predict before the engine answers, then score locally.
// Task kind ablation_tiers: a sample of build components (supports, skill groups, items, passive nodes, config
// assumptions). The task stores only ids and labels: the truth does not exist until `score` runs the ablation for
// exactly these components, so it cannot leak into the prediction. Predictions are frozen once scored. The agent is
// compared with deterministic baselines; improvement means beating them on unseen builds, not a bigger ledger.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { flags, readJson } from './workspace.mjs';
import { createRecord, mutateRecord, getRecord, loadLedger, defaultLedger } from './lab.mjs';
import { analyzeAblation, defaultThresholds } from './analysis-ablation.mjs';
import { trainTierModel, qualityAblationRows, predictTier } from './corpus-learn.mjs';

export const tiers = ['negligible', 'removal_improves', 'minor', 'major', 'core'];
const level = t => ({ negligible: 0, removal_improves: 0, minor: 1, major: 2, core: 3 })[t];

// Deterministic stratified sample: round-robin over component kinds, order inside a kind by a seeded hash.
// exclude: component ids already used by other tasks of the same build (disjoint batches).
export function sampleComponents(components, n, seed = 'b1', exclude = new Set()) {
  const byKind = new Map();
  const key = c => createHash('sha256').update(`${seed}:${c.id}`).digest('hex');
  for (const c of [...components].filter(c => !exclude.has(c.id)).sort((a, b) => key(a).localeCompare(key(b)))) { if (!byKind.has(c.kind)) byKind.set(c.kind, []); byKind.get(c.kind).push(c); }
  const out = [];
  const kinds = [...byKind.keys()].sort();
  while (out.length < n && kinds.some(k => byKind.get(k).length)) for (const k of kinds) { if (out.length < n && byKind.get(k).length) out.push(byKind.get(k).shift()); }
  return out.map(c => ({ id: c.id, kind: c.kind, label: c.label, target: c.target }));
}

// Deterministic baselines the agent has to beat.
export const baselines = {
  all_minor: () => 'minor',
  kind_prior: c => {
    if (c.kind === 'supports' || c.kind === 'skills') return 'major';
    if (c.kind === 'config') return 'negligible';
    if (c.kind === 'items') return String(c.target?.rarity).toUpperCase() === 'UNIQUE' ? 'major' : /Flask/.test(c.target?.slot ?? '') ? 'negligible' : 'minor';
    if (c.kind === 'tree') return c.target?.type === 'keystone' || c.target?.ascendancy ? 'major' : c.target?.type === 'mastery' ? 'negligible' : 'minor';
    return 'minor';
  }
};

// Empirical baseline: tier frequencies learned from corpus ablations (quality-filtered), trained without the benchmarked build.
// in_training: whether the benchmarked build was among the training rows before its exclusion (false = held out by the
// quality filter or outside the corpus; true = only its own ablation was dropped, the build is a corpus training build).
export function empiricalBaseline(excludeSha, rowsLoader = qualityAblationRows) {
  const all = rowsLoader({});
  const rows = excludeSha ? all.filter(r => r.build !== excludeSha) : all;
  if (!rows.length) return null;
  const model = trainTierModel(rows);
  return { fn: c => predictTier(model, c).tier, trained_on: { builds: model.builds, components: model.rows, excluded_input_sha256: excludeSha, in_training: !!excludeSha && rows.length !== all.length } };
}
// Loads training rows once for a batch (each task still excludes its own build).
export const cachedRows = rowsLoader => { let rows = null; return () => (rows ??= rowsLoader({})); };
function baselineScores(components, truth, excludeSha, rowsLoader) {
  const fns = { ...baselines };
  const emp = empiricalBaseline(excludeSha, rowsLoader);
  if (emp) fns.empirical = emp.fn;
  const predictions = Object.fromEntries(Object.entries(fns).map(([k, fn]) => [k, Object.fromEntries(components.map(c => [c.id, fn(c)]))]));
  const scores = Object.fromEntries(Object.entries(predictions).map(([k, p]) => { const v = scoreTiers(components, truth, p); return [k, { exact: v.exact, within_one: v.within_one }]; }));
  return { scores, predictions, empirical: emp?.trained_on ?? null };
}

export function scoreTiers(components, truth, predicted) {
  const rows = components.map(c => {
    const t = truth[c.id], p = predicted[c.id];
    return { id: c.id, truth: t, predicted: p, exact: t === p, within_one: t != null && p != null && Math.abs(level(t) - level(p)) <= 1 };
  });
  const valid = rows.filter(r => r.truth && r.truth !== 'error');
  const rate = key => valid.length ? Math.round(valid.filter(r => r[key]).length / valid.length * 1000) / 1000 : null;
  return { n: valid.length, exact: rate('exact'), within_one: rate('within_one'), rows };
}

export function validatePredictions(components, predictions) {
  if (!predictions || typeof predictions !== 'object' || Array.isArray(predictions)) throw new Error('Predictions must be an object {componentId: tier}');
  const ids = new Set(components.map(c => c.id));
  for (const id of Object.keys(predictions)) if (!ids.has(id)) throw new Error(`Prediction for unknown component ${id}`);
  for (const c of components) {
    if (!(c.id in predictions)) throw new Error(`Missing prediction for ${c.id}`);
    if (!tiers.includes(predictions[c.id])) throw new Error(`Tier for ${c.id} must be one of ${tiers.join('|')}`);
  }
  return Object.fromEntries(components.map(c => [c.id, predictions[c.id]]));
}

// ---------- ledger operations ----------
export function newAblationBenchmark({ file, components = 12, build = null, scenario = 'sustained', seed = 'b1', ledger = defaultLedger() }) {
  const plan = analyzeAblation({ file, scenario, plan: true });
  const sample = sampleComponents(plan.components, components, seed);
  if (sample.length < 3) throw new Error('Fewer than 3 components to benchmark');
  return createRecord({ type: 'benchmark', title: `Ablation tiers: ${path.basename(file)} (${sample.length} components)`, held_out: true, builds: build ? [build] : [], tags: ['ablation_tiers'],
    statement: 'Predict the ablation tier (core|major|minor|negligible|removal_improves) of each component before scoring. Truth is computed only by `lab bench score`.',
    data: { task: { kind: 'ablation_tiers', file: path.resolve(file), scenario, seed, thresholds: defaultThresholds, components: sample } } }, { file: ledger });
}
// Several disjoint tasks on one build from a single plan: components already used by any benchmark of the same file are
// excluded, so tasks never repeat a component (each prediction is independent evidence).
export function newAblationBenchmarks({ file, tasks = 1, components = 12, build = null, scenario = 'sustained', seed = 'b1', tags = [], ledger = defaultLedger(), plan = null }) {
  const p = plan ?? analyzeAblation({ file, scenario, plan: true });
  const abs = path.resolve(file);
  const used = new Set([...loadLedger(ledger).values()].filter(r => r.type === 'benchmark' && r.data?.task?.kind === 'ablation_tiers' && path.resolve(r.data.task.file) === abs)
    .flatMap(r => r.data.task.components.map(c => c.id)));
  const out = [];
  for (let i = 0; i < tasks; i++) {
    const s = tasks > 1 ? `${seed}-${i + 1}` : seed;
    const sample = sampleComponents(p.components, components, s, used);
    if (sample.length < 3) break;
    sample.forEach(c => used.add(c.id));
    out.push(createRecord({ type: 'benchmark', title: `Ablation tiers: ${path.basename(file)} (${sample.length} components)`, held_out: true, builds: build ? [build] : [], tags: ['ablation_tiers', ...tags],
      statement: 'Predict the ablation tier (core|major|minor|negligible|removal_improves) of each component before scoring. Truth is computed only by `lab bench score`.',
      data: { task: { kind: 'ablation_tiers', file: abs, scenario, seed: s, thresholds: defaultThresholds, components: sample } } }, { file: ledger }));
  }
  if (!out.length) throw new Error('Fewer than 3 unused components to benchmark');
  return out;
}
const benchRecord = (id, ledger) => {
  const r = getRecord(id, { file: ledger });
  if (r.type !== 'benchmark' || r.data?.task?.kind !== 'ablation_tiers') throw new Error(`${id} is not an ablation_tiers benchmark`);
  return r;
};
export function showBenchmark(id, ledger = defaultLedger()) {
  const r = benchRecord(id, ledger);
  return { id: r.id, revision: r.revision, title: r.title, status: r.status, file: path.basename(r.data.task.file), scenario: r.data.task.scenario, tiers,
    components: r.data.task.components.map(c => ({ id: c.id, kind: c.kind, label: c.label })), predicted: !!r.data.predictions, scored: !!r.data.score,
    ...(r.data.score ? { score: { agent: r.data.score.agent, baselines: r.data.score.baselines } } : {}),
    template: Object.fromEntries(r.data.task.components.map(c => [c.id, null])) };
}
export function predictBenchmark(id, rev, predictions, ledger = defaultLedger()) {
  return mutateRecord(id, rev, r => {
    if (r.type !== 'benchmark' || r.data?.task?.kind !== 'ablation_tiers') throw new Error(`${id} is not an ablation_tiers benchmark`);
    if (r.data.score) throw new Error('Prediction cannot change after its outcome was recorded (benchmark already scored)');
    r.data.predictions = { at: new Date().toISOString(), tiers: validatePredictions(r.data.task.components, predictions) };
  }, { file: ledger, op: 'bench_predict' });
}
const readyToScore = (id, rev, ledger) => {
  const r = benchRecord(id, ledger);
  if (r.revision !== rev) throw new Error(`Revision conflict: ${id} is at revision ${r.revision}; reload before changing`);
  if (!r.data.predictions) throw new Error(`No predictions recorded for ${id}; use lab bench predict before scoring`);
  if (r.data.score) throw new Error(`Benchmark ${id} already scored`);
  return r;
};
export function scoreBenchmark(id, rev, opts = {}) { return scoreBenchmarks([id], [rev], opts)[0]; }
// Scores several predicted tasks; tasks on the same file/scenario/thresholds share one ablation run (union of their
// components). Every record is checked before the engine runs.
export function scoreBenchmarks(ids, revs, { ledger = defaultLedger(), runAblation = analyzeAblation, rowsLoader = qualityAblationRows } = {}) {
  if (ids.length !== revs.length) throw new Error('One expected revision per benchmark id is required');
  const records = ids.map((id, i) => readyToScore(id, revs[i], ledger));
  const groupKey = t => JSON.stringify([path.resolve(t.file), t.scenario, t.thresholds]);
  const groups = new Map();
  for (const r of records) { const k = groupKey(r.data.task); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const reports = new Map();
  for (const [k, rs] of groups) {
    const t = rs[0].data.task;
    reports.set(k, runAblation({ file: t.file, scenario: t.scenario, thresholds: t.thresholds, only: [...new Set(rs.flatMap(r => r.data.task.components.map(c => c.id)))] }));
  }
  const rows = cachedRows(rowsLoader);
  return records.map(r => applyScore(r, reports.get(groupKey(r.data.task)), { ledger, rowsLoader: rows }));
}
function applyScore(r, report, { ledger, rowsLoader }) {
  const { id, revision: rev } = r, task = r.data.task;
  const ids = new Set(task.components.map(c => c.id));
  const truth = Object.fromEntries(report.rows.filter(x => ids.has(x.id)).map(x => [x.id, x.tier]));
  const agent = scoreTiers(task.components, truth, r.data.predictions.tiers);
  const bs = baselineScores(task.components, truth, report.contract?.input_sha256 ?? null, rowsLoader);
  const score = { at: new Date().toISOString(), input_sha256: report.contract?.input_sha256 ?? null, truth,
    agent: { exact: agent.exact, within_one: agent.within_one, n: agent.n }, baselines: bs.scores, baseline_predictions: bs.predictions, empirical_training: bs.empirical,
    misses: agent.rows.filter(x => !x.exact).map(x => ({ id: x.id, truth: x.truth, predicted: x.predicted })) };
  const best = Math.max(...Object.values(score.baselines).map(b => b.exact ?? 0));
  return mutateRecord(id, rev, rec => {
    rec.data.score = score;
    rec.status = 'retired';
    rec.evidence.push({ kind: 'experiment', ref: `ablation only=${task.components.length}`, summary: `Agent exact ${score.agent.exact} / within-one ${score.agent.within_one} on ${score.agent.n}; best baseline exact ${best}.`,
      supports: (score.agent.exact ?? 0) > best, build: rec.builds[0] ?? null, verification: 'simulator_verified', at: score.at });
    rec.last_verified_at = score.at;
  }, { file: ledger, reason: 'scored', op: 'bench_score' });
}
// Recompute baselines of a scored benchmark from its stored truth (e.g. after the corpus grew). Agent predictions and
// truth are untouched; the benchmarked build stays excluded from the empirical training set.
export function rescoreBaselines(id, rev, { ledger = defaultLedger(), rowsLoader = qualityAblationRows } = {}) {
  return mutateRecord(id, rev, r => {
    if (r.type !== 'benchmark' || !r.data?.score) throw new Error(`${id} is not a scored benchmark`);
    const bs = baselineScores(r.data.task.components, r.data.score.truth, r.data.score.input_sha256, rowsLoader);
    r.data.score.baselines = bs.scores; r.data.score.baseline_predictions = bs.predictions; r.data.score.empirical_training = bs.empirical; r.data.score.baselines_rescored_at = new Date().toISOString();
  }, { file: ledger, op: 'bench_rescore' });
}

// Pooled accuracy over components (each component counts once): overall, by component kind and by build. Baseline
// predictions are read from the score; older records without them are recomputed (empirical without that build).
export function pooledAccuracy(scored, { rowsLoader = qualityAblationRows } = {}) {
  const rows = cachedRows(rowsLoader), cells = [];
  for (const r of scored) {
    const { task } = r.data, sc = r.data.score;
    const preds = sc.baseline_predictions ?? baselineScores(task.components, sc.truth, sc.input_sha256, rows).predictions;
    for (const c of task.components) {
      const t = sc.truth[c.id];
      if (!t || t === 'error') continue;
      cells.push({ kind: c.kind, build: path.basename(task.file, '.xml'), truth: t,
        by: { agent: r.data.predictions.tiers[c.id], ...Object.fromEntries(Object.entries(preds).map(([k, p]) => [k, p[c.id]])) } });
    }
  }
  const names = [...new Set(cells.flatMap(x => Object.keys(x.by)))];
  const acc = list => ({ n: list.length, ...Object.fromEntries(names.map(k => {
    const ok = list.filter(x => x.by[k] != null);
    const rate = f => ok.length ? Math.round(ok.filter(f).length / ok.length * 1000) / 1000 : null;
    return [k, { exact: rate(x => x.by[k] === x.truth), within_one: rate(x => Math.abs(level(x.by[k]) - level(x.truth)) <= 1) }];
  })) });
  const group = key => Object.fromEntries([...new Set(cells.map(x => x[key]))].sort().map(v => [v, acc(cells.filter(x => x[key] === v))]));
  return { overall: acc(cells), by_kind: group('kind'), by_build: group('build'),
    truth_distribution: Object.fromEntries(tiers.map(t => [t, cells.filter(x => x.truth === t).length]).filter(([, n]) => n)) };
}
export function benchmarkStats(ledger = defaultLedger(), { tag = null, ids = null, breakdown = false, rowsLoader = qualityAblationRows } = {}) {
  const scored = [...loadLedger(ledger).values()].filter(r => r.type === 'benchmark' && r.data?.score && (!tag || r.tags?.includes(tag)) && (!ids || ids.includes(r.id)));
  const mean = f => scored.length ? Math.round(scored.reduce((s, r) => s + (f(r) ?? 0), 0) / scored.length * 1000) / 1000 : null;
  return { scored: scored.length, components: scored.reduce((s, r) => s + (r.data.score.agent.n ?? 0), 0), agent_exact: mean(r => r.data.score.agent.exact), agent_within_one: mean(r => r.data.score.agent.within_one),
    baselines: Object.fromEntries([...Object.keys(baselines), 'empirical'].map(k => [k, mean(r => r.data.score.baselines[k]?.exact)])),
    empirical_scored: scored.filter(r => r.data.score.baselines.empirical).length,
    builds: new Set(scored.map(r => r.data.score.input_sha256 ?? r.data.task.file)).size,
    held_out_builds: new Set(scored.filter(r => r.data.score.empirical_training?.in_training === false).map(r => r.data.score.input_sha256)).size,
    ...(breakdown ? { pooled: pooledAccuracy(scored, { rowsLoader }) } : {}),
    note: 'Means over scored benchmarks; compare the agent with the best baseline on builds not used to tune the prediction.' };
}

export function benchCommand(args) {
  const { positional, options } = flags(args, ['components', 'tasks', 'tag', 'ids', 'build', 'scenario', 'seed', 'expected-revision', 'file', 'ledger'], ['breakdown']);
  const [op, target] = positional;
  const list = v => String(v).split(',').map(x => x.trim()).filter(Boolean);
  const ledger = options.ledger ? path.resolve(options.ledger) : defaultLedger();
  const rev = () => { const n = Number(options['expected-revision']); if (!Number.isInteger(n)) throw new Error('--expected-revision N required'); return n; };
  if (op === 'new') {
    if (!target) throw new Error('Use lab bench new <build.xml> [--components 12] [--build id] [--seed s]');
    const n = Number(options.components ?? 12);
    if (!Number.isInteger(n) || n < 3 || n > 60) throw new Error('--components must be 3-60');
    const tasks = Number(options.tasks ?? 1);
    if (!Number.isInteger(tasks) || tasks < 1 || tasks > 20) throw new Error('--tasks must be 1-20');
    const rs = newAblationBenchmarks({ file: path.resolve(target), tasks, components: n, build: options.build ?? null, scenario: options.scenario ?? 'sustained', seed: options.seed ?? 'b1', tags: options.tag ? list(options.tag) : [], ledger });
    return rs.length === 1 ? showBenchmark(rs[0].id, ledger) : { created: rs.length, benchmarks: rs.map(r => showBenchmark(r.id, ledger)) };
  }
  if (op === 'show') return showBenchmark(target, ledger);
  // Batch prediction file: {"B-004": {"expected_revision": 1, "tiers": {componentId: tier}}, ...}; all validated before any write.
  if (op === 'predict' && !target) {
    if (!options.file) throw new Error('--file predictions.json required');
    const batch = readJson(path.resolve(options.file));
    for (const [id, p] of Object.entries(batch)) {
      const r = benchRecord(id, ledger);
      if (r.revision !== p.expected_revision) throw new Error(`Revision conflict: ${id} is at revision ${r.revision}`);
      if (r.data.score) throw new Error(`${id} already scored`);
      validatePredictions(r.data.task.components, p.tiers);
    }
    return { predicted: Object.entries(batch).map(([id, p]) => { const r = predictBenchmark(id, p.expected_revision, p.tiers, ledger); return { id: r.id, revision: r.revision }; }) };
  }
  if (op === 'predict') { if (!options.file) throw new Error('--file predictions.json required'); const r = predictBenchmark(target, rev(), readJson(path.resolve(options.file)), ledger); return { id: r.id, revision: r.revision, predicted: true }; }
  if (op === 'score') {
    const ids = list(target ?? ''), revs = list(options['expected-revision'] ?? '').map(Number);
    if (!ids.length) throw new Error('Use lab bench score <B-id[,B-id...]> --expected-revision N[,N...]');
    if (!revs.length || revs.some(n => !Number.isInteger(n))) throw new Error('--expected-revision N required');
    const rs = scoreBenchmarks(ids, revs.length === 1 && ids.length > 1 ? ids.map(() => revs[0]) : revs, { ledger });
    const one = r => ({ id: r.id, revision: r.revision, score: { agent: r.data.score.agent, baselines: r.data.score.baselines, misses: r.data.score.misses } });
    return rs.length === 1 ? one(rs[0]) : { scored: rs.map(one) };
  }
  if (op === 'stats') return benchmarkStats(ledger, { tag: options.tag ?? null, ids: options.ids ? list(options.ids) : null, breakdown: !!options.breakdown });
  if (op === 'rescore') { const r = rescoreBaselines(target, rev(), { ledger }); return { id: r.id, revision: r.revision, agent: r.data.score.agent, baselines: r.data.score.baselines, empirical_training: r.data.score.empirical_training }; }
  throw new Error('Use lab bench new|show|predict|score|rescore|stats');
}
export const benchHelp = {
  'lab bench new <xml> [--components 12] [--tasks N] [--tag t] [--build id] [--seed s] | lab bench show <B-id>': 'Held-out benchmark: stratified samples of build components; --tasks N creates N disjoint tasks (a component never repeats across benchmarks of the same file); truth is not computed until scoring',
  'lab bench predict <B-id> --expected-revision N --file preds.json | lab bench predict --file batch.json': 'Frozen tier predictions; batch file {"B-id": {"expected_revision": N, "tiers": {...}}}, all validated before any write',
  'lab bench score <B-id[,B-id...]> --expected-revision N[,N...] | lab bench rescore <B-id> --expected-revision N': 'PoB ablation of exactly the predicted components (one run per build for a batch); agent vs baselines (all_minor, kind_prior, empirical = tier model learned from corpus ablations without this build; empirical_training.in_training says whether the build itself was a training build); rescore recomputes baselines from stored truth',
  'lab bench stats [--tag t] [--ids B-1,B-2] [--breakdown]': 'Mean per-task accuracy; --breakdown adds pooled accuracy over components overall, by kind (supports|skills|items|tree|config) and by build'
};
