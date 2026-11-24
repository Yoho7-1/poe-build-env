// Interactions between build components: remove pairs (and triples) of the strongest ablation components together
// and compare with the single removals. Under independence the remaining fractions multiply:
//   expected r_AB = r_A * r_B  (r = after / before of a metric)
//   interaction = r_AB / (r_A * r_B) - 1
// interaction < 0: removing both costs more than independent effects predict -> synergy (each amplifies the other)
// interaction > 0: removing both costs less -> overlap/redundancy (one of them is enough, shared cap or source)
// This measures 3+ effect structure the single ablation cannot show. PoB experiment, not a game test.
import fs from 'node:fs';
import path from 'node:path';
import { flags, readJson, atomicJson } from './workspace.mjs';
import { runPob, newPob } from './pob.mjs';
import { runBatch, batchRunner, defaultConcurrency } from './analysis-engine.mjs';
import { evaluateCandidates, AnalysisCache } from './analysis-core.mjs';
import { readBuild, pobGems } from './analysis-candidates.mjs';
import { loadTree } from './tree-graph.mjs';
import { planAblation, mergeChanges, analyzeAblation, ablationKinds, isSupportGem } from './analysis-ablation.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const round = v => finite(v) ? Math.round(v * 10000) / 10000 : null;
const metricsWanted = ['dps', 'fulldps', 'ehp', 'maxhit'];

// Strongest components of an ablation report (core/major, not errors), with the change that removes each
// (tree nodes: PoB removeNodes of the node alone, as in the ablation).
export function selectComponents(report, planned, { top = 6 } = {}) {
  const byId = new Map(planned.map(c => [c.id, c]));
  const loss = r => Math.max(r.offense_loss_pct ?? 0, r.defense_loss_pct ?? 0);
  const rows = report.rows.filter(r => !r.error && ['core', 'major'].includes(r.tier) && byId.has(r.id))
    .sort((a, b) => loss(b) - loss(a) || a.id.localeCompare(b.id)).slice(0, top);
  return rows.map(r => ({ id: r.id, label: r.label, kind: r.kind, tier: r.tier, changes: byId.get(r.id).changes }));
}
export function combinations(list, k) {
  if (k === 0) return [[]];
  const out = [];
  list.forEach((x, i) => { for (const rest of combinations(list.slice(i + 1), k - 1)) out.push([x, ...rest]); });
  return out;
}
export const combine = (parts, base = {}) => parts.reduce((acc, p) => mergeChanges(acc, p.changes), base);

// ratio after/before per metric; interaction from the singles. Pure.
export function interactionOf(singleRatios, jointRatio) {
  if (!finite(jointRatio) || singleRatios.some(r => !finite(r))) return null;
  const expected = singleRatios.reduce((a, b) => a * b, 1);
  if (expected <= 0) return { expected, actual: jointRatio, interaction: null, note: 'a single removal already drops the metric to 0' };
  return { expected: round(expected), actual: round(jointRatio), interaction: round(jointRatio / expected - 1) };
}
// Metric with the largest expected joint loss (1 - expected ratio); null when no metric moves by at least 1%.
export function pickMetric(per) {
  let best = null, bestLoss = 0.01;
  for (const [m, x] of Object.entries(per)) if (x && finite(x.expected) && x.interaction != null && 1 - x.expected > bestLoss) { best = m; bestLoss = 1 - x.expected; }
  return best;
}
export function classifyInteraction(x, threshold = 0.05) {
  if (!x || x.interaction == null) return 'undefined';
  if (x.interaction <= -threshold) return 'synergy';
  if (x.interaction >= threshold) return 'overlap';
  return 'independent';
}

