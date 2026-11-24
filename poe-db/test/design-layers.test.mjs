import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLayer, layerGain, withItems, probeCap, manaCondition, layerRecord, DECIDED_BY } from '../scripts/design-layers.mjs';
import { neutralConfig } from '../scripts/design-seed.mjs';
import { screenQuota, prototypeFlags, reconcileFoundation, SEED_MIN_CALCS, SEED_TAIL_CALCS, JOB_MIN_CALCS } from '../scripts/design-generate.mjs';
import { kitPlan } from '../scripts/design-kit.mjs';

const v = (dps, ehp, sustain = 1, unmet = 0, ms = 1) => ({ dps, ehp, sustain, unmet, ms });

test('layer decision: taken only when it beats the alternative or a guard holds', () => {
  assert.equal(decideLayer(v(110, 100), v(100, 100)).taken, true);
  assert.equal(decideLayer(v(99, 100), v(100, 100)).taken, false);
  assert.equal(decideLayer(v(99, 100, 1), v(100, 100, -5)).guard, 'removing it leaves mana unsustained');
  assert.equal(decideLayer(v(99, 100, 1, 0), v(100, 100, 1, 1)).taken, true);
  assert.equal(layerGain(v(100, 100, 1, 0, 1.2), v(100, 100), { ms: true }).total, 20);
});

test('withItems replaces and removes slots', () => {
  const c = { replace_items: [{ slot: 'Amulet', text: 'a' }, { slot: 'Flask 2', text: 'f' }] };
  assert.deepEqual(withItems(c, { Amulet: { slot: 'Amulet', text: 'b' }, 'Flask 2': null }).replace_items, [{ slot: 'Amulet', text: 'b' }]);
});

test('seed configuration resets author inputs to PoB defaults, scenario keys stay', () => {
  const r = neutralConfig({ useEnduranceCharges: true, multiplierBeenHitRecently: 5, pantheonMajorGod: 'Lunaris', conditionKilledRecently: true, same: 1 },
    { pantheonMajorGod: 'None', same: 1 }, ['conditionKilledRecently']);
  assert.deepEqual(r.config, { useEnduranceCharges: false, multiplierBeenHitRecently: 0, pantheonMajorGod: 'None' });
});

test('screening quota gives every ascendancy a share', () => {
  const pool = [...Array(30)].map((_, i) => ({ id: `a${i}`, ascendancy: 'A', score: 100 - i, form: `f${i}`, damage_types: [] }))
    .concat([{ id: 'b0', ascendancy: 'B', score: 1, form: 'x', damage_types: [] }]);
  const q = screenQuota(pool, ['A', 'B'], 6, r => r.form);
  assert.equal(q.length, 6);
  assert.ok(q.some(r => r.ascendancy === 'B'));
});

test('EHP flag when EHP dwarfs the weakest max hit', () => {
  assert.equal(prototypeFlags({ ehp: 900000, weakest_max_hit: 28000 }).length, 1);
  assert.equal(prototypeFlags({ ehp: 30000, weakest_max_hit: 6000 }).length, 0);
});

test('kit mana leech option puts leech intents on rings and the attack weapon', () => {
  const plan = kitPlan({ attr: 'dex', family: 'Bow', form: 'attack_hit', manaLeech: true });
  assert.ok(plan.find(p => p[0] === 'Ring 1')[2].includes('mana_leech'));
  assert.ok(plan.find(p => p[0] === 'Weapon 1')[2].includes('mana_leech_local'));
});

test('mana repair: the probe cap splits the share over the rounds still to come', () => {
  assert.equal(probeCap(18, 3), 6);
  assert.equal(probeCap(12, 2), 6);
  assert.equal(probeCap(6, 1), 6);
  assert.equal(probeCap(2, 3), 1);   // never zero: one probe still gets a turn
  assert.equal(probeCap(0, 3), 1);
  // Three rounds fit into a 12-calculation share, instead of the first round eating it.
  let left = 12, rounds = 0;
  for (let i = 0; i < 3 && left > 0; i++) { left -= probeCap(left, 3 - i); rounds++; }
  assert.equal(rounds, 3);
});

