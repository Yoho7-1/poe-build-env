// Structural novelty (WP8, part 1): how different a build's architecture is from the corpus, separate from performance.
// A BuildCard is reduced to a structural vector (ascendancy, skill and delivery, damage form/types, scaling supports,
// defense model, sustain, keystones, uniques, crit). Each group gives a distance in 0..1 (categorical: 0/1, sets: Jaccard,
// share vectors: half L1); the weighted mean is the distance between two cards. novelty = distance to the nearest
// corpus card (quality-filtered by default), so a corpus duplicate scores ~0, one swapped item scores low and another
// archetype scores high. Numbers (DPS, EHP) are deliberately not part of the vector: performance is a separate axis.
// Weights: `noveltyPriorWeights` is the stated prior; `noveltyWeights` is fitted by calibrateNoveltyWeights() on corpus
// pairs "variant of one archetype" (same main skill + ascendancy) vs "other archetype". The label groups (ascendancy,
// main_skill, and delivery/damage_scope which follow from the main skill) are not fitted and keep their prior. Read `differences` before trusting the score.
// Crit axis: chance and crit share of hit damage, from card.damage.crit when a card carries it, else from the PoB
// calculation cached under card.identity.calculation_id (no new calculation). Missing on either side -> the axis is
// left out of that pair's weighted mean. More-multipliers are not an axis: neither the card nor the cached calculation
// lists MORE modifiers by source (only supports, which `scaling` already covers).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, flags, dbRoot } from './workspace.mjs';
import { readCards, qualityFilter } from './corpus-learn.mjs';
import { cardDirectory } from './build-card.mjs';

export const noveltyPriorWeights = Object.freeze({
  ascendancy: 1.5, main_skill: 2, delivery: 1.5, damage_scope: 1.5, damage_form: 2, damage_types: 1.5,
  scaling: 1, defense_pool: 1.5, defense_layers: 1, sustain: 0.75, keystones: 1.25, uniques: 1, crit: 1
});
// Checked by calibrateNoveltyWeights() on the local corpus (152 cards, 50 variant pairs / 22 archetypes, 24.11.2026):
// prior structure AUC 0.940 (hard 0.871), archetype-fold CV 0.919; no fitted weighting beat it on held-out archetypes by
// more than 0.005, so the prior stays (crit: 1 added; CV 0.911 -> 0.919). Reproduce: corpus novelty --calibrate --all.
export const noveltyWeights = Object.freeze({ ...noveltyPriorWeights });
// Main-skill tags that describe how damage is delivered (not element or attribute).
const deliveryTags = new Set(['attack', 'spell', 'minion', 'totem', 'trap', 'mine', 'brand', 'melee', 'projectile', 'area', 'channelling', 'chaining', 'bow', 'strike', 'slam', 'retaliation', 'warcry', 'herald', 'golem', 'triggerable', 'orb', 'nova', 'blink', 'travel', 'duration']);
const sustainLayers = new Set(['life_recoup', 'life_leech', 'life_regen', 'energy_shield', 'eldritch_battery', 'ward']);
const formKeys = ['hit', 'skill_dot', 'ignite', 'poison', 'bleed', 'decay'];
const typeKeys = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'];
const finite = v => typeof v === 'number' && Number.isFinite(v);
const r3 = v => Math.round(v * 1000) / 1000;

// ---------- crit (saved data only) ----------
export const calculationDirectory = () => path.join(dbRoot, 'cache/calculations');
const calcCache = new Map();
function cachedCalculation(id, dir) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16,}$/i.test(id)) return null;
  const file = path.join(dir, `${id}.json`);
  if (!calcCache.has(file)) { let v = null; try { if (fs.existsSync(file)) v = readJson(file); } catch { v = null; } calcCache.set(file, v); }
  return calcCache.get(file);
}
// Crit of the main skill: chance 0..1 (capped) and share of hit damage from the crit bonus, c*(m-1)/(1+c*(m-1)).
// Player scope reads PoB `output`, minion scope `minion_output`. null when nothing is saved.
export function critProfile(card, { calcDir = calculationDirectory() } = {}) {
  const own = card.damage?.crit;
  let cc, cm, source;
  if (own && finite(own.chance) && finite(own.multiplier)) { cc = own.chance; cm = own.multiplier; source = 'card'; }
  else {
    const calc = cachedCalculation(card.identity?.calculation_id, calcDir);
    const out = !calc ? null : (card.damage?.scope ?? card.features?.damage_scope) === 'minion' ? calc.minion_output : calc.output;
    if (!out || !finite(out.CritChance) || !finite(out.CritMultiplier)) return null;
    cc = out.CritChance; cm = out.CritMultiplier; source = 'calculation_cache';
  }
  const chance = Math.max(0, Math.min(1, cc / 100)), bonus = chance * Math.max(0, cm - 1);
  return { chance: r3(chance), multiplier: r3(cm), share: r3(bonus / (1 + bonus)), source };
}

