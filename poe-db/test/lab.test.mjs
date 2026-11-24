import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecord, getRecord, listRecords, updateFields, addEvidence, setStatus, predict, resolve, scoreOutcome, ledgerStats, ledgerBrief, experimentFromAblation, labCommand } from '../scripts/lab.mjs';

const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-lab-')); return { dir, file: path.join(dir, 'ledger.jsonl') }; };

test('records get sequential ids, revisions and an append-only history', () => {
  const { dir, file } = tmp();
  try {
    const h = createRecord({ type: 'hypothesis', title: 'Frostbite carries cold DoT', tags: ['cold-dot'] }, { file });
    assert.equal(h.id, 'H-001'); assert.equal(h.revision, 1); assert.equal(h.status, 'open'); assert.equal(h.verification, 'hypothesis'); assert.equal(h.patch, '3.30');
    assert.equal(createRecord({ type: 'hypothesis', title: 'second' }, { file }).id, 'H-002');
    assert.equal(createRecord({ type: 'principle', title: 'p' }, { file }).id, 'P-001');
    const u = updateFields('H-001', 1, { statement: 'Curse effect scales DoT', scope: { skills: ['Vortex'] } }, { file });
    assert.equal(u.revision, 2);
    assert.throws(() => updateFields('H-001', 1, { statement: 'x' }, { file }), /Revision conflict/);
    assert.throws(() => updateFields('H-001', 2, { status: 'supported' }, { file }), /not editable/);
    assert.throws(() => createRecord({ type: 'hypothesis', title: 'x', bogus: 1 }, { file }), /Unknown record field/);
    assert.throws(() => createRecord({ type: 'hypothesis', title: 'x', links: { tests: ['E-404'] } }, { file }), /does not exist/);
    const hist = getRecord('H-001', { file, history: true });
    assert.deepEqual(hist.history.map(h => h.revision), [1, 2]);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 4);
    assert.equal(listRecords({ file, type: 'hypothesis' }).total, 2);
    assert.equal(listRecords({ file, search: 'curse' }).records[0].id, 'H-001');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gates: verification cannot exceed evidence; principles climb only with experiments and transfer', () => {
  const { dir, file } = tmp();
  try {
    const p = createRecord({ type: 'principle', title: 'Exposure is worth a support slot when res is the bottleneck' }, { file });
    assert.throws(() => setStatus(p.id, 1, { status: 'evidence-backed' }, { file }), /needs supporting evidence/);
    assert.throws(() => setStatus(p.id, 1, { verification: 'simulator_verified' }, { file }), /exceeds the supporting evidence/);
    let r = addEvidence(p.id, 1, { kind: 'source', summary: 'Wiki exposure mechanics', ref: 'poewiki Exposure' }, { file });
    r = setStatus(p.id, r.revision, { status: 'evidence-backed', verification: 'mechanically_valid' }, { file });
    assert.throws(() => setStatus(p.id, r.revision, { status: 'experimentally-validated' }, { file }), /experimental evidence/);
    r = addEvidence(p.id, r.revision, { kind: 'ablation', summary: 'removing exposure -12% dps', build: 'a' }, { file });
    r = setStatus(p.id, r.revision, { status: 'experimentally-validated', verification: 'simulator_verified' }, { file });
    assert.throws(() => setStatus(p.id, r.revision, { status: 'generalized' }, { file }), /two different builds/);
    r = addEvidence(p.id, r.revision, { kind: 'calculation', summary: 'same on a fire build', build: 'b' }, { file });
    assert.throws(() => setStatus(p.id, r.revision, { status: 'generalized' }, { file }), /conditions or known counterexamples/);
    r = updateFields(p.id, r.revision, { scope: { conditions: ['enemy res above 0 after penetration'] } }, { file });
    r = setStatus(p.id, r.revision, { status: 'generalized', verification: 'robustly_tested' }, { file });
    assert.equal(r.status, 'generalized');
    assert.throws(() => setStatus(p.id, r.revision, { verification: 'game_verified' }, { file }), /exceeds/);
    assert.throws(() => addEvidence(p.id, r.revision, { kind: 'calculation', summary: 'x', verification: 'game_verified' }, { file }), /Only observation/);
    assert.throws(() => setStatus(p.id, r.revision, { status: 'deprecated' }, { file }), /requires --reason/);
    r = setStatus(p.id, r.revision, { status: 'deprecated' }, { file, reason: 'patch 3.31 changed exposure' });
    assert.equal(getRecord(p.id, { file, history: true }).history.at(-1).reason, 'patch 3.31 changed exposure');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('predictions are frozen before outcomes and feed calibration stats', () => {
  assert.deepEqual(scoreOutcome({ direction: 'decrease', magnitude_pct: 20, tolerance_pct: 2 }, -25), { actual_pct: -25, actual_direction: 'decrease', direction_correct: true, magnitude_error_pct: 5, correct: true });
  assert.equal(scoreOutcome({ direction: 'decrease', magnitude_pct: 20, tolerance_pct: 2 }, -50).correct, false);
  assert.equal(scoreOutcome({ direction: 'no_change', magnitude_pct: null, tolerance_pct: 2 }, 1.5).correct, true);
  assert.equal(scoreOutcome({ direction: 'increase', magnitude_pct: null, tolerance_pct: 2 }, -3).direction_correct, false);
  const { dir, file } = tmp();
  try {
    const h = createRecord({ type: 'hypothesis', title: 'Removing Empower costs ~20% DPS', held_out: true }, { file });
    assert.throws(() => resolve(h.id, 1, { actual_pct: -20 }, { file }), /No prediction/);
    let r = predict(h.id, 1, { metric: 'dps', direction: 'decrease', magnitude_pct: 20 }, { file });
    assert.equal(ledgerStats({ file }).predictions.pending, 1);
    r = resolve(h.id, r.revision, { actual_pct: -23.96, evidence: { kind: 'ablation', summary: 'Empower -23.96%', build: 'main' } }, { file });
    assert.equal(r.outcome.correct, true);
    assert.throws(() => predict(h.id, r.revision, { metric: 'dps', direction: 'increase' }, { file }), /cannot change/);
    r = setStatus(h.id, r.revision, { status: 'supported', verification: 'simulator_verified' }, { file });
    const s = ledgerStats({ file });
    assert.equal(s.predictions.resolved, 1); assert.equal(s.predictions.accuracy, 1); assert.equal(s.predictions.held_out.accuracy, 1);
    assert.equal(s.predictions.mean_magnitude_error_pct, 3.96);
    assert.deepEqual(s.open_hypotheses, []);
    const b = ledgerBrief(file);
    assert.equal(b.records, 1);
    assert.equal(ledgerBrief(path.join(dir, 'missing.jsonl')).records, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ablation output imports as a simulator-verified experiment linked to its hypothesis', () => {
  const report = { analysis: 'ablation', file: 'C:/x/My Build.xml', scenario: 'sustained', thresholds: { core: 25, major: 10, minor: 2 },
    contract: { calculation_contract_sha256: 'a'.repeat(64), input_sha256: 'b'.repeat(64) }, baseline: { values: { dps: 100 } },
    summary: { core: ['Doom Rod'], major: [], minor: ['x'], negligible: ['Vampirism'], removal_improves: [] },
    rows: [{ label: 'Doom Rod', kind: 'items', tier: 'core', offense_loss_pct: 33.9, defense_loss_pct: 1.4 }, { label: 'Bridge', kind: 'tree', tier: 'core', offense_loss_pct: 30, defense_loss_pct: 0, confounded: true }] };
  assert.throws(() => experimentFromAblation({ ...report, plan: true }), /not --plan/);
  const { dir, file } = tmp();
  try {
    createRecord({ type: 'hypothesis', title: 'weapon is core' }, { file });
    const out = labCommand(['import', 'ablation', writeJson(dir, report), '--build', 'main', '--hypothesis', 'H-001', '--ledger', file]);
    assert.equal(out.id, 'E-001'); assert.equal(out.verification, 'simulator_verified'); assert.equal(out.status, 'done');
    assert.match(out.summary, /My Build\.xml/); assert.match(out.summary, /Bridge\*/);
    const e = getRecord('E-001', { file });
    assert.deepEqual(e.links.tests, ['H-001']); assert.equal(e.evidence[0].build, 'main'); assert.deepEqual(e.evidence[0].data.negligible, ['Vampirism']);
    assert.throws(() => labCommand(['status', 'E-001', '--expected-revision', '1', '--status', 'nope', '--ledger', file]), /status must be one of/);
    assert.throws(() => labCommand(['bogus', '--ledger', file]), /Use lab add/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const writeJson = (dir, value) => { const f = path.join(dir, 'ablate.json'); fs.writeFileSync(f, JSON.stringify(value)); return f; };

test('interactions output imports as an experiment and keeps a negative result', () => {
  const { dir, file } = tmp();
  try {
    const report = { analysis: 'interactions', file: 'x/B.xml', scenario: 'sustained', threshold: 0.05, summary: { synergy: 1, overlap: 0, independent: 2 },
      components: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], pairs: [{ labels: ['A', 'B'], class: 'synergy', metric: 'dps', interaction: -0.12 }, { labels: ['A', 'C'], class: 'independent', metric: 'dps', interaction: 0 }], triples: [] };
    const f = path.join(dir, 'i.json'); fs.writeFileSync(f, JSON.stringify(report));
    const out = labCommand(['import', 'interactions', f, '--build', 'main', '--ledger', file]);
    assert.equal(out.id, 'E-001'); assert.match(out.summary, /1 synergy/); assert.match(out.summary, /A \+ B synergy dps -12%/);
    const none = { ...report, summary: { synergy: 0, overlap: 0, independent: 3 }, pairs: report.pairs.slice(1) };
    fs.writeFileSync(f, JSON.stringify(none));
    assert.match(labCommand(['import', 'interactions', f, '--ledger', file]).summary, /No non-additive pair/);
    assert.throws(() => labCommand(['import', 'other', f, '--ledger', file]), /ablation\|interactions/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
