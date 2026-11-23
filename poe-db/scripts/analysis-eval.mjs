// Model evaluation runner for evaluations/cases.json: blind prompts, answer templates, heuristic signal checks
// and manual verdicts. An automatic signal match is a hint for the reviewer, not a score of reasoning quality.
import path from 'node:path';
import { dbRoot, readJson } from './workspace.mjs';

export const casesFile = path.join(dbRoot, 'evaluations/cases.json');
export const verdicts = ['pass', 'partial', 'fail'];

export function loadCases(file = casesFile) {
  const data = readJson(file);
  validateCases(data);
  return data;
}

export function validateCases(data) {
  if (!Array.isArray(data?.cases)) throw new Error('cases[] required');
  const ids = new Set();
  for (const c of data.cases) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id ?? '')) throw new Error(`Invalid case id: ${c.id}`);
    if (ids.has(c.id)) throw new Error(`Duplicate case id: ${c.id}`);
    ids.add(c.id);
    for (const key of ['request', 'pass']) if (typeof c[key] !== 'string' || !c[key].trim()) throw new Error(`Case ${c.id}: ${key} required`);
    if (!Array.isArray(c.evidence)) throw new Error(`Case ${c.id}: evidence[] required`);
    const s = c.signals;
    if (s != null) {
      for (const key of ['must', 'must_not']) for (const p of s[key] ?? []) new RegExp(p, 'iu');
      for (const group of s.any_of ?? []) { if (!Array.isArray(group) || !group.length) throw new Error(`Case ${c.id}: any_of groups must be non-empty arrays`); for (const p of group) new RegExp(p, 'iu'); }
    }
  }
  return true;
}

export function listCases(data, category = null) {
  return data.cases.filter(c => !category || c.category === category)
    .map(c => ({ id: c.id, category: c.category ?? 'core', request: c.request, automatic_signals: !!c.signals, requires: c.requires ?? [] }));
}

// Blind prompts: the request only, no pass criteria or evidence, so the evaluated model is not primed.
export function prompts(data, ids = null) {
  return data.cases.filter(c => !ids || ids.includes(c.id)).map(c => ({ id: c.id, request: c.request }));
}

export function answerTemplate(data, model = null) {
  return { model, run_at: null, environment_note: 'Record bootstrap versions used by the evaluated model.',
    answers: data.cases.map(c => ({ id: c.id, answer: '', manual: { verdict: null, reviewer: null, note: null } })) };
}

export function checkSignals(c, answer) {
  const s = c.signals;
  if (!s) return { status: 'needs_review', reason: 'no automatic signals; manual verdict required' };
  if (!answer || !answer.trim()) return { status: 'fail', reason: 'empty answer' };
  const test = p => new RegExp(p, 'iu').test(answer);
  const missing = (s.must ?? []).filter(p => !test(p));
  const forbidden = (s.must_not ?? []).filter(test);
  const groups = (s.any_of ?? []).filter(g => !g.some(test));
  const ok = !missing.length && !forbidden.length && !groups.length;
  return { status: ok ? 'signals_present' : 'signals_missing', missing, forbidden, unmatched_any_of: groups };
}

export function scoreAnswers(data, submission) {
  const answers = Array.isArray(submission) ? submission : submission?.answers;
  if (!Array.isArray(answers)) throw new Error('answers[] required');
  const byId = new Map(data.cases.map(c => [c.id, c]));
  const seen = new Set();
  const rows = answers.map(a => {
    const c = byId.get(a.id);
    if (!c) throw new Error(`Unknown case in answers: ${a.id}`);
    if (seen.has(a.id)) throw new Error(`Duplicate answer: ${a.id}`);
    seen.add(a.id);
    const manual = a.manual?.verdict ?? null;
    if (manual != null && !verdicts.includes(manual)) throw new Error(`Invalid manual verdict for ${a.id}: ${manual}`);
    const auto = checkSignals(c, a.answer ?? '');
    const final = manual ?? (auto.status === 'signals_present' ? 'pending_review' : auto.status === 'fail' ? 'fail' : 'pending_review');
    return { id: a.id, category: c.category ?? 'core', automatic: auto, manual: a.manual ?? null, verdict: final, pass_criteria: c.pass };
  });
  const notAnswered = data.cases.filter(c => !seen.has(c.id)).map(c => c.id);
  const count = v => rows.filter(r => r.verdict === v).length;
  return { model: submission?.model ?? null, run_at: submission?.run_at ?? null, total_cases: data.cases.length, answered: rows.length, not_answered: notAnswered,
    summary: { pass: count('pass'), partial: count('partial'), fail: count('fail'), pending_review: count('pending_review') },
    rows,
    note: 'Automatic signals only check for expected wording; a final pass needs a manual verdict against pass_criteria. Not a benchmark of the game itself.' };
}