// ---------- vector ----------
export function noveltyVector(card, { calcDir } = {}) {
  const f = card.features ?? {};
  const main = card.skills?.main ?? {};
  const layers = f.defense_layers ?? card.defense?.layers ?? [];
  const sustained = card.resources?.sustained;
  const shares = (obj, keys) => Object.fromEntries(keys.map(k => [k, finite(obj?.[k]) ? obj[k] : 0]));
  return {
    ascendancy: f.ascendancy ?? null, class: f.class ?? null,
    main_skill: f.main_skill ?? null,
    delivery: (main.tags ?? []).filter(t => deliveryTags.has(t)).sort(),
    damage_scope: f.damage_scope ?? card.damage?.scope ?? 'player',
    damage_form: shares(card.damage?.parts, formKeys), primary_form: f.primary_form ?? null,
    damage_types: shares(card.damage?.types, typeKeys), primary_type: f.primary_type ?? null,
    scaling: [...(main.supports ?? [])].sort(),
    defense_pool: f.defense_pool ?? card.defense?.pool ?? null,
    defense_layers: layers.filter(l => !sustainLayers.has(l)).sort(),
    sustain: [...layers.filter(l => sustainLayers.has(l)), ...(sustained === true ? ['mana_sustained'] : sustained === false ? ['mana_unsustained'] : [])].sort(),
    keystones: [...(f.keystones ?? [])].sort(), uniques: [...(f.uniques ?? [])].sort(),
    crit: critProfile(card, calcDir ? { calcDir } : {})
  };
}

const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return 1 - i / (A.size + B.size - i); };
const halfL1 = (a, b) => { const keys = new Set([...Object.keys(a), ...Object.keys(b)]); const sa = Object.values(a).reduce((s, v) => s + v, 0), sb = Object.values(b).reduce((s, v) => s + v, 0);
  if (!sa && !sb) return 0; if (!sa || !sb) return 1; let d = 0; for (const k of keys) d += Math.abs((a[k] ?? 0) / sa - (b[k] ?? 0) / sb); return Math.min(1, d / 2); };
// Unknown (null) on either side counts as half a difference: neither proven equal nor different.
const categorical = (a, b) => a == null || b == null ? 0.5 : a === b ? 0 : 1;

export function groupDistances(va, vb) {
  return {
    // Same class, other ascendancy is a smaller step than another class.
    ascendancy: va.ascendancy === vb.ascendancy && va.ascendancy != null ? 0 : va.class && va.class === vb.class ? 0.7 : categorical(va.ascendancy, vb.ascendancy),
    main_skill: categorical(va.main_skill, vb.main_skill), delivery: jaccard(va.delivery, vb.delivery), damage_scope: categorical(va.damage_scope, vb.damage_scope),
    damage_form: halfL1(va.damage_form, vb.damage_form), damage_types: halfL1(va.damage_types, vb.damage_types), scaling: jaccard(va.scaling, vb.scaling),
    defense_pool: categorical(va.defense_pool, vb.defense_pool), defense_layers: jaccard(va.defense_layers, vb.defense_layers), sustain: jaccard(va.sustain, vb.sustain),
    keystones: jaccard(va.keystones, vb.keystones), uniques: jaccard(va.uniques, vb.uniques),
    // Not saved on either side -> null: dropped from this pair's weighted mean, not guessed.
    crit: va.crit && vb.crit ? (Math.abs(va.crit.chance - vb.crit.chance) + Math.abs(va.crit.share - vb.crit.share)) / 2 : null
  };
}

const weightedMean = (groups, weights) => { let sum = 0, w = 0; for (const [k, d] of Object.entries(groups)) { if (d == null) continue; const wk = weights[k] ?? 0; sum += wk * d; w += wk; } return w ? sum / w : 0; };
export function cardDistance(a, b, weights = noveltyWeights) {
  const va = a.vector ?? noveltyVector(a), vb = b.vector ?? noveltyVector(b);
  const groups = groupDistances(va, vb);
  return { distance: r3(weightedMean(groups, weights)), groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v == null ? null : r3(v)])) };
}