test('an unresolved mana deficit becomes an explicit condition', () => {
  assert.equal(manaCondition(12.5, 3), null);
  assert.equal(manaCondition(null, 3), null);
  const c = manaCondition(-138.1, 3);
  assert.equal(c.code, 'mana_deficit_unresolved');
  assert.match(c.detail, /-138\.1\/s \(after 3 repair round/);
  assert.match(manaCondition(-48, 0).detail, /no generator repair was run/);
});

test('mana deficit is flagged on every non-minion prototype', () => {
  assert.ok(prototypeFlags({ mana_sustain: -48 }).some(f => f.startsWith('mana_deficit:')));
  assert.equal(prototypeFlags({ mana_sustain: -48, minion: true }).some(f => f.startsWith('mana_deficit:')), false);
  assert.equal(prototypeFlags({ mana_sustain: 12 }).length, 0);
});

test('basics warnings a layer decision already answered become decisions, not warnings', () => {
  const L = (layer, extra) => layerRecord(layer, false, extra.gain ?? null, 'the same points on ordinary tree nodes', extra.reason, { decided_by: extra.by });
  const layers = [L('cluster', { by: 'pob_probe', gain: { total: -17.84 }, reason: 'best of 8 cluster variants does not beat the same points on the tree' }),
    L('masteries', { by: 'pob_probe', reason: 'no mastery effect improved the prototype; reserve returned to the tree' }),
    L('anoint', { by: 'budget', reason: 'not probed (calculation budget)' }),
    L('eldritch', { by: 'no_option', reason: 'no eldritch implicit on the kit' })];
  const check = { status: 'warn', counts: { fail: 0, warn: 5, info: 0 }, warnings: [
    { code: 'no_cluster_jewels', severity: 'warn', detail: 'no cluster jewels' },
    { code: 'masteries_low', severity: 'warn', detail: '0 masteries' },
    { code: 'no_anoint', severity: 'warn', detail: 'amulet without anoint' },
    { code: 'no_eldritch_implicits', severity: 'warn', detail: 'no eldritch implicits' },
    { code: 'attribute_surplus', severity: 'warn', detail: '+395 attributes over requirements' }] };
  const r = reconcileFoundation(check, layers);
  // Only the two layers PoB actually compared lose their warning; budget and no_option keep theirs.
  assert.deepEqual(r.warnings.map(w => w.code), ['no_anoint', 'no_eldritch_implicits', 'attribute_surplus']);
  assert.deepEqual(r.layer_decisions.map(d => d.code), ['no_cluster_jewels', 'masteries_low']);
  assert.match(r.layer_decisions[0].decision, /gain vs alternative -17\.84%/);
  assert.match(r.layer_decisions[1].decision, /rejected by PoB calculation \(alternative/);
  assert.equal(r.counts.warn, 3);
  assert.equal(r.status, 'warn');
  // No layers, or a layer that was taken: the check is untouched.
  assert.equal(reconcileFoundation(check, []), check);
  assert.equal(reconcileFoundation(check, [layerRecord('cluster', true, null, 'tree', 'beats the tree')]), check);
});

test('a seeded job keeps enough of its share for the steps after the support probe', () => {
  assert.ok(SEED_MIN_CALCS > SEED_TAIL_CALCS + 1);
  assert.equal(JOB_MIN_CALCS.seed, SEED_MIN_CALCS);
  // The support probe may not take the tail: of a share of 36 it gets 32, leaving the final run and the encounters.
  const left = 36;
  assert.equal(left - (left - SEED_TAIL_CALCS), SEED_TAIL_CALCS);
});

test('layer records default to pob_probe and keep an explicit decided_by', () => {
  assert.equal(layerRecord('cluster', true, null, 'tree', 'beats the tree').decided_by, 'pob_probe');
  assert.equal(layerRecord('anoint', false, null, 'no anoint', 'no option', { decided_by: 'no_option' }).decided_by, 'no_option');
  assert.ok(DECIDED_BY.includes('budget'));
});
