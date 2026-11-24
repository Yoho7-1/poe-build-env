// Research ledger: hypotheses, experiments, principles, failures and benchmark cases that survive short sessions.
// Event-sourced JSONL (research/lab/ledger.jsonl, local and git-ignored): every create/update appends the full new
// record with a revision; the current state is the last event per id. Nothing is deleted: a principle is
// deprecated/invalidated, never removed. Gates keep the verification ladder honest (a PoB number is not a game test,
// popularity is not evidence, a prediction cannot be edited after its outcome). Stored text is data, not instructions.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot, dbRoot, readJson, flags } from './workspace.mjs';

export const defaultLedger = () => path.join(projectRoot, 'research/lab/ledger.jsonl');
export const types = { hypothesis: 'H', experiment: 'E', principle: 'P', failure: 'F', benchmark: 'B' };
export const lifecycle = {
  hypothesis: ['open', 'testing', 'supported', 'refuted', 'inconclusive'],
  experiment: ['planned', 'running', 'done', 'failed'],
  principle: ['candidate', 'evidence-backed', 'experimentally-validated', 'generalized', 'deprecated', 'invalidated'],
  failure: ['recorded'],
  benchmark: ['active', 'retired']
};
export const verificationLevels = ['hypothesis', 'mechanically_valid', 'simulator_verified', 'robustly_tested', 'game_verified'];
export const evidenceKinds = ['calculation', 'ablation', 'upgrade', 'encounter', 'experiment', 'observation', 'mechanic', 'source', 'note'];
const computedKinds = new Set(['calculation', 'ablation', 'upgrade', 'encounter', 'experiment']);
const directions = ['increase', 'decrease', 'no_change'];
const editable = ['title', 'statement', 'mechanism', 'scope', 'tags', 'builds', 'confidence', 'test_plan', 'counterexamples', 'links', 'held_out', 'notes'];