export function analyzeInteractions({ file, scenario = 'sustained', from = null, top = 6, triples = 4, base = {}, threshold = 0.05, concurrency = defaultConcurrency } = {}) {
  const started = Date.now();
  if (top < 2 || top > 10) throw new Error('--top must be 2-10');
  const report = from ? readJson(from) : analyzeAblation({ file, scenario, base, concurrency, kinds: ablationKinds });
  if (report.analysis !== 'ablation' || report.plan) throw new Error('--from must be analyze ablate output (not --plan)');
  if (from && path.resolve(report.file) !== path.resolve(file)) throw new Error('--from ablation was computed for another build file');
  if (from && report.scenario !== scenario) throw new Error(`--from ablation used scenario ${report.scenario}; pass --scenario ${report.scenario}`);
  const baseline = runPob({ input: fs.readFileSync(file), scenario, changes: base, full: true });
  if (report.contract?.input_sha256 && report.contract.input_sha256 !== baseline.input_sha256) throw new Error('--from ablation input differs from the current build file; rerun analyze ablate');
  const build = readBuild(file);
  let tree = null; try { tree = loadTree(); } catch { tree = null; }
  let defaults = null; try { defaults = newPob({ className: build.class }).config ?? null; } catch { defaults = null; }
  const planned = planAblation({ build, equipped: baseline.equipped_items ?? [], tree, isSupport: isSupportGem(pobGems()),
    kinds: ablationKinds, base: {}, config: baseline.config ?? null, defaults }).components;
  const comps = selectComponents(report, planned, { top });
  if (comps.length < 2) return { analysis: 'interactions', file, scenario, components: comps, pairs: [], note: 'Fewer than two core/major components; nothing to combine.' };
  const singles = comps.map(c => [c]);
  const pairs = combinations(comps, 2);
  const triplesList = triples > 0 ? combinations(comps.slice(0, Math.min(triples, comps.length)), 3) : [];
  const sets = [...singles, ...pairs, ...triplesList];
  const id = set => set.map(c => c.id).join(' + ');
  const candidates = sets.map(set => ({ id: id(set), label: set.map(c => c.label).join(' + '), changes: combine(set, base), meta: { ids: set.map(c => c.id) } }));
  const batch = runBatch({ file, scenario, changesList: candidates.map(c => c.changes), concurrency });
  const evaluated = evaluateCandidates({ baseline, candidates, runner: batchRunner(batch), metricsWanted, cache: new AnalysisCache(), kind: 'interaction-v1' });
  const rowsById = new Map(evaluated.rows.map(r => [r.id, r]));
  const ratio = (r, m) => { const d = r?.deltas?.[m]; return d && finite(d.before) && d.before > 0 && finite(d.after) ? d.after / d.before : null; };
  const singleRatio = new Map(comps.map(c => [c.id, Object.fromEntries(metricsWanted.map(m => [m, ratio(rowsById.get(c.id), m)]))]));
  const describe = set => {
    const row = rowsById.get(id(set));
    if (!row || row.error) return { ids: set.map(c => c.id), labels: set.map(c => c.label), error: row?.error ?? 'not evaluated' };
    const per = Object.fromEntries(metricsWanted.map(m => { const x = interactionOf(set.map(c => singleRatio.get(c.id)[m]), ratio(row, m)); return [m, x ? { ...x, class: classifyInteraction(x, threshold) } : null]; }));
    // Judge on the metric the components actually move: largest expected joint loss among dps/fulldps/ehp/maxhit.
    const metric = pickMetric(per);
    const main = metric ? per[metric] : null;
    return { ids: set.map(c => c.id), labels: set.map(c => c.label), class: main?.class ?? 'undefined', metric, interaction: main?.interaction ?? null, per_metric: per };
  };
  const pairRows = pairs.map(describe), tripleRows = triplesList.map(describe);
  const order = { synergy: 0, overlap: 1, independent: 2, undefined: 3 };
  const sortRows = list => list.sort((a, b) => (order[a.class] ?? 4) - (order[b.class] ?? 4) || Math.abs(b.interaction ?? 0) - Math.abs(a.interaction ?? 0));
  return { analysis: 'interactions', game: 'poe1', patch: '3.30', file, scenario, threshold,
    method: 'Pairs/triples of the strongest single-ablation components removed together; interaction = r_joint / product(r_single) - 1 with r = after/before. Negative = synergy, positive = overlap. Tree nodes are removed alone through PoB removeNodes.',
    verification_level: 'simulator (PoB numbers); not a game test',
    components: comps.map(({ changes, ...c }) => c), singles: comps.map(c => ({ id: c.id, ratios: Object.fromEntries(Object.entries(singleRatio.get(c.id)).map(([k, v]) => [k, round(v)])) })),
    pairs: sortRows(pairRows), triples: sortRows(tripleRows),
    summary: { synergy: pairRows.filter(r => r.class === 'synergy').length, overlap: pairRows.filter(r => r.class === 'overlap').length, independent: pairRows.filter(r => r.class === 'independent').length },
    engine: { runs: batch.runs, elapsed_ms: batch.elapsed_ms, cache: evaluated.cache }, timing: { total_ms: Date.now() - started } };
}

