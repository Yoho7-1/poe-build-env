// WP6 (first step): tree optimisation of a prototype or build by node swaps, computed by PoB. Each round:
//  1. removal value of every allocated passive (PoB misc calculator removeNodes, with dependents) -> loss per point;
//  2. Node Power of reachable notables/keystones (PoB addNodes + path) -> gain per point;
//  3. swap candidates (weakest removals x strongest additions that fit the freed points + unspent) evaluated as one
//     PoB variant {remove_nodes, add_nodes};
//  4. the best swap that improves the objective and keeps the constraints (EHP and weakest max hit not below
//     `keep` of the start, mana sustain not newly negative, no new unmet requirement) is applied as a real tree edit
//     (deallocate + allocate, saved XML) and the next round starts from it.
// Greedy and local: a better tree may need several simultaneous swaps. Every step is reproducible from the report.
import fs from 'node:fs';
import path from 'node:path';
import { flags, atomicJson, projectRoot } from './workspace.mjs';
import { runPob } from './pob.mjs';
import { runVariants, defaultConcurrency } from './analysis-engine.mjs';
import { effectiveDps, metrics as coreMetrics } from './analysis-core.mjs';
import { readBuild } from './analysis-candidates.mjs';
import { loadTree } from './tree-graph.mjs';

const round = (v, d = 1) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
export function valuesOf(o = {}, minion = null) {
  const dps = Math.max(effectiveDps(o).value ?? 0, minion ? effectiveDps(minion).value ?? 0 : 0);
  const hits = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'].map(t => o[`${t}MaximumHitTaken`]).filter(v => typeof v === 'number');
  return { dps, ehp: o.TotalEHP ?? 0, maxhit: hits.length ? Math.min(...hits) : 0, mana: coreMetrics.mana_sustain.read(o) ?? null };
}
const pct = (a, b) => b > 0 ? (a / b - 1) * 100 : 0;
// Objective: balanced = DPS% + EHP%/2 + max hit%/2; dps or ehp alone on request.
export function objective(v, base, metric = 'balanced') {
  const d = pct(v.dps, base.dps), e = pct(v.ehp, base.ehp), m = pct(v.maxhit, base.maxhit);
  return metric === 'dps' ? d : metric === 'ehp' ? e + m / 2 : d + e / 2 + m / 2;
}
export function feasible(v, start, { keep = 0.97 } = {}) {
  const why = [];
  if (start.ehp > 0 && v.ehp < start.ehp * keep) why.push(`EHP ${Math.round(v.ehp)} < ${Math.round(start.ehp * keep)}`);
  if (start.maxhit > 0 && v.maxhit < start.maxhit * keep) why.push(`max hit ${Math.round(v.maxhit)} < ${Math.round(start.maxhit * keep)}`);
  if (start.mana != null && start.mana >= 0 && v.mana != null && v.mana < 0) why.push(`mana sustain ${round(v.mana)} < 0`);
  return why;
}
// Pure: pair removals (loss per freed point, ascending) with additions (gain per point, descending) that fit.
export function swapPairs(removals, additions, { unspent = 0, maxRemovals = 10, maxAdditions = 12 } = {}) {
  const rem = [...removals].filter(r => r.points > 0).sort((a, b) => a.loss_per_point - b.loss_per_point).slice(0, maxRemovals);
  const add = [...additions].filter(a => a.points > 0 && a.gain_per_point > 0).sort((a, b) => b.gain_per_point - a.gain_per_point).slice(0, maxAdditions);
  const pairs = [];
  for (const r of rem) for (const a of add) {
    if (a.points > r.points + unspent) continue;
    if (a.path?.some(id => r.removed?.includes(id))) continue; // the path runs through a removed node
    pairs.push({ remove: r, add: a });
  }
  return pairs;
}

function evaluate({ file, scenario, concurrency, variants, nodePower = null }) {
  return runVariants({ file, scenario, variants, nodePower, concurrency });
}