// What differs from a neighbour, in words a player reads (only groups that differ and carry weight).
export function describeDifferences(va, vb, groups, weights = noveltyWeights) {
  const setDiff = (a, b) => ({ added: a.filter(x => !b.includes(x)), removed: b.filter(x => !a.includes(x)) });
  const wt = k => weights[k] ?? 0;
  const out = [];
  for (const [k, d] of Object.entries(groups).sort((x, y) => wt(y[0]) * (y[1] ?? 0) - wt(x[0]) * (x[1] ?? 0))) {
    if (!(d > 0) || !(wt(k) > 0)) continue;
    const row = { group: k, distance: d, weighted: r3(d * wt(k)) };
    if (Array.isArray(va[k])) Object.assign(row, setDiff(va[k], vb[k]));
    else if (k === 'damage_form') Object.assign(row, { this: va.primary_form, neighbour: vb.primary_form });
    else if (k === 'damage_types') Object.assign(row, { this: va.primary_type, neighbour: vb.primary_type });
    else if (k === 'ascendancy') Object.assign(row, { this: `${va.class}/${va.ascendancy}`, neighbour: `${vb.class}/${vb.ascendancy}` });
    else if (k === 'crit') Object.assign(row, { this: { chance: va.crit.chance, share: va.crit.share }, neighbour: { chance: vb.crit.chance, share: vb.crit.share } });
    else Object.assign(row, { this: va[k], neighbour: vb[k] });
    out.push(row);
  }
  return out;
}

const cardId = c => c._card ?? c.identity?.file ?? c.signature ?? null;
// Generator API (WP5): noveltyScore(card, corpus) -> { novelty 0..1, nearest[] }. corpus = array of BuildCards
// (use loadNoveltyCorpus() for the quality-filtered local corpus). The card itself (same pob_sha256) is skipped.
export function noveltyScore(card, corpus, { top = 5, weights = noveltyWeights } = {}) {
  const v = noveltyVector(card);
  const self = card.identity?.pob_sha256 ?? null;
  const skipped = [];
  const rows = [];
  for (const c of corpus) {
    if (self && c.identity?.pob_sha256 === self) { skipped.push(cardId(c)); continue; }
    const vc = noveltyVector(c);
    rows.push({ c, vc, ...cardDistance({ vector: v }, { vector: vc }, weights) });
  }
  rows.sort((a, b) => a.distance - b.distance || String(cardId(a.c)).localeCompare(String(cardId(b.c))));
  const nearest = rows.slice(0, top).map(r => ({ card: cardId(r.c), distance: r.distance, signature: r.c.signature ?? null, same_signature: !!card.signature && r.c.signature === card.signature,
    ascendancy: r.c.features?.ascendancy ?? null, main_skill: r.c.features?.main_skill ?? null, form: r.c.features?.primary_form ?? null, type: r.c.features?.primary_type ?? null,
    pool: r.c.features?.defense_pool ?? null, source: r.c.identity?.source ?? null, differences: describeDifferences(v, r.vc, r.groups, weights) }));
  const dists = rows.map(r => r.distance);
  const meanK = arr => arr.length ? r3(arr.reduce((s, x) => s + x, 0) / arr.length) : null;
  return {
    novelty: rows.length ? rows[0].distance : null,
    novelty_mean_top: meanK(dists.slice(0, top)),
    band: !rows.length ? null : rows[0].distance < 0.05 ? 'duplicate' : rows[0].distance < 0.2 ? 'variant' : rows[0].distance < 0.4 ? 'related' : 'novel',
    compared: rows.length, skipped_self: skipped, nearest,
    same_ascendancy_skill: rows.filter(r => r.c.features?.ascendancy === v.ascendancy && r.c.features?.main_skill === v.main_skill).length
  };
}

export function loadNoveltyCorpus({ directory = cardDirectory(), all = false, minLevel = 80 } = {}) {
  const cards = readCards(directory);
  if (all) return { cards, filter: null };
  const q = qualityFilter(cards, { minLevel });
  const stem = c => String(c.identity?.file ?? c._card ?? '').replace(/\.(xml|json)$/i, '');
  return { cards: cards.filter(c => q.keep.has(stem(c))), filter: { min_level: q.min_level, cards: q.cards, kept: q.kept, excluded: q.excluded.length } };
}

