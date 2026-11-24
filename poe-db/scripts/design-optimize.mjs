// WP6: joint optimisation of a prototype or build, computed by PoB. Coordinate ascent over phases
// (tree -> supports -> items, repeated for `rounds` cycles; stops after a cycle with no applied step).
//  tree: removal value of every allocated passive (PoB removeNodes, with dependents) and Node Power of reachable
//        notables/keystones (PoB addNodes + path) -> single swaps evaluated as PoB variants -> several disjoint
//        improving swaps (no shared removed node or path node, within freed + unspent points) are checked as one
//        combined PoB variant (and its prefixes); the best feasible option (combination or best single) is applied
//        as a real tree edit.
//  supports / items: the existing `analyze upgrades --auto supports|uniques|anoints` ranking (no new calculation
//        path); the best feasible candidate by the objective is applied through its own `changes`.
// Every applied step is a real edit saved as XML and re-checked by a normal PoB run against the constraints: EHP and
// weakest max hit not below `keep` x start, mana sustain not newly negative, no new unmet requirement, within the
// passive budget. Steps carry their exact `changes`; `--record` writes them to `lab`, `--replay <E-id>` re-applies them.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { flags, projectRoot } from './workspace.mjs';
import { runPob } from './pob.mjs';
import { runVariants, defaultConcurrency } from './analysis-engine.mjs';
import { effectiveDps, metrics as coreMetrics } from './analysis-core.mjs';
import { readBuild, analyzeAutoUpgrades, generateCandidates, slotClasses, normalizeSlot, pobGems } from './analysis-candidates.mjs';
import { expandCandidates } from './analysis-upgrades.mjs';
import { loadTree } from './tree-graph.mjs';
import { createRecord, loadLedger, defaultLedger } from './lab.mjs';
import { optimizeVariants, priceVariant, selectInBudget, withPriceContext } from './design-variants.mjs';

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
const unmetRequirement = w => /do not meet|requirement/i.test(w);
// Checks of an applied edit (normal PoB run of the saved XML): budget, new unmet requirements, gain, constraints.
export function acceptApplied({ v, base, start, run, baseRun, metric = 'balanced', keep = 0.97 }) {
  const why = [];
  if ((run.budget?.passive_used ?? 0) > (run.budget?.passive_available ?? Infinity)) why.push(`over passive budget ${run.budget.passive_used}/${run.budget.passive_available}`);
  const before = new Set(baseRun?.engine_warnings ?? []);
  for (const w of (run.engine_warnings ?? []).filter(w => unmetRequirement(w) && !before.has(w))) why.push(`new warning: ${w}`);
  const gain = objective(v, base, metric);
  if (!(gain > 0)) why.push(`no gain (${round(gain, 2)})`);
  return [...why, ...feasible(v, start, { keep })];
}

// ---------- tree ----------
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
// Pure: greedy set of disjoint swaps from individually scored ones (best gain first). Disjoint = no shared removed
// node, no shared path node, no path through any chosen removal; total added points <= freed points + unspent.
export function pickDisjoint(scored, { unspent = 0, maxSwaps = 3 } = {}) {
  const removedOf = s => new Set([s.remove.node, ...(s.remove.removed ?? [])].map(Number));
  const pathOf = s => new Set([s.add.node, ...(s.add.path ?? [])].map(Number));
  const chosen = [], removed = new Set(), added = new Set();
  let freed = 0, spent = 0;
  for (const s of [...scored].sort((a, b) => b.gain - a.gain)) {
    if (chosen.length >= maxSwaps) break;
    const r = removedOf(s), p = pathOf(s);
    if ([...r].some(id => removed.has(id) || added.has(id))) continue;
    if ([...p].some(id => added.has(id) || removed.has(id) || r.has(id))) continue;
    if (spent + s.add.points > freed + s.remove.points + unspent) continue;
    chosen.push(s); r.forEach(id => removed.add(id)); p.forEach(id => added.add(id));
    freed += s.remove.points; spent += s.add.points;
  }
  return chosen;
}
const removeSpec = s => ({ node: s.remove.node, ...(s.remove.with_dependents ? { with_dependents: true } : {}) });
// Pure: one PoB variant per prefix of the chosen swaps (2..n swaps together).
export function combinationVariants(chosen) {
  return chosen.slice(1).map((_, i) => { const part = chosen.slice(0, i + 2); return { id: `cb:${i + 2}`, remove_nodes: part.map(removeSpec), add_nodes: part.map(s => s.add.node) }; });
}
export const treeChanges = swaps => ({ tree: { deallocate: swaps.map(s => s.remove.node), allocate: swaps.map(s => s.add.node) } });

