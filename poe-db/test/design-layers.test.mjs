import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLayer, layerGain, withItems } from '../scripts/design-layers.mjs';
import { neutralConfig } from '../scripts/design-seed.mjs';
import { screenQuota, prototypeFlags } from '../scripts/design-generate.mjs';
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