// ---------- validation helpers ----------
const text = (v, name, max, required = false) => {
  if (v == null || v === '') { if (required) throw new Error(`${name} is required`); return null; }
  if (typeof v !== 'string' || v.length > max) throw new Error(`${name} must be a string up to ${max} characters`);
  return v.trim();
};
const strings = (v, name, max = 50) => {
  if (v == null || v === '') return [];
  const arr = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(arr) || arr.length > max || arr.some(x => typeof x !== 'string' || x.length > 300)) throw new Error(`${name} must be a list of up to ${max} short strings`);
  return [...new Set(arr.map(x => x.trim()).filter(Boolean))];
};
const oneOf = (v, name, list, nullable = true) => {
  if (v == null || v === '') { if (nullable) return null; throw new Error(`${name} is required: ${list.join('|')}`); }
  if (!list.includes(v)) throw new Error(`${name} must be one of ${list.join('|')}`);
  return v;
};
const finite = v => typeof v === 'number' && Number.isFinite(v);
const num = (v, name) => { if (v == null || v === '') return null; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} must be a number`); return n; };
const idPattern = /^[HEPFB]-\d{3,6}$/;
// Structured payload written by local tools (benchmark task, frozen predictions, score); compact JSON only.
export function normData(d) {
  if (d == null) return null;
  if (typeof d !== 'object' || Array.isArray(d) || JSON.stringify(d).length > 50000) throw new Error('data must be a compact object (<= 50 KB)');
  return structuredClone(d);
}
function normScope(s) {
  if (s == null) return { skills: [], ascendancies: [], archetypes: [], content: [], conditions: [] };
  if (typeof s !== 'object' || Array.isArray(s)) throw new Error('scope must be an object');
  for (const k of Object.keys(s)) if (!['skills', 'ascendancies', 'archetypes', 'content', 'conditions'].includes(k)) throw new Error(`Unknown scope field ${k}`);
  return { skills: strings(s.skills, 'scope.skills'), ascendancies: strings(s.ascendancies, 'scope.ascendancies'), archetypes: strings(s.archetypes, 'scope.archetypes'),
    content: strings(s.content, 'scope.content'), conditions: strings(s.conditions, 'scope.conditions') };
}
function normLinks(l) {
  const out = { tests: [], derived_from: [], contradicts: [], supersedes: [] };
  if (l == null) return out;
  if (typeof l !== 'object' || Array.isArray(l)) throw new Error('links must be an object');
  for (const [k, v] of Object.entries(l)) {
    if (!(k in out)) throw new Error(`Unknown links field ${k}`);
    out[k] = strings(v, `links.${k}`);
    for (const id of out[k]) if (!idPattern.test(id)) throw new Error(`links.${k} contains an invalid record id: ${id}`);
  }
  return out;
}
export function normalizeEvidence(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('Evidence must be an object');
  for (const k of Object.keys(e)) if (!['kind', 'ref', 'summary', 'supports', 'build', 'verification', 'at', 'data'].includes(k)) throw new Error(`Unknown evidence field ${k}`);
  const value = { kind: oneOf(e.kind, 'evidence.kind', evidenceKinds, false), ref: text(e.ref, 'evidence.ref', 500), summary: text(e.summary, 'evidence.summary', 2000, true),
    supports: e.supports === false ? false : true, build: text(e.build, 'evidence.build', 200), verification: oneOf(e.verification, 'evidence.verification', verificationLevels),
    at: e.at ?? new Date().toISOString() };
  if (e.data != null) { if (typeof e.data !== 'object' || JSON.stringify(e.data).length > 20000) throw new Error('evidence.data must be a compact object'); value.data = e.data; }
  if (value.verification == null) value.verification = value.kind === 'observation' ? 'game_verified' : computedKinds.has(value.kind) ? 'simulator_verified' : value.kind === 'mechanic' || value.kind === 'source' ? 'mechanically_valid' : 'hypothesis';
  if (value.verification === 'game_verified' && value.kind !== 'observation') throw new Error('Only observation evidence can be game_verified');
  return value;
}

// ---------- gates ----------
const rank = v => verificationLevels.indexOf(v ?? 'hypothesis');
export function checkGates(r) {
  const supporting = r.evidence.filter(e => e.supports);
  // Two or more computed supporting entries (boundary/regression cases) lift simulator evidence to robustly_tested.
  const computed = supporting.filter(e => computedKinds.has(e.kind)).length;
  const best = Math.max(-1, ...supporting.map(e => rank(e.verification)), computed >= 2 ? rank('robustly_tested') : -1);
  if (rank(r.verification) > Math.max(best, 0)) throw new Error(`verification ${r.verification} exceeds the supporting evidence (best: ${verificationLevels[Math.max(best, 0)]})`);
  if (r.verification === 'robustly_tested' && supporting.filter(e => computedKinds.has(e.kind)).length < 2) throw new Error('robustly_tested needs at least two computed evidence entries (boundary/regression cases)');
  if (r.type === 'principle') {
    const builds = new Set(supporting.map(e => e.build).filter(Boolean));
    if (r.status !== 'candidate' && !['deprecated', 'invalidated'].includes(r.status) && !supporting.length) throw new Error(`principle ${r.status} needs supporting evidence`);
    if (['experimentally-validated', 'generalized'].includes(r.status) && !supporting.some(e => computedKinds.has(e.kind) || e.kind === 'observation')) throw new Error(`principle ${r.status} needs experimental evidence (calculation/ablation/upgrade/encounter/experiment/observation)`);
    if (r.status === 'generalized' && builds.size < 2) throw new Error('generalized needs supporting evidence from at least two different builds (transfer)');
    if (r.status === 'generalized' && !r.counterexamples.length && !r.scope.conditions.length) throw new Error('generalized needs stated conditions or known counterexamples (scope.conditions / counterexamples)');
  }
  if (r.type === 'hypothesis' && ['supported', 'refuted'].includes(r.status) && !r.evidence.length && !r.outcome) throw new Error(`hypothesis ${r.status} needs evidence or a resolved prediction`);
  if (r.type === 'hypothesis' && r.status === 'supported' && !supporting.length && r.outcome?.correct !== true) throw new Error('hypothesis supported needs supporting evidence');
  if (r.outcome && !r.prediction) throw new Error('outcome requires a prediction recorded before the test');
}

// ---------- store ----------
function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, i) => { try { return JSON.parse(line); } catch { throw new Error(`ledger line ${i + 1} is not valid JSON`); } });
}
export function loadLedger(file = defaultLedger()) {
  const records = new Map();
  for (const e of readEvents(file)) records.set(e.id, e.record);
  return records;
}
function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.write-lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error(`Ledger is locked (${path.basename(lock)}); another write is in progress or a stale lock must be removed`); }
  try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
const append = (file, event) => fs.appendFileSync(file, JSON.stringify(event) + '\n');
const versions = () => { try { const l = readJson(path.join(dbRoot, 'environment.lock.json')); return { patch: l.patch, pob: l.versions.pob, repoe: l.versions.repoe, ggg_tree: l.versions.ggg_tree }; } catch { return { patch: '3.30' }; } };

export function createRecord(input, { file = defaultLedger(), reason = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Record must be an object');
  for (const k of Object.keys(input)) if (![...editable, 'type', 'status', 'verification', 'evidence', 'prediction', 'data'].includes(k)) throw new Error(`Unknown record field ${k}`);
  const type = oneOf(input.type, 'type', Object.keys(types), false);
  return withLock(file, () => {
    const records = loadLedger(file);
    const prefix = types[type];
    const seq = 1 + Math.max(0, ...[...records.keys()].filter(id => id.startsWith(`${prefix}-`)).map(id => Number(id.slice(2))));
    const now = new Date().toISOString();
    const v = versions();
    const r = {
      schema_version: 1, id: `${prefix}-${String(seq).padStart(3, '0')}`, type, revision: 1,
      title: text(input.title, 'title', 200, true), statement: text(input.statement, 'statement', 4000), mechanism: text(input.mechanism, 'mechanism', 4000),
      status: oneOf(input.status ?? lifecycle[type][0], 'status', lifecycle[type], false), verification: oneOf(input.verification ?? 'hypothesis', 'verification', verificationLevels, false),
      confidence: oneOf(input.confidence, 'confidence', ['low', 'medium', 'high']),
      scope: normScope(input.scope), tags: strings(input.tags, 'tags'), builds: strings(input.builds, 'builds'), links: normLinks(input.links),
      test_plan: text(input.test_plan, 'test_plan', 4000), counterexamples: strings(input.counterexamples, 'counterexamples'), held_out: input.held_out === true,
      notes: text(input.notes, 'notes', 4000), evidence: (input.evidence ?? []).map(normalizeEvidence), data: normData(input.data),
      prediction: null, outcome: null, patch: v.patch, versions: v, created_at: now, updated_at: now, last_verified_at: null
    };
    if (input.prediction) r.prediction = normalizePrediction(input.prediction);
    for (const id of Object.values(r.links).flat()) if (!records.has(id)) throw new Error(`Linked record ${id} does not exist`);
    if (r.evidence.length) r.last_verified_at = now;
    checkGates(r);
    append(file, { event_id: randomUUID(), op: 'create', id: r.id, revision: 1, at: now, reason: text(reason, 'reason', 500), record: r });
    return r;
  });
}
function normalizePrediction(p) {
  if (!p || typeof p !== 'object') throw new Error('prediction must be an object');
  for (const k of Object.keys(p)) if (!['metric', 'direction', 'magnitude_pct', 'tolerance_pct', 'made_at'].includes(k)) throw new Error(`Unknown prediction field ${k}`);
  const magnitude = num(p.magnitude_pct, 'prediction.magnitude_pct');
  return { metric: text(p.metric, 'prediction.metric', 100, true), direction: oneOf(p.direction, 'prediction.direction', directions, false),
    magnitude_pct: magnitude == null ? null : Math.abs(magnitude), tolerance_pct: num(p.tolerance_pct, 'prediction.tolerance_pct') ?? 2, made_at: new Date().toISOString() };
}

// Every mutation: expected revision, full re-validation, one appended event.
export function mutateRecord(id, expectedRevision, mutate, { file = defaultLedger(), reason = null, op = 'update' } = {}) {
  if (!idPattern.test(id ?? '')) throw new Error('Record id like H-001 required');
  if (!Number.isInteger(expectedRevision)) throw new Error('--expected-revision N required');
  return withLock(file, () => {
    const records = loadLedger(file);
    const current = records.get(id);
    if (!current) throw new Error(`Record ${id} not found`);
    if (current.revision !== expectedRevision) throw new Error(`Revision conflict: ${id} is at revision ${current.revision}; reload before changing`);
    const next = structuredClone(current);
    mutate(next, records);
    next.revision = current.revision + 1;
    next.updated_at = new Date().toISOString();
    for (const lid of Object.values(next.links).flat()) if (!records.has(lid) || lid === id) throw new Error(`Linked record ${lid} does not exist or is the record itself`);
    if (['deprecated', 'invalidated', 'refuted', 'retired'].includes(next.status) && next.status !== current.status && !reason) throw new Error(`Changing status to ${next.status} requires --reason`);
    checkGates(next);
    append(file, { event_id: randomUUID(), op, id, revision: next.revision, at: next.updated_at, reason: text(reason, 'reason', 500), record: next });
    return next;
  });
}
export function updateFields(id, rev, patch, opts) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Patch must be an object');
  for (const k of Object.keys(patch)) if (!editable.includes(k)) throw new Error(`Field ${k} is not editable here (status/verification: lab status; evidence: lab evidence; prediction: lab predict/resolve)`);
  return mutateRecord(id, rev, r => {
    if ('title' in patch) r.title = text(patch.title, 'title', 200, true);
    for (const k of ['statement', 'mechanism', 'test_plan', 'notes']) if (k in patch) r[k] = text(patch[k], k, 4000);
    if ('confidence' in patch) r.confidence = oneOf(patch.confidence, 'confidence', ['low', 'medium', 'high']);
    for (const k of ['tags', 'builds', 'counterexamples']) if (k in patch) r[k] = strings(patch[k], k);
    if ('scope' in patch) r.scope = normScope(patch.scope);
    if ('links' in patch) r.links = normLinks(patch.links);
    if ('held_out' in patch) r.held_out = patch.held_out === true;
  }, opts);
}
export const addEvidence = (id, rev, evidence, opts) => mutateRecord(id, rev, r => { r.evidence.push(normalizeEvidence(evidence)); r.last_verified_at = new Date().toISOString(); }, { ...opts, op: 'evidence' });
export const setStatus = (id, rev, { status, verification }, opts) => mutateRecord(id, rev, r => {
  if (status != null) r.status = oneOf(status, 'status', lifecycle[r.type], false);
  if (verification != null) r.verification = oneOf(verification, 'verification', verificationLevels, false);
}, { ...opts, op: 'status' });
export const predict = (id, rev, prediction, opts) => mutateRecord(id, rev, r => {
  if (r.outcome) throw new Error('Prediction cannot change after its outcome was recorded');
  r.prediction = normalizePrediction(prediction);
}, { ...opts, op: 'predict' });
// Outcome scoring: direction must match; with a predicted magnitude the absolute error is reported, and the
// prediction is correct when the error is within max(tolerance, 50% of the predicted magnitude).
export function scoreOutcome(prediction, actualPct) {
  const tol = prediction.tolerance_pct ?? 2;
  const dir = Math.abs(actualPct) <= tol ? 'no_change' : actualPct > 0 ? 'increase' : 'decrease';
  const direction_correct = dir === prediction.direction;
  const magnitude_error_pct = prediction.magnitude_pct == null || prediction.direction === 'no_change' ? null : Math.round(Math.abs(Math.abs(actualPct) - prediction.magnitude_pct) * 100) / 100;
  const magnitude_ok = magnitude_error_pct == null || magnitude_error_pct <= Math.max(tol, prediction.magnitude_pct * 0.5);
  return { actual_pct: actualPct, actual_direction: dir, direction_correct, magnitude_error_pct, correct: direction_correct && magnitude_ok };
}
export const resolve = (id, rev, { actual_pct, notes = null, evidence = null }, opts) => mutateRecord(id, rev, r => {
  if (!r.prediction) throw new Error('No prediction recorded; use lab predict before the test');
  if (r.outcome) throw new Error('Outcome already recorded');
  const a = num(actual_pct, 'actual_pct');
  if (a == null) throw new Error('--actual-pct required');
  r.outcome = { ...scoreOutcome(r.prediction, a), notes: text(notes, 'notes', 2000), resolved_at: new Date().toISOString() };
  if (evidence) { r.evidence.push(normalizeEvidence({ ...evidence, supports: r.outcome.correct })); r.last_verified_at = r.outcome.resolved_at; }
}, { ...opts, op: 'resolve' });

// ---------- queries ----------
const brief = r => ({ id: r.id, type: r.type, status: r.status, verification: r.verification, confidence: r.confidence, title: r.title, revision: r.revision,
  evidence: r.evidence.length, ...(r.prediction && !r.outcome ? { prediction_pending: true } : {}), ...(r.outcome ? { prediction_correct: r.outcome.correct } : {}) });
export function listRecords({ file = defaultLedger(), type = null, status = null, tag = null, search = null, build = null, limit = 20 } = {}) {
  let rows = [...loadLedger(file).values()];
  if (type) rows = rows.filter(r => r.type === type);
  if (status) rows = rows.filter(r => r.status === status);
  if (tag) rows = rows.filter(r => r.tags.includes(tag));
  if (build) rows = rows.filter(r => r.builds.includes(build) || r.evidence.some(e => e.build === build));
  if (search) { const s = search.toLowerCase(); rows = rows.filter(r => [r.title, r.statement, r.mechanism, ...r.tags].some(x => x?.toLowerCase().includes(s))); }
  rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { total: rows.length, records: rows.slice(0, limit).map(brief) };
}
export function getRecord(id, { file = defaultLedger(), history = false } = {}) {
  const events = readEvents(file).filter(e => e.id === id);
  if (!events.length) throw new Error(`Record ${id} not found`);
  const record = events.at(-1).record;
  return history ? { record, history: events.map(e => ({ revision: e.revision, op: e.op, at: e.at, reason: e.reason, status: e.record.status, verification: e.record.verification })) } : record;
}
export function ledgerStats({ file = defaultLedger(), staleDays = 90, patch = versions().patch } = {}) {
  const rows = [...loadLedger(file).values()];
  const count = key => rows.reduce((m, r) => { const k = `${r.type}:${r[key]}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const resolved = rows.filter(r => r.outcome);
  const errors = resolved.map(r => r.outcome.magnitude_error_pct).filter(finite);
  const cutoff = Date.now() - staleDays * 86400000;
  const reverify = rows.filter(r => r.type === 'principle' && !['deprecated', 'invalidated'].includes(r.status) && (r.patch !== patch || !r.last_verified_at || Date.parse(r.last_verified_at) < cutoff)).map(r => r.id);
  return { records: rows.length, by_status: count('status'), by_verification: count('verification'),
    predictions: { pending: rows.filter(r => r.prediction && !r.outcome).length, resolved: resolved.length,
      direction_accuracy: resolved.length ? round(resolved.filter(r => r.outcome.direction_correct).length / resolved.length) : null,
      accuracy: resolved.length ? round(resolved.filter(r => r.outcome.correct).length / resolved.length) : null,
      mean_magnitude_error_pct: errors.length ? round(errors.reduce((a, b) => a + b, 0) / errors.length) : null,
      held_out: { resolved: resolved.filter(r => r.held_out).length, accuracy: resolved.some(r => r.held_out) ? round(resolved.filter(r => r.held_out && r.outcome.correct).length / resolved.filter(r => r.held_out).length) : null } },
    open_hypotheses: rows.filter(r => r.type === 'hypothesis' && ['open', 'testing'].includes(r.status)).map(r => r.id),
    principles_to_reverify: reverify,
    note: 'Calibration counts only predictions recorded before their outcome. Ledger size is not quality; accuracy on held-out cases is.' };
}
const round = v => Math.round(v * 1000) / 1000;
// Compact block for bootstrap: counts and what is open, no record bodies.
export function ledgerBrief(file = defaultLedger()) {
  if (!fs.existsSync(file)) return { records: 0, hint: 'agent.mjs lab add --type hypothesis --title "..."' };
  const rows = [...loadLedger(file).values()];
  const open = rows.filter(r => (r.type === 'hypothesis' && ['open', 'testing'].includes(r.status)) || (r.type === 'experiment' && ['planned', 'running'].includes(r.status)) || (r.prediction && !r.outcome))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5).map(r => `${r.id} ${r.status}: ${r.title.slice(0, 80)}`);
  return { records: rows.length, principles: rows.filter(r => r.type === 'principle' && !['deprecated', 'invalidated'].includes(r.status)).length, open, list: 'agent.mjs lab list' };
}