// ---------- supports / items ----------
// Pure: values of an upgrade row from its PoB deltas, scaled onto the optimiser's own base values (the ratio keeps
// one definition of each value; a metric that vanished counts as zero).
export function valuesFromDeltas(base, deltas = {}) {
  const ratio = d => d == null ? 1 : d.before > 0 ? (d.after == null ? 0 : d.after / d.before) : 1;
  return { dps: base.dps * ratio(deltas.dps), ehp: base.ehp * ratio(deltas.ehp), maxhit: base.maxhit * ratio(deltas.maxhit), mana: deltas.mana_sustain?.after ?? base.mana };
}
// Pure: best feasible upgrade row by the objective. Rows come from analyzeAutoUpgrades (ranking), changes by id.
// Trigger-tagged supports (Cast when Stunned, Cast On Critical Strike, ...) change how the skill is used: blocked
// unless the group already relies on a trigger (then `blockedSupports` is empty).
export function chooseUpgrade(rows, { base, start, metric = 'balanced', keep = 0.97, minGain = 0.5, maxChaos = null, requirePrice = false, changesById = new Map(), blockedSupports = new Set() } = {}) {
  const scored = rows.map(r => {
    const blocked = [];
    const changes = changesById.get(r.id) ?? null;
    if (!changes) blocked.push('no changes');
    else if (changes.custom_mods) blocked.push('custom mods only (no real item edit)');
    if (/control/.test(r.id)) blocked.push('control row');
    if (r.generated?.support && blockedSupports.has(r.generated.support)) blocked.push('trigger support (changes how the skill is used)');
    if (maxChaos == null && r.generated?.exceptional) blocked.push('exceptional/awakened gem without --max-chaos');
    if (['not_applied', 'error'].includes(r.verification?.status)) blocked.push(`verification ${r.verification.status}`);
    if ((r.new_warnings ?? []).some(unmetRequirement)) blocked.push('new unmet requirement');
    const chaos = r.price?.chaos ?? null;
    if (maxChaos != null && chaos != null && chaos > maxChaos) blocked.push(`price ${round(chaos)} > ${maxChaos} chaos`);
    if (requirePrice && chaos == null) blocked.push('no observed price');
    const v = valuesFromDeltas(base, r.deltas);
    blocked.push(...feasible(v, start, { keep }));
    return { row: r, changes, v, gain: objective(v, base, metric), blocked };
  }).sort((a, b) => b.gain - a.gain);
  const best = scored.find(s => s.gain > minGain && !s.blocked.length) ?? null;
  const top = scored[0];
  return { best, evaluated: scored.length, top_blocked: top && top !== best ? { id: top.row.id, gain: round(top.gain, 2), blocked: top.blocked } : null };
}