// ---------- calibration ----------
// Label: a pair is a "variant" when both cards share main skill and ascendancy (other items/tree), "other" otherwise;
// "hard" others share one of the two. Label groups - ascendancy, main_skill and the groups that follow from the main
// skill alone (delivery = its tags, damage_scope = minion or not) - are excluded from the fit and from the structure
// metric, so the score cannot win by restating the label; they keep their prior. Fitted weights stay on the grid
// (floor 0.25: no structural axis is switched off by the fit). Objective = mean of structure AUC over all others and hard others.
const labelGroups = ['ascendancy', 'main_skill', 'delivery', 'damage_scope'];
export const archetypeKey = c => `${c.features?.main_skill ?? '?'}|${c.features?.ascendancy ?? '?'}`;
export const noveltyCalibrationGrid = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]);

export function noveltyPairs(cards, { calcDir } = {}) {
  const vectors = cards.map(c => noveltyVector(c, calcDir ? { calcDir } : {}));
  const pairs = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j], fa = a.features ?? {}, fb = b.features ?? {};
    if (!fa.main_skill || !fb.main_skill || !fa.ascendancy || !fb.ascendancy) continue;
    if (a.identity?.pob_sha256 && a.identity.pob_sha256 === b.identity?.pob_sha256) continue;
    const sameSkill = fa.main_skill === fb.main_skill, sameAsc = fa.ascendancy === fb.ascendancy;
    pairs.push({ i, j, positive: sameSkill && sameAsc, hard: !(sameSkill && sameAsc) && (sameSkill || sameAsc), groups: groupDistances(vectors[i], vectors[j]) });
  }
  return { pairs, vectors };
}

// Pairs packed into a flat table (NaN = axis not saved for that pair) so the fit evaluates thousands of weightings fast.
const groupKeys = Object.keys(noveltyPriorWeights);
function packPairs(pairs) {
  const K = groupKeys.length, D = new Float64Array(pairs.length * K);
  pairs.forEach((p, r) => groupKeys.forEach((k, c) => { D[r * K + c] = p.groups[k] ?? NaN; }));
  return { n: pairs.length, K, D, pos: pairs.map(p => p.positive), hard: pairs.map(p => p.hard) };
}
function packedDistances(P, weights) {
  const w = groupKeys.map(k => weights[k] ?? 0), out = new Float64Array(P.n);
  for (let r = 0; r < P.n; r++) { let s = 0, t = 0; for (let c = 0; c < P.K; c++) { const d = P.D[r * P.K + c]; if (d !== d) continue; s += w[c] * d; t += w[c]; } out[r] = t ? s / t : 0; }
  return out;
}
const bound = (arr, x, upper) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (upper ? arr[m] <= x : arr[m] < x) lo = m + 1; else hi = m; } return lo; };
// AUC = P(an "other" pair is farther than a "variant" pair); ties count half (Mann-Whitney).
function aucOf(pos, neg) {
  if (!pos.length || !neg.length) return null;
  neg.sort();
  let s = 0;
  for (const d of pos) { const lo = bound(neg, d, false), hi = bound(neg, d, true); s += neg.length - hi + (hi - lo) / 2; }
  return s / (pos.length * neg.length);
}
function packedAuc(P, weights) {
  const d = packedDistances(P, weights), pos = [], neg = [], hard = [];
  for (let r = 0; r < P.n; r++) { if (P.pos[r]) pos.push(d[r]); else { neg.push(d[r]); if (P.hard[r]) hard.push(d[r]); } }
  return { all: aucOf(pos, Float64Array.from(neg)), hard: aucOf(pos, Float64Array.from(hard)), d };
}
export function pairAuc(pairs, weights, { hardOnly = false } = {}) { const a = packedAuc(packPairs(pairs), weights); return hardOnly ? a.hard : a.all; }
const structureOnly = w => ({ ...w, ...Object.fromEntries(labelGroups.map(k => [k, 0])) });
const packedObjective = (P, w) => { const a = packedAuc(P, structureOnly(w)); return a.all == null ? null : a.hard == null ? a.all : (a.all + a.hard) / 2; };
const fitKeys = groupKeys.filter(k => !labelGroups.includes(k));
const penaltyOf = w => fitKeys.reduce((s, k) => s + Math.abs((w[k] ?? 0) - noveltyPriorWeights[k]), 0);

export function noveltyMetrics(pairs, weights) {
  const P = packPairs(pairs), s = packedAuc(P, structureOnly(weights)), full = packedAuc(P, weights);
  const mean = pos => { let t = 0, n = 0; for (let r = 0; r < P.n; r++) if (P.pos[r] === pos) { t += full.d[r]; n++; } return n ? r3(t / n) : null; };
  const rr = v => v == null ? null : r3(v);
  return { auc_structure: rr(s.all), auc_structure_hard: rr(s.hard), auc_full: rr(full.all), mean_distance_variant: mean(true), mean_distance_other: mean(false) };
}

