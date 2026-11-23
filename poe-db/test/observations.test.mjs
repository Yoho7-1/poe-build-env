import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBuild } from '../scripts/build-store.mjs';
import { normalizeObservation, addObservation, listObservations, compareObservations, predictionsOf, observeCommand } from '../scripts/observations.mjs';

const tempBuilds = () => fs.mkdtempSync(path.join(os.tmpdir(), 'poe-observe-'));

test('observations validate fields and keep unknown values null', () => {
  const o = normalizeObservation({ kind: 'death', boss: 'Sirus', killed_by: 'Meteor', damage_type: 'fire' }, 'obs-test');
  assert.equal(o.outcome.damage_type, 'Fire');
  assert.equal(o.outcome.deaths, 1);
  assert.equal(o.content.map_tier, null);
  assert.equal(o.snapshot.calculation_id, null);
  assert.equal(o.date, null);
  assert.throws(() => normalizeObservation({ kind: 'explode' }, 'obs-test'), /kind/);
  assert.throws(() => normalizeObservation({ kind: 'death', map_tier: 18 }, 'obs-test'), /map_tier/);
  assert.throws(() => normalizeObservation({ kind: 'death', damage_type: 'Holy' }, 'obs-test'), /damage_type/);
  assert.throws(() => normalizeObservation({ kind: 'death', pob_sha256: 'abc' }, 'obs-test'), /pob_sha256/);
  assert.throws(() => normalizeObservation({ kind: 'death', colour: 'red' }, 'obs-test'), /Unknown/);
  assert.throws(() => normalizeObservation({ kind: 'death', outcome: { killer: 'x' } }, 'obs-test'), /outcome.killer/);
  assert.throws(() => normalizeObservation({ kind: 'boss_kill' }, 'obs-test'), /boss/);
  assert.throws(() => normalizeObservation({ kind: 'death', date: '2999-01-01' }, 'obs-test'), /future/);
  assert.throws(() => normalizeObservation({ kind: 'note' }, '../main'), /note|identifier/);
});

test('append-only store per build in a temporary builds directory', () => {
  const dir = tempBuilds();
  try {
    assert.throws(() => addObservation('missing-build', { kind: 'note', notes: 'x' }, dir));
    createBuild('obs-test', 'Observation test', dir);
    addObservation('obs-test', { kind: 'note', notes: 'first' }, dir);
    const r = observeCommand(['add', 'obs-test', '--kind', 'map_clear', '--map-tier', '16', '--mods', 'MapMonsterFireDamage,Reflect', '--deaths', '0'], { directory: dir });
    assert.equal(r.added.content.map_mods.length, 2);
    const rows = listObservations('obs-test', dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].notes, 'first');
    assert.equal(fs.readFileSync(path.join(dir, 'obs-test', 'observations.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal(observeCommand(['list', 'obs-test', '--kind', 'note'], { directory: dir }).count, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const encounterReport = {
  analysis: 'encounter', build_file: 'b.xml', scenario: 'sustained', label: 'Sirus / Meteor (uber)', calculation_id: 'calc-1',
  enemy: { kind: 'boss', boss: 'Sirus', skill: 'Meteor' }, map: { tier: 16 }, modifiers: [],
  damage: { time_to_kill_s: 40 }, defence: { verdict: 'survives_hit', hits_to_die: 2.5, dominant_type: 'Fire' }
};
const report = {
  analysis: 'survival_damage_report', build_file: 'b.xml', scenario: 'sustained',
  matrix: [
    { label: 'Sirus / Meteor (uber)', enemy: { kind: 'boss', boss: 'Sirus', skill: 'Meteor' }, damage: { time_to_kill_s: null }, defence: { verdict: 'one_shot', dominant_type: 'Fire' } },
    { label: 'Sirus / Die Beam (uber)', enemy: { kind: 'boss', boss: 'Sirus', skill: 'Die Beam' }, damage: {}, defence: { verdict: 'survives_hit', dominant_type: 'Chaos' } },
    { label: 'Rare monster, T16', enemy: { kind: 'archetype', archetype: 'rare' }, map: { tier: 16 }, damage: { time_to_kill_s: 2 }, defence: { verdict: 'survives_hit', dominant_type: 'Physical' } }
  ],
  sweeps: [{ analysis: 'map_mod_sweep', tier: 16, band: 'red', enemy: 'rare', mods: [
    { id: 'MapMonsterFireDamage', name: 'Extra Fire Damage', verdict: 'caution', compared_against: 'rare' },
    { id: 'MapReflect', name: 'Reflect', verdict: 'avoid', compared_against: 'rare' },
    { id: 'MapSafe', name: 'Safe', verdict: 'ok', compared_against: 'rare' }] }]
};
const obs = (input, id = 'obs-test') => normalizeObservation(input, id);

test('compare finds contradictions and agreements against an encounter', () => {
  const result = compareObservations([
    obs({ kind: 'death', boss: 'Sirus', killed_by: 'Meteor', damage_type: 'Cold', calculation_id: 'calc-other' }),
    obs({ kind: 'boss_kill', boss: 'Sirus', time_to_kill_s: 50, deaths: 0 }),
    obs({ kind: 'death', boss: 'Maven', killed_by: 'Brain' })
  ], encounterReport);
  const survival = result.contradictions.find(c => c.check === 'survival');
  assert.equal(survival.predicted, 'survives_hit');
  assert.equal(survival.strength, 'strong');
  assert.ok(result.contradictions.some(c => c.check === 'damage_type' && c.observed === 'Cold'));
  assert.ok(result.agreements.some(c => c.check === 'time_to_kill'));
  assert.equal(result.unmatched_observations.length, 1);
  assert.equal(result.snapshot_warnings[0].warning, 'different_character_snapshot');
});

test('compare against a full report uses boss skill, map mods and tier', () => {
  assert.equal(predictionsOf(report).length, 6);
  const result = compareObservations([
    obs({ kind: 'death', boss: 'Sirus', killed_by: 'meteor' }),
    obs({ kind: 'death', map_tier: 16, map_mods: ['Extra Fire Damage', 'MapSafe'], enemy: 'rare' }),
    obs({ kind: 'map_clear', map_tier: 16, map_mods: ['Reflect'], deaths: 0 }),
    obs({ kind: 'note', notes: 'ignored' })
  ], report);
  const sirus = [...result.agreements, ...result.contradictions].filter(f => f.prediction.startsWith('Sirus'));
  assert.deepEqual(sirus.map(f => f.prediction), ['Sirus / Meteor (uber)']);
  assert.equal(sirus[0].status, 'agreement');
  assert.ok(result.agreements.some(f => f.prediction.startsWith('Extra Fire Damage') && f.strength === 'weak'));
  assert.ok(result.contradictions.some(f => f.prediction.startsWith('Safe')));
  assert.ok(result.contradictions.some(f => f.prediction === 'Rare monster, T16' && f.check === 'survival'));
  assert.ok(result.contradictions.some(f => f.prediction.startsWith('Reflect') && f.check === 'map_mod_danger'));
  assert.equal(result.report_without_calculation_ids, true);
  assert.throws(() => predictionsOf({ analysis: 'stats' }), /Unsupported/);
});