// ---------- steps ----------
const rel = f => path.relative(projectRoot, f);
function applyStep(st, o, { phase, label, changes, extra = {} }) {
  const next = path.join(st.workDir, `${st.stem}.opt${st.n + 1}.xml`);
  if (fs.existsSync(next)) fs.rmSync(next);
  let run;
  try { run = runPob({ input: fs.readFileSync(st.current), scenario: o.scenario, changes, saveXml: next }); }
  catch (e) { return { phase, result: 'apply_failed', label, error: e.message.slice(0, 300) }; }
  const v = valuesOf(run.output, run.minion_output);
  const why = acceptApplied({ v, base: st.base, start: st.start, run, baseRun: st.baseRun, metric: o.metric, keep: o.keep });
  if (why.length) { fs.rmSync(next, { force: true }); return { phase, result: 'rejected_after_apply', label, reasons: why, gain_pct: round(objective(v, st.base, o.metric), 2) }; }
  const step = { phase, result: 'applied', label, gain_pct: round(objective(v, st.base, o.metric), 2), dps_pct: round(pct(v.dps, st.base.dps)), ehp_pct: round(pct(v.ehp, st.base.ehp)),
    maxhit_pct: round(pct(v.maxhit, st.base.maxhit)), mana: round(v.mana), xml: rel(next), calculation_id: run.calculation_id, ...extra, changes };
  st.n++; st.current = next; st.base = v; st.baseRun = run;
  return step;
}

function treeStep(st, o) {
  const t = loadTree();
  const build = readBuild(st.current);
  const unspent = Math.max(0, (st.baseRun.budget?.passive_available ?? 0) - (st.baseRun.budget?.passive_used ?? 0));
  const allocated = [...build.allocated].map(id => t.nodes.get(Number(id))).filter(n => n && !n.ascendancy && ['notable', 'keystone', 'normal', 'mastery'].includes(n.type));
  const evaluate = (variants, nodePower = null) => runVariants({ file: st.current, scenario: o.scenario, variants, nodePower, concurrency: o.concurrency });
  // Removals and Node Power in one batch of PoB processes; leaves (no dependents) are skipped by PoB and measured alone.
  const vr = evaluate(allocated.map(n => ({ id: `rm:${n.id}`, remove_nodes: [{ node: n.id, with_dependents: true }] })), { max_dist: o.radius, types: ['Notable', 'Keystone'] });
  const leaves = [...vr.results].filter(([id, r]) => id.startsWith('rm:') && r.skipped === 'no_dependents').map(([id]) => Number(id.slice(3)));
  const lr = leaves.length ? evaluate(leaves.map(id => ({ id: `rl:${id}`, remove_nodes: [{ node: id }] }))) : { results: new Map() };
  const removals = [], additions = [];
  for (const [id, r] of [...vr.results, ...lr.results]) {
    if (r.skipped) continue;
    const g = objective(valuesOf(r.output, r.minion_output), st.base, o.metric);
    if (id.startsWith('rm:') || id.startsWith('rl:')) {
      const removed = (r.removed_nodes?.nodes ?? []).map(n => n.id ?? n).filter(x => x != null);
      const points = Math.max(1, removed.length);
      removals.push({ node: Number(id.slice(3)), name: t.nodes.get(Number(id.slice(3)))?.name, with_dependents: id.startsWith('rm:'), points, removed, loss: round(-g, 2), loss_per_point: -g / points });
    } else if (id.startsWith('add:')) {
      const points = r.points ?? (r.added_nodes ?? []).length;
      additions.push({ node: Number(id.slice(4)), name: t.nodes.get(Number(id.slice(4)))?.name, points, path: (r.added_nodes ?? []).map(n => n.id ?? n), gain: round(g, 2), gain_per_point: points ? g / points : 0 });
    }
  }
  const pairs = swapPairs(removals, additions, { unspent });
  if (!pairs.length) return { phase: 'tree', result: 'no_swap_candidates', removals: removals.length, additions: additions.length };
  const sv = evaluate(pairs.map((p, k) => ({ id: `sw:${k}`, remove_nodes: [removeSpec(p)], add_nodes: [p.add.node] })));
  const scored = pairs.map((p, k) => { const r = sv.results.get(`sw:${k}`); if (!r || r.skipped) return null; const v = valuesOf(r.output, r.minion_output); return { ...p, v, gain: objective(v, st.base, o.metric), blocked: feasible(v, st.start, { keep: o.keep }) }; })
    .filter(Boolean).sort((a, b) => b.gain - a.gain);
  const singles = scored.filter(s => s.gain > o.minGain && !s.blocked.length);
  if (!singles.length) return { phase: 'tree', result: 'no_improving_feasible_swap', evaluated: scored.length, best_blocked: scored[0] ? { gain: round(scored[0].gain, 2), blocked: scored[0].blocked } : null };
  // Several disjoint swaps checked together: PoB evaluates each prefix of the chosen set as one variant.
  const chosen = pickDisjoint(singles, { unspent, maxSwaps: o.maxSwaps });
  let pick = { swaps: [singles[0]], gain: singles[0].gain };
  const combos = [];
  if (chosen.length >= 2) {
    const vars = combinationVariants(chosen);
    const cv = evaluate(vars);
    for (const x of vars) {
      const r = cv.results.get(x.id);
      if (!r || r.skipped) continue;
      const v = valuesOf(r.output, r.minion_output);
      combos.push({ swaps: chosen.slice(0, x.add_nodes.length), gain: objective(v, st.base, o.metric), blocked: feasible(v, st.start, { keep: o.keep }) });
    }
    const best = combos.filter(c => !c.blocked.length).sort((a, b) => b.gain - a.gain)[0];
    if (best && best.gain > pick.gain) pick = best;
  }
  const summary = { removals: removals.length, additions: additions.length, swaps: scored.length, feasible_swaps: singles.length,
    combinations: combos.map(c => ({ swaps: c.swaps.length, gain: round(c.gain, 2), blocked: c.blocked.length ? c.blocked : undefined })) };
  const attempt = swaps => {
    const added = swaps.map(s => t.nodes.get(s.add.node));
    // Conditional stats of an added node depend on a PoB Config condition the build may not meet in game.
    const conditional = added.flatMap(n => (n?.stats ?? []).flatMap(s => String(s).split('\n'))).filter(s => /\b(if|while|recently|in the past|when)\b/i.test(s));
    return applyStep(st, o, { phase: 'tree', label: swaps.map(s => `${s.remove.name} (${s.remove.points}) -> ${s.add.name} (${s.add.points})`).join('; '), changes: treeChanges(swaps),
      extra: { swaps: swaps.length, predicted_gain_pct: round(swaps === pick.swaps ? pick.gain : swaps[0].gain, 2), ...(conditional.length ? { check_conditions: conditional } : {}), candidates: summary } });
  };
  const step = attempt(pick.swaps);
  if (step.result !== 'applied' && pick.swaps.length > 1) return { ...attempt([singles[0]]), combination_rejected: { label: step.label, reasons: step.reasons ?? step.error } };
  return step;
}