// Deterministic coordinate ascent over the grid from the prior, maximising objective - lambda * sum|w - prior| (shrinkage
// toward the prior); a step is taken only if it raises that by more than 1e-4.
export function fitNoveltyWeights(pairs, { start = noveltyPriorWeights, grid = noveltyCalibrationGrid, passes = 4, lambda = 0 } = {}) {
  const P = pairs.D ? pairs : packPairs(pairs);
  const w = { ...start };
  const score = x => { const o = packedObjective(P, x); return o == null ? null : o - lambda * penaltyOf(x); };
  let best = score(w);
  if (best == null) return { weights: w, objective: null, passes: 0 };
  let pass = 0;
  for (; pass < passes; pass++) {
    let moved = false;
    for (const k of fitKeys) for (const v of grid) {
      if (v === w[k]) continue;
      const o = score({ ...w, [k]: v });
      if (o > best + 1e-4) { best = o; w[k] = v; moved = true; }
    }
    if (!moved) break;
  }
  return { weights: w, objective: r3(packedObjective(P, w)), penalised: r3(best), passes: pass + 1 };
}

// Folds by archetype (hash of main skill|ascendancy), so variants of one archetype never sit on both sides. The shrinkage
// strength lambda is chosen by that cross-validation (highest mean held-out objective; ties within 0.002 -> stronger shrinkage).
const foldOf = (c, folds) => parseInt(createHash('sha1').update(archetypeKey(c)).digest('hex').slice(0, 8), 16) % folds;
export const noveltyCalibrationLambdas = Object.freeze([0, 0.0025, 0.005, 0.01, 0.02]);
// Adoption: the fitted weights are recommended only if they beat the prior on held-out archetypes by more than minGain.
export function calibrateNoveltyWeights(cards, { folds = 5, grid = noveltyCalibrationGrid, passes = 4, lambdas = noveltyCalibrationLambdas, minGain = 0.005, calcDir } = {}) {
  const { pairs, vectors } = noveltyPairs(cards, { calcDir });
  const fold = cards.map(c => foldOf(c, folds));
  const splits = [];
  for (let f = 0; f < folds; f++) {
    const test = pairs.filter(p => fold[p.i] === f && fold[p.j] === f), train = pairs.filter(p => fold[p.i] !== f && fold[p.j] !== f);
    const positives = test.filter(p => p.positive).length;
    splits.push({ fold: f, positives, others: test.length - positives, ok: positives > 0 && positives < test.length && train.some(p => p.positive), test: packPairs(test), train: packPairs(train) });
  }
  const used = splits.filter(x => x.ok), tot = used.reduce((s, x) => s + x.positives, 0);
  const wmean = vals => tot ? r3(vals.reduce((s, v, i) => s + v * used[i].positives, 0) / tot) : null;
  const cvBefore = wmean(used.map(x => packedObjective(x.test, noveltyPriorWeights)));
  const byLambda = lambdas.map(lambda => {
    const rows = used.map(x => packedObjective(x.test, fitNoveltyWeights(x.train, { grid, passes, lambda }).weights));
    return { lambda, mean_after: wmean(rows), folds: rows.map(r3) };
  });
  const top = Math.max(...byLambda.map(x => x.mean_after ?? -1));
  const chosen = [...byLambda].reverse().find(x => x.mean_after != null && x.mean_after >= top - 0.002) ?? { lambda: 0 };
  const all = packPairs(pairs);
  const fit = fitNoveltyWeights(all, { grid, passes, lambda: chosen.lambda });
  const weights = { ...fit.weights, ...Object.fromEntries(labelGroups.map(k => [k, noveltyPriorWeights[k]])) };
  const adopted = chosen.mean_after != null && cvBefore != null && chosen.mean_after > cvBefore + minGain;
  const cv = splits.map(x => ({ fold: x.fold, positives: x.positives, others: x.others, ...(x.ok ? { before: r3(packedObjective(x.test, noveltyPriorWeights)) } : { skipped: 'no variant or no other pair' }) }));
  const archetypes = new Set(pairs.filter(p => p.positive).map(p => archetypeKey(cards[p.i])));
  return {
    analysis: 'novelty_calibration', cards: cards.length,
    pairs: { variant: pairs.filter(p => p.positive).length, other: pairs.filter(p => !p.positive).length, other_hard: pairs.filter(p => p.hard).length, archetypes_with_variants: archetypes.size },
    crit_coverage: vectors.filter(v => v.crit).length,
    objective: 'mean of structure AUC over all other-archetype pairs and over hard ones (label groups excluded)',
    before: { weights: { ...noveltyPriorWeights }, objective: r3(packedObjective(all, noveltyPriorWeights)), ...noveltyMetrics(pairs, noveltyPriorWeights) },
    after: { weights, objective: fit.objective, lambda: chosen.lambda, passes: fit.passes, ...noveltyMetrics(pairs, weights) },
    cross_validation: { folds, by: 'archetype', label_groups: labelGroups, mean_before: cvBefore, mean_after: chosen.mean_after ?? null, lambda: chosen.lambda, by_lambda: byLambda, rows: cv },
    adopted, min_gain: minGain, recommended_weights: adopted ? weights : { ...noveltyPriorWeights },
    note: 'In-sample before/after use every pair; cross_validation fits on archetypes outside the fold and scores the fold (weighted by variant pairs). Label groups (ascendancy, main_skill, delivery, damage_scope) keep their prior weights; auc_full includes them and is near 1 by construction.'
  };
}