export function optimizeTree({ file, scenario = 'sustained', metric = 'balanced', rounds = 3, keep = 0.97, radius = 4, concurrency = defaultConcurrency, out = null }) {
  const t = loadTree();
  const started = Date.now();
  const steps = [];
  let current = path.resolve(file);
  const workDir = path.dirname(path.resolve(out ?? current));
  fs.mkdirSync(workDir, { recursive: true });
  const first = runPob({ input: fs.readFileSync(current), scenario });
  const start = valuesOf(first.output, first.minion_output);
  let base = start, baseRun = first;
  for (let i = 0; i < rounds; i++) {
    const build = readBuild(current);
    const unspent = Math.max(0, (baseRun.budget?.passive_available ?? 0) - (baseRun.budget?.passive_used ?? 0));
    const allocated = [...build.allocated].map(id => t.nodes.get(Number(id))).filter(n => n && !n.ascendancy && ['notable', 'keystone', 'normal', 'mastery'].includes(n.type));
    // 1+2: removals and Node Power in one batch of PoB processes.
    const vr = evaluate({ file: current, scenario, concurrency, variants: allocated.map(n => ({ id: `rm:${n.id}`, remove_nodes: [{ node: n.id, with_dependents: true }] })), nodePower: { max_dist: radius, types: ['Notable', 'Keystone'] } });
    // Leaves (no dependents) are skipped by PoB with with_dependents; measure them alone.
    const leaves = [...vr.results].filter(([id, r]) => id.startsWith('rm:') && r.skipped === 'no_dependents').map(([id]) => Number(id.slice(3)));
    const lr = leaves.length ? evaluate({ file: current, scenario, concurrency, variants: leaves.map(id => ({ id: `rl:${id}`, remove_nodes: [{ node: id }] })) }) : { results: new Map() };
    const removals = [], additions = [];
    for (const [id, r] of [...vr.results, ...lr.results]) {
      if (r.skipped) continue;
      const v = valuesOf(r.output, r.minion_output);
      if (id.startsWith('rm:') || id.startsWith('rl:')) {
        const removed = (r.removed_nodes?.nodes ?? []).map(n => n.id ?? n).filter(x => x != null);
        const points = Math.max(1, removed.length);
        removals.push({ node: Number(id.slice(3)), name: t.nodes.get(Number(id.slice(3)))?.name, with_dependents: id.startsWith('rm:'), points, removed, loss: round(-objective(v, base, metric), 2), loss_per_point: -objective(v, base, metric) / points });
      } else if (id.startsWith('add:')) {
        const points = r.points ?? (r.added_nodes ?? []).length;
        additions.push({ node: Number(id.slice(4)), name: t.nodes.get(Number(id.slice(4)))?.name, points, path: (r.added_nodes ?? []).map(n => n.id ?? n), gain: round(objective(v, base, metric), 2), gain_per_point: points ? objective(v, base, metric) / points : 0 });
      }
    }
    const pairs = swapPairs(removals, additions, { unspent });
    if (!pairs.length) { steps.push({ round: i + 1, result: 'no_swap_candidates', removals: removals.length, additions: additions.length }); break; }
    // 3: evaluate swaps as combined variants.
    const sv = evaluate({ file: current, scenario, concurrency, variants: pairs.map((p, k) => ({ id: `sw:${k}`, remove_nodes: [{ node: p.remove.node, ...(p.remove.with_dependents ? { with_dependents: true } : {}) }], add_nodes: [p.add.node] })) });
    const scored = pairs.map((p, k) => { const r = sv.results.get(`sw:${k}`); if (!r || r.skipped) return null; const v = valuesOf(r.output, r.minion_output); return { ...p, v, gain: objective(v, base, metric), blocked: feasible(v, start, { keep }) }; })
      .filter(Boolean).sort((a, b) => b.gain - a.gain);
    const best = scored.find(s => s.gain > 0.5 && !s.blocked.length);
    if (!best) { steps.push({ round: i + 1, result: 'no_improving_feasible_swap', evaluated: scored.length, best_blocked: scored[0] ? { gain: round(scored[0].gain, 2), blocked: scored[0].blocked } : null }); break; }
    // 4: real tree edit, verified by a normal PoB run.
    const next = path.join(workDir, `${path.basename(out ?? file, '.xml')}.opt${i + 1}.xml`);
    if (fs.existsSync(next)) fs.rmSync(next);
    let applied;
    try { applied = runPob({ input: fs.readFileSync(current), scenario, changes: { tree: { deallocate: [best.remove.node], allocate: [best.add.node] } }, saveXml: next }); }
    catch (e) { steps.push({ round: i + 1, result: 'apply_failed', swap: `${best.remove.name} -> ${best.add.name}`, error: e.message.slice(0, 300) }); break; }
    const v = valuesOf(applied.output, applied.minion_output);
    const over = (applied.budget?.passive_used ?? 0) > (applied.budget?.passive_available ?? Infinity);
    const warnNew = (applied.engine_warnings ?? []).filter(w => /do not meet/i.test(w) && !(baseRun.engine_warnings ?? []).includes(w));
    if (over || warnNew.length || objective(v, base, metric) <= 0) { steps.push({ round: i + 1, result: 'rejected_after_apply', swap: `${best.remove.name} -> ${best.add.name}`, over_budget: over, new_warnings: warnNew, gain: round(objective(v, base, metric), 2) }); break; }
    // Conditional stats of the added node (keystone/notable): the gain depends on a PoB Config condition the build
    // may not meet in game (crit recently, while X, if Y) - reported for a separate check, not assumed.
    const addedNode = t.nodes.get(best.add.node);
    const conditional = (addedNode?.stats ?? []).flatMap(s => String(s).split('\n')).filter(s => /\b(if|while|recently|in the past|when)\b/i.test(s));
    steps.push({ round: i + 1, result: 'applied', ...(conditional.length ? { check_conditions: conditional } : {}), removed: best.remove.name, removed_points: best.remove.points, added: best.add.name, added_points: best.add.points, gain_pct: round(objective(v, base, metric), 2),
      dps_pct: round(pct(v.dps, base.dps)), ehp_pct: round(pct(v.ehp, base.ehp)), maxhit_pct: round(pct(v.maxhit, base.maxhit)), xml: path.relative(projectRoot, next), calculation_id: applied.calculation_id,
      candidates: { removals: removals.length, additions: additions.length, swaps: scored.length } });
    current = next; base = v; baseRun = applied;
  }
  if (out && current !== path.resolve(file)) fs.copyFileSync(current, path.resolve(out));
  return { game: 'poe1', patch: '3.30', analysis: 'tree_optimize', metric, keep, file: path.basename(file), result_xml: out ? path.relative(projectRoot, path.resolve(out)) : path.relative(projectRoot, current),
    start: { dps: round(start.dps, 0), ehp: round(start.ehp, 0), maxhit: round(start.maxhit, 0), mana: round(start.mana) },
    end: { dps: round(base.dps, 0), ehp: round(base.ehp, 0), maxhit: round(base.maxhit, 0), mana: round(base.mana) },
    change: { dps_pct: round(pct(base.dps, start.dps)), ehp_pct: round(pct(base.ehp, start.ehp)), maxhit_pct: round(pct(base.maxhit, start.maxhit)) },
    steps, timing_s: round((Date.now() - started) / 1000),
    assumptions: ['One swap per round (a removal with its dependents for one reachable notable/keystone with its PoB path); greedy local search.', `Constraints: EHP and weakest max hit >= ${keep} x start, mana sustain not newly negative, no new unmet requirement, within the passive budget.`, 'Masteries removed with their group are not re-chosen; jewels in removed sockets are lost.'],
    disclaimer: 'PoB numbers on the current items and configuration; not a game test.' };
}

export function optimizeCommand(args) {
  const { positional, options } = flags(args, ['metric', 'rounds', 'keep', 'radius', 'out', 'scenario', 'concurrency']);
  if (positional[0] !== 'optimize' || !positional[1]) throw new Error('Use design optimize <xml> [--metric balanced|dps|ehp] [--rounds 3] [--keep 0.97] [--radius 4] [--out new.xml]');
  return optimizeTree({ file: path.resolve(positional[1]), metric: options.metric ?? 'balanced', rounds: Number(options.rounds ?? 3), keep: Number(options.keep ?? 0.97),
    radius: Number(options.radius ?? 4), scenario: options.scenario ?? 'sustained', concurrency: options.concurrency ? Number(options.concurrency) : defaultConcurrency, out: options.out ?? null });
}
export const optimizeHelp = {
  'design optimize <xml> [--metric balanced|dps|ehp] [--rounds 3] [--keep 0.97] [--radius 4] [--out new.xml]': 'WP6 tree optimisation by PoB-evaluated node swaps: removal value of every allocated passive and Node Power of reachable notables/keystones, swap = remove (with dependents) + add (with path) as one PoB variant; the best feasible swap per round is applied as a real tree edit; constraints keep EHP/max hit/mana sustain/requirements/budget'
};