function upgradeStep(st, o, kind, slot = null) {
  const phase = kind === 'supports' ? 'supports' : 'items';
  const build = readBuild(st.current);
  const group = o.group ?? build.main_socket_group;
  const common = { kind, file: st.current, slot, group, limit: o.limit, quality: 20, excludeAwakened: o.excludeAwakened };
  let res;
  try { res = analyzeAutoUpgrades({ ...common, metric: 'dps', top: 2000, concurrency: o.concurrency, scenario: o.scenario }); }
  catch (e) { return { phase, kind, slot, result: 'candidates_failed', error: e.message.slice(0, 300) }; }
  if (kind === 'supports' && res.measured_group != null && res.measured_group !== build.main_socket_group)
    return { phase, kind, result: 'skipped', reason: `group ${group} feeds group ${res.measured_group}, not the main skill` };
  if (!res.ranking?.length) return { phase, kind, slot, result: 'no_candidates' };
  // Same deterministic generation as inside analyzeAutoUpgrades (incl. its weakest-support probe) -> changes by id.
  const replace = kind === 'supports' ? (res.replacement_probe?.weakest ? String(res.replacement_probe.weakest.gem) : 'auto') : undefined;
  const gen = generateCandidates({ ...common, replace });
  const changesById = new Map(expandCandidates({ candidates: gen.candidates }).map(c => [c.id, c.changes]));
  let blockedSupports = new Set();
  if (kind === 'supports') {
    const triggers = new Set([...pobGems().values()].filter(g => g.tags?.support && g.tags?.trigger).map(g => g.name));
    if (!build.groups[group - 1]?.gems.some(g => g.enabled && triggers.has(g.name))) blockedSupports = triggers;
  }
  const pick = chooseUpgrade(res.ranking, { base: st.base, start: st.start, metric: o.metric, keep: o.keep, minGain: o.minGain, maxChaos: o.maxChaos, requirePrice: kind === 'uniques', changesById, blockedSupports });
  if (!pick.best) return { phase, kind, slot, result: 'no_improving_feasible_upgrade', evaluated: pick.evaluated, top_blocked: pick.top_blocked };
  const r = pick.best.row;
  // WP11 variant model: what the step buys (the candidate's price spec), priced once at the end of the run.
  const spec = gen.candidates.find(c => c.id === r.id)?.price ?? null;
  const component = spec ? { kind: 'any', name: spec.name, variant: spec.variant ?? null } : kind === 'anoints' ? { kind: 'anoint', name: r.label, unpriced: 'oil combinations are not in the allowed poe.ninja categories' } : { kind: 'unpriced', name: r.label, unpriced: 'no price variant matched in the dated snapshot' };
  return applyStep(st, o, { phase, label: r.label, changes: pick.best.changes,
    extra: { kind, component, ...(slot ? { slot } : {}), candidate: r.id, predicted_gain_pct: round(pick.best.gain, 2), price_chaos: round(r.price?.chaos ?? null), verification: r.verification?.status, evaluated: pick.evaluated } });
}