// ---------- CLI ----------
export async function noveltyCommand(args) {
  const { positional, options } = flags(args, ['top', 'dir', 'min-level', 'scenario', 'folds'], ['all', 'help', 'vector', 'calibrate']);
  const target = positional[1];
  const directory = options.dir ? path.resolve(options.dir) : cardDirectory();
  const minLevel = options['min-level'] ? Number(options['min-level']) : 80;
  if (options.calibrate) {
    const { cards, filter } = loadNoveltyCorpus({ directory, all: !!options.all, minLevel });
    return { ...calibrateNoveltyWeights(cards, { folds: options.folds ? Math.max(2, Number(options.folds)) : 5 }), corpus: { directory, quality_filter: filter }, current_weights: noveltyWeights };
  }
  if (options.help || !target) return { command: 'corpus novelty', usage: Object.keys(noveltyHelp), description: Object.values(noveltyHelp), weights: noveltyWeights, prior_weights: noveltyPriorWeights };
  const file = path.resolve(target);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${target}`);
  let card;
  if (/\.json$/i.test(file)) {
    card = readJson(file);
    if (card.kind !== 'build_card') throw new Error('JSON input must be a BuildCard (build card <xml> --out f.json)');
  } else {
    const { buildCard } = await import('./build-card.mjs');
    card = buildCard({ file, scenario: options.scenario ?? 'sustained' });
  }
  const { cards, filter } = loadNoveltyCorpus({ directory, all: !!options.all, minLevel });
  const top = options.top ? Math.max(1, Number(options.top)) : 5;
  const score = noveltyScore(card, cards, { top });
  return { analysis: 'novelty', input: path.basename(file), signature: card.signature ?? null,
    build: { class: card.features?.class, ascendancy: card.features?.ascendancy, main_skill: card.features?.main_skill, form: card.features?.primary_form, type: card.features?.primary_type, pool: card.features?.defense_pool },
    ...score, ...(options.vector ? { vector: noveltyVector(card) } : {}),
    corpus: { directory, quality_filter: filter }, weights: noveltyWeights,
    note: 'Structural distance to the nearest corpus card (0 = same architecture, 1 = shares nothing); bands duplicate < 0.05 <= variant < 0.2 <= related < 0.4 <= novel. Performance (DPS/EHP) is not part of it. Weights are fitted on corpus variant/other-archetype pairs (corpus novelty --calibrate); crit comes from the cached PoB calculation, more-multipliers are not modelled; unmodelled mechanics are not seen by the card.' };
}
export const noveltyHelp = {
  'corpus novelty <file.xml|card.json> [--top 5] [--all] [--min-level 80] [--dir cards] [--vector]':
    'Structural novelty vs the corpus cards (quality filter by default): weighted distance over ascendancy, main skill/delivery, damage form/types, scaling supports, defense pool/layers, sustain, keystones, uniques, crit (cached PoB calculation) -> novelty 0..1, band, nearest neighbours and what differs; separate from performance. API for generators: noveltyScore(card, corpus)',
  'corpus novelty --calibrate [--all] [--folds 5] [--dir cards]':
    'Reproducible weight calibration on corpus pairs: variant (same main skill + ascendancy) vs other archetype; structure AUC before/after (label groups excluded) and archetype-fold cross-validation'
};