const pct = v => finite(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '—';
export function interactionsMarkdown(r) {
  const ru = { synergy: 'синергия', overlap: 'перекрытие', independent: 'независимы', undefined: 'не определено' };
  const line = x => `| ${x.labels.join(' + ').replace(/\|/g, '/')} | ${x.error ? 'ошибка' : ru[x.class]} | ${x.metric ?? ''} | ${pct(x.interaction)} | ${x.error ? x.error.slice(0, 80) : pct(x.per_metric?.dps?.expected - 1)} → ${x.error ? '' : pct(x.per_metric?.dps?.actual - 1)} |`;
  return [`# Взаимодействия компонентов`, '', `Файл: \`${path.basename(r.file)}\` · сценарий \`${r.scenario}\` · порог ${r.threshold * 100}%`, '', `Метод: ${r.method}`, '',
    'Синергия — снять оба хуже, чем по отдельности перемноженно (усиливают друг друга); перекрытие — лучше (дублируют, хватает одного). Числа PoB, не игра.', '',
    '| Компоненты | Класс | Метрика | Взаимодействие | DPS: ожидалось → факт |', '|---|---|---|---|---|', ...r.pairs.map(line), ...(r.triples.length ? ['', '## Тройки', '', '| Компоненты | Класс | Метрика | Взаимодействие | DPS: ожидалось → факт |', '|---|---|---|---|---|', ...r.triples.map(line)] : []), ''].join('\n');
}

export function interactionsCommand(args) {
  const { positional, options } = flags(args, ['from', 'top', 'triples', 'scenario', 'changes', 'threshold', 'concurrency', 'out', 'md']);
  if (!positional[0]) throw new Error('Build file required: analyze interactions <xml> [--from ablation.json]');
  const int = (v, name, min, max, d) => { if (v == null) return d; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be ${min}-${max}`); return n; };
  const threshold = options.threshold == null ? 0.05 : Number(options.threshold) / 100;
  if (!(threshold > 0 && threshold < 1)) throw new Error('--threshold is a percentage 0-100');
  const result = analyzeInteractions({ file: path.resolve(positional[0]), scenario: options.scenario ?? 'sustained', from: options.from ? path.resolve(options.from) : null,
    top: int(options.top, 'top', 2, 10, 6), triples: int(options.triples, 'triples', 0, 6, 4), base: options.changes ? readJson(path.resolve(options.changes)) : {}, threshold,
    concurrency: int(options.concurrency, 'concurrency', 1, 16, defaultConcurrency) });
  if (options.out) atomicJson(path.resolve(options.out), result);
  if (options.md) { fs.mkdirSync(path.dirname(path.resolve(options.md)), { recursive: true }); fs.writeFileSync(path.resolve(options.md), interactionsMarkdown(result), 'utf8'); result.markdown_file = path.resolve(options.md); }
  return result;
}
export const interactionsHelp = {
  'analyze interactions <xml> [--from ablation.json] [--top 6] [--triples 4] [--threshold 5] [--scenario S] [--md f.md] [--out f.json]':
    'Pairs/triples of the strongest ablation components removed together: synergy (joint loss above the product of singles) or overlap (below); PoB experiment'
};