function itemSteps(st, o) {
  const steps = [];
  if (o.maxChaos != null) {
    const equipped = readBuild(st.current).slots;
    const slots = o.slots ?? Object.keys(slotClasses).filter(s => !s.startsWith('Flask') && equipped.has(s));
    for (const slot of slots) steps.push(upgradeStep(st, o, 'uniques', normalizeSlot(slot)));
  } else steps.push({ phase: 'items', kind: 'uniques', result: 'skipped', reason: 'uniques need --max-chaos (only priced uniques within it are applied)' });
  if (readBuild(st.current).slots.has('Amulet')) steps.push(upgradeStep(st, o, 'anoints'));
  return steps;
}

// ---------- driver ----------
export const phaseNames = ['tree', 'supports', 'items'];
export function optimizeBuild({ file, scenario = 'sustained', metric = 'balanced', rounds = 3, keep = 0.97, radius = 4, maxSwaps = 3, phases = phaseNames, group = null, slots = null,
  maxChaos = null, limit = 40, excludeAwakened = false, minGain = 0.5, concurrency = defaultConcurrency, out = null, record = false, ledger = defaultLedger() }) {
  for (const p of phases) if (!phaseNames.includes(p)) throw new Error(`Unknown phase ${p}; use ${phaseNames.join(',')}`);
  const o = { scenario, metric, keep, radius, maxSwaps, group, slots, maxChaos, limit, excludeAwakened, minGain, concurrency };
  const started = Date.now();
  const input = path.resolve(file);
  const workDir = path.dirname(path.resolve(out ?? input));
  fs.mkdirSync(workDir, { recursive: true });
  const first = runPob({ input: fs.readFileSync(input), scenario });
  const start = valuesOf(first.output, first.minion_output);
  const st = { current: input, start, base: start, baseRun: first, workDir, stem: path.basename(out ?? input, '.xml'), n: 0 };
  const steps = [];
  for (let c = 1; c <= rounds; c++) {
    const before = st.n;
    for (const phase of phases) {
      const got = phase === 'tree' ? [treeStep(st, o)] : phase === 'supports' ? [upgradeStep(st, o, 'supports')] : itemSteps(st, o);
      steps.push(...got.map(s => ({ cycle: c, ...s })));
    }
    if (st.n === before) break; // a whole cycle without an applied step: local optimum for these moves
  }
  if (out && st.current !== input) fs.copyFileSync(st.current, path.resolve(out));
  const applied = steps.filter(s => s.result === 'applied');
  const report = { game: 'poe1', patch: '3.30', analysis: 'joint_optimize', metric, keep, phases, file: path.basename(file),
    result_xml: rel(out && st.current !== input ? path.resolve(out) : st.current),
    start: { dps: round(start.dps, 0), ehp: round(start.ehp, 0), maxhit: round(start.maxhit, 0), mana: round(start.mana) },
    end: { dps: round(st.base.dps, 0), ehp: round(st.base.ehp, 0), maxhit: round(st.base.maxhit, 0), mana: round(st.base.mana) },
    change: { dps_pct: round(pct(st.base.dps, start.dps)), ehp_pct: round(pct(st.base.ehp, start.ehp)), maxhit_pct: round(pct(st.base.maxhit, start.maxhit)) },
    applied: applied.length, steps,
    variant_model: withPriceContext(ctx => { const vs = optimizeVariants(steps).map(v => priceVariant(v, ctx)); return { variants: vs.map(v => ({ id: v.id, label: v.label, resource: v.resource.key, gain: v.gain, cost_class: v.price.cost_class, exact_chaos: v.price.exact_chaos, estimated_chaos: v.price.estimated_chaos, unknown: v.price.unknown.length ? v.price.unknown : undefined })), selection: selectInBudget(vs, { budget: maxChaos != null ? { amount: maxChaos, currency: 'chaos' } : null, ctx }) }; }),
    timing_s: round((Date.now() - started) / 1000),
    assumptions: [`Tree: up to ${maxSwaps} disjoint swaps per step (removal with its dependents for a reachable notable/keystone with its PoB path), checked together as one PoB variant; otherwise the best single swap.`,
      'Supports and items: candidates and ranking from analyze upgrades --auto (supports of the main group, trigger-tagged supports only if the group already has one, exceptional/awakened gems only with --max-chaos, uniques per slot only with --max-chaos and an observed price, amulet anoint); one candidate per step.',
      `Constraints after every applied edit (normal PoB run): EHP and weakest max hit >= ${keep} x start, mana sustain not newly negative, no new unmet requirement, within the passive budget.`,
      'Coordinate ascent, local: stops after a cycle without an applied step. Masteries removed with their group are not re-chosen; jewels in removed sockets are lost.'],
    disclaimer: 'PoB numbers on the current items and configuration; not a game test.' };
  if (record && applied.length) {
    try { report.lab = createRecord(labRecordInput(report, { input, options: { scenario, metric, keep, radius, maxSwaps, phases, group, slots, maxChaos, limit, rounds } }), { file: ledger, reason: 'design optimize --record' }).id; }
    catch (e) { report.lab_error = e.message.slice(0, 300); }
  }
  return report;
}
export const optimizeTree = optimizeBuild;
const fileSha = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
// Pure except the input hash: lab experiment with every applied step's exact changes (replayable in order).
export function labRecordInput(report, { input, options }) {
  const steps = report.steps.filter(s => s.result === 'applied').map(s => ({ phase: s.phase, label: s.label, changes: s.changes, xml: s.xml, calculation_id: s.calculation_id, gain_pct: s.gain_pct }));
  return { type: 'experiment', status: 'done', title: `design optimize ${report.file}`.slice(0, 200), tags: ['wp6', 'design-optimize'],
    statement: `Joint optimisation (${report.phases.join(' -> ')}): DPS ${report.change.dps_pct}%, EHP ${report.change.ehp_pct}%, max hit ${report.change.maxhit_pct}% in ${steps.length} applied steps.`,
    data: { tool: 'design optimize', input: { file: rel(input), sha256: fileSha(input) }, options, start: report.start, end: report.end, steps },
    evidence: [{ kind: 'calculation', ref: report.result_xml, summary: `PoB: ${steps.length} applied steps, end values ${JSON.stringify(report.end)}` }] };
}