// ---------- import of analysis output ----------
// analyze ablate JSON -> one experiment record (done, simulator_verified) with a compact summary as evidence.
export function experimentFromAblation(report, { build = null, hypothesis = null } = {}) {
  if (report?.analysis !== 'ablation' || report.plan) throw new Error('Expected analyze ablate output (not --plan)');
  const pick = tier => report.rows.filter(r => r.tier === tier).map(r => ({ label: r.label, kind: r.kind, dps: r.offense_loss_pct, def: r.defense_loss_pct, ...(r.confounded ? { confounded: true } : {}) }));
  const core = pick('core'), major = pick('major');
  const file = path.basename(report.file ?? 'build.xml');
  const summary = `Ablation of ${file} (${report.scenario}): ${core.length} core, ${major.length} major, ${(report.summary?.minor ?? []).length} minor, ${(report.summary?.negligible ?? []).length} negligible, ${(report.summary?.removal_improves ?? []).length} removal_improves. Core: ${core.map(c => `${c.label}${c.confounded ? '*' : ''} (-${c.dps ?? 0}% dps/-${c.def ?? 0}% def)`).join('; ').slice(0, 1200)}`;
  return {
    type: 'experiment', title: `Ablation: ${file}`.slice(0, 200), status: 'done', verification: 'simulator_verified', builds: build ? [build] : [], tags: ['ablation'],
    statement: 'Single-component ablation against one baseline and calculation contract (PoB). Not additive; negligible means unmeasured, not useless.',
    links: hypothesis ? { tests: [hypothesis] } : undefined,
    evidence: [{ kind: 'ablation', ref: `contract ${report.contract?.calculation_contract_sha256?.slice(0, 16) ?? '?'} input ${report.contract?.input_sha256?.slice(0, 16) ?? '?'}`, summary, build,
      data: { baseline: report.baseline?.values, thresholds: report.thresholds, core, major, negligible: report.summary?.negligible, removal_improves: report.summary?.removal_improves } }]
  };
}