// Re-applies the recorded steps of a lab experiment to its input (hash checked) and compares the end values.
export function replayOptimization(id, { out = null, ledger = defaultLedger() } = {}) {
  const rec = loadLedger(ledger).get(id);
  if (!rec || rec.data?.tool !== 'design optimize') throw new Error(`${id} is not a design optimize record`);
  const input = path.resolve(projectRoot, rec.data.input.file);
  if (!fs.existsSync(input)) throw new Error(`Input ${rec.data.input.file} not found`);
  if (fileSha(input) !== rec.data.input.sha256) throw new Error(`Input ${rec.data.input.file} changed since ${id} (sha256 mismatch)`);
  const dir = path.dirname(path.resolve(out ?? input)), stem = path.basename(out ?? input, '.xml');
  let current = input, run = null;
  rec.data.steps.forEach((s, i) => {
    const next = path.join(dir, `${stem}.replay${i + 1}.xml`);
    if (fs.existsSync(next)) fs.rmSync(next);
    run = runPob({ input: fs.readFileSync(current), scenario: rec.data.options.scenario, changes: s.changes, saveXml: next });
    current = next;
  });
  if (out) fs.copyFileSync(current, path.resolve(out));
  const v = run ? valuesOf(run.output, run.minion_output) : null;
  const end = v && { dps: round(v.dps, 0), ehp: round(v.ehp, 0), maxhit: round(v.maxhit, 0), mana: round(v.mana) };
  return { analysis: 'joint_optimize_replay', record: id, steps: rec.data.steps.length, result_xml: rel(out ? path.resolve(out) : current), end, recorded_end: rec.data.end,
    matches: end ? ['dps', 'ehp', 'maxhit'].every(k => Math.abs((end[k] ?? 0) - (rec.data.end[k] ?? 0)) <= Math.max(1, Math.abs(rec.data.end[k] ?? 0) * 0.001)) : null };
}