// analyze interactions JSON -> experiment record; independent results are kept (a negative result is evidence too).
export function experimentFromInteractions(report, { build = null, hypothesis = null } = {}) {
  if (report?.analysis !== 'interactions') throw new Error('Expected analyze interactions output');
  const file = path.basename(report.file ?? 'build.xml');
  const notable = [...(report.pairs ?? []), ...(report.triples ?? [])].filter(x => ['synergy', 'overlap'].includes(x.class));
  const s = report.summary ?? {};
  const summary = `Interactions of ${file} (${report.scenario}, threshold ${Math.round((report.threshold ?? 0.05) * 100)}%): ${s.synergy ?? 0} synergy, ${s.overlap ?? 0} overlap, ${s.independent ?? 0} independent pairs; ${(report.triples ?? []).length} triples. ${notable.length ? `Non-additive: ${notable.map(x => `${x.labels.join(' + ')} ${x.class} ${x.metric} ${Math.round(x.interaction * 1000) / 10}%`).join('; ').slice(0, 1200)}` : 'No non-additive pair above the threshold.'}`;
  return {
    type: 'experiment', title: `Interactions: ${file}`.slice(0, 200), status: 'done', verification: 'simulator_verified', builds: build ? [build] : [], tags: ['interactions'],
    statement: 'Pairs/triples of the strongest ablation components removed together; interaction = joint ratio / product of single ratios - 1.',
    links: hypothesis ? { tests: [hypothesis] } : undefined,
    evidence: [{ kind: 'experiment', ref: `components ${(report.components ?? []).map(c => c.id).join(',')}`.slice(0, 500), summary, build,
      data: { summary: report.summary, components: (report.components ?? []).map(c => c.label), non_additive: notable.map(x => ({ labels: x.labels, class: x.class, metric: x.metric, interaction: x.interaction })) } }]
  };
}