const listOpt = v => v == null ? null : String(v).split(',').map(s => s.trim()).filter(Boolean);
export function optimizeCommand(args) {
  const { positional, options } = flags(args, ['metric', 'rounds', 'keep', 'radius', 'out', 'scenario', 'concurrency', 'phases', 'max-swaps', 'group', 'slots', 'max-chaos', 'limit', 'min-gain', 'replay'], ['record', 'exclude-awakened']);
  if (options.replay) return replayOptimization(options.replay, { out: options.out ?? null });
  if (positional[0] !== 'optimize' || !positional[1]) throw new Error(`Use ${Object.keys(optimizeHelp)[0]}`);
  const num = (k, d) => options[k] == null ? d : Number(options[k]);
  return optimizeBuild({ file: path.resolve(positional[1]), metric: options.metric ?? 'balanced', rounds: num('rounds', 3), keep: num('keep', 0.97), radius: num('radius', 4), maxSwaps: num('max-swaps', 3),
    phases: listOpt(options.phases) ?? phaseNames, group: num('group', null), slots: listOpt(options.slots), maxChaos: num('max-chaos', null), limit: num('limit', 40), minGain: num('min-gain', 0.5),
    excludeAwakened: !!options['exclude-awakened'], scenario: options.scenario ?? 'sustained', concurrency: num('concurrency', defaultConcurrency), out: options.out ?? null, record: !!options.record });
}
export const optimizeHelp = {
  'design optimize <xml> [--phases tree,supports,items] [--rounds 3] [--metric balanced|dps|ehp] [--keep 0.97] [--radius 4] [--max-swaps 3] [--group N] [--max-chaos N] [--slots a,b] [--limit 40] [--exclude-awakened] [--out new.xml] [--record]':
    'WP6 joint optimisation by PoB: cycles of tree (several disjoint node swaps checked as one PoB variant) -> supports -> items (analyze upgrades --auto supports|uniques|anoints; uniques only with --max-chaos and an observed price); each applied step is a real edit re-checked against EHP/max hit/mana sustain/requirements/passive budget; --record writes the steps to lab',
  'design optimize --replay <E-id> [--out new.xml]': 'Re-apply the recorded steps of a design optimize lab experiment to its input (sha256 checked) and compare the end values'
};