// ---------- CLI ----------
const readInput = file => file === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : readJson(path.resolve(file));
export function labCommand(args) {
  const { positional, options } = flags(args, ['type', 'title', 'statement', 'mechanism', 'tags', 'build', 'builds', 'file', 'expected-revision', 'status', 'verification', 'reason',
    'kind', 'ref', 'summary', 'metric', 'direction', 'magnitude', 'tolerance', 'actual-pct', 'notes', 'search', 'tag', 'limit', 'ledger', 'hypothesis', 'confidence', 'test-plan', 'stale-days'], ['history', 'contradicts', 'held-out']);
  const [op, id, ...rest] = positional;
  const file = options.ledger ? path.resolve(options.ledger) : defaultLedger();
  const rev = () => { const n = Number(options['expected-revision']); if (!Number.isInteger(n)) throw new Error('--expected-revision N required'); return n; };
  const opts = { file, reason: options.reason ?? null };
  if (op === 'add') {
    const base = options.file ? readInput(options.file) : {};
    const input = { ...base, ...Object.fromEntries(Object.entries({ type: options.type, title: options.title, statement: options.statement, mechanism: options.mechanism, tags: options.tags,
      builds: options.builds ?? options.build, confidence: options.confidence, test_plan: options['test-plan'], held_out: options['held-out'] ? true : undefined,
      status: options.status, verification: options.verification }).filter(([, v]) => v != null)) };
    return createRecord(input, opts);
  }
  if (op === 'get') return getRecord(id, { file, history: !!options.history });
  if (op === 'list') return listRecords({ file, type: options.type ?? null, status: options.status ?? null, tag: options.tag ?? null, search: options.search ?? null, build: options.build ?? null, limit: Number(options.limit ?? 20) });
  if (op === 'stats') return ledgerStats({ file, staleDays: Number(options['stale-days'] ?? 90) });
  if (op === 'update') { if (!options.file) throw new Error('--file patch.json required'); return updateFields(id, rev(), readInput(options.file), opts); }
  if (op === 'evidence') {
    const e = options.file ? readInput(options.file) : { kind: options.kind, ref: options.ref, summary: options.summary, build: options.build, verification: options.verification, supports: options.contradicts ? false : true };
    return addEvidence(id, rev(), e, opts);
  }
  if (op === 'status') return setStatus(id, rev(), { status: options.status, verification: options.verification }, opts);
  if (op === 'predict') return predict(id, rev(), { metric: options.metric, direction: options.direction, magnitude_pct: options.magnitude, tolerance_pct: options.tolerance }, opts);
  if (op === 'resolve') return resolve(id, rev(), { actual_pct: options['actual-pct'], notes: options.notes, evidence: options.summary ? { kind: options.kind ?? 'calculation', ref: options.ref, summary: options.summary, build: options.build } : null }, opts);
  if (op === 'import') {
    if (!['ablation', 'interactions'].includes(id) || !rest[0]) throw new Error('Use lab import ablation|interactions <file.json> [--build id] [--hypothesis H-001]');
    const convert = id === 'ablation' ? experimentFromAblation : experimentFromInteractions;
    const record = createRecord(convert(readJson(path.resolve(rest[0])), { build: options.build ?? null, hypothesis: options.hypothesis ?? null }), opts);
    return { id: record.id, title: record.title, status: record.status, verification: record.verification, summary: record.evidence[0].summary };
  }
  throw new Error('Use lab add|get|list|stats|update|evidence|status|predict|resolve|import');
}
export const labHelp = {
  'lab add --type hypothesis|experiment|principle|failure|benchmark --title T [--statement S] [--mechanism M] [--tags a,b] [--build id] [--test-plan P] [--held-out] [--file rec.json]': 'Research ledger record (local research/lab/ledger.jsonl, append-only, revisioned)',
  'lab list [--type T] [--status S] [--tag t] [--build id] [--search text] [--limit N] | lab get <id> [--history] | lab stats': 'Compact listing, one record, counts and prediction calibration (direction/magnitude accuracy, held-out)',
  'lab update <id> --expected-revision N --file patch.json | lab evidence <id> --expected-revision N --kind K --summary S [--ref R] [--build id] [--contradicts]': 'Edit fields / append evidence (kinds: calculation, ablation, upgrade, encounter, experiment, observation, mechanic, source, note)',
  'lab status <id> --expected-revision N [--status S] [--verification hypothesis|mechanically_valid|simulator_verified|robustly_tested|game_verified] [--reason R]': 'Lifecycle change with gates: verification <= evidence, generalized needs 2 builds, game_verified needs observation',
  'lab predict <id> --expected-revision N --metric M --direction increase|decrease|no_change [--magnitude P] [--tolerance P] | lab resolve <id> --expected-revision N --actual-pct X [--summary S]': 'Prediction before the test, outcome after; scored for calibration, frozen once resolved',
  'lab import ablation|interactions <file.json> [--build id] [--hypothesis H-001]': 'Store an analyze ablate/interactions result as a done, simulator-verified experiment record'
};
