// Design kit eldritch implicits (design-kit.mjs): pool from RePoE, choice by axes with a delivery filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eldritchPool, pickEldritch, eldritchValue, ELDRITCH_TIER } from '../scripts/design-kit.mjs';
import { catalog } from '../scripts/item-builder.mjs';

const cacheReady = fs.existsSync(fileURLToPath(new URL('../cache/knowledge/mods.json', import.meta.url)));
const axes = [{ axis: 'fire', pattern: /fire damage/i, weight: 1 }, { axis: 'life', pattern: /maximum life/i, weight: 1.3 }];

test('eldritch pool: both sides, one tier, slot by base tags, no Presence variants', { skip: !cacheReady }, () => {
  const cat = catalog();
  const id = [...cat.bases.values()].find(b => b.name === 'Sorcerer Gloves').id;
  const rows = eldritchPool(cat, id);
  assert.ok(rows.some(r => r.side === 'exarch') && rows.some(r => r.side === 'eater'));
  assert.ok(rows.every(r => r.id.endsWith(String(ELDRITCH_TIER)) && !/Presence$/.test(r.type)));
  assert.ok(rows.some(r => r.type === 'FireDamage'), 'gloves-only attack fire implicit');
  assert.ok(!rows.some(r => r.type === 'SpellAddedFireDamage'), 'helmet-only implicit is not on gloves');
});

test('eldritch choice: axis value with attack/spell delivery filter, ties by spawn weight', () => {
  assert.equal(eldritchValue('Adds 8 to 17 Fire Damage to Attacks', axes, 'caster'), 0);
  assert.equal(eldritchValue('Adds 8 to 17 Fire Damage to Attacks', axes, 'Two Hand Axe'), 1);
  assert.equal(eldritchValue('Adds 8 to 17 Fire Damage to Spells', axes, 'Bow'), 0);
  assert.ok(eldritchValue('+3% chance to Suppress Spell Damage', axes, 'Bow') === 0, 'no axis hit, but not filtered as spell');
  const rows = [{ id: 'a', type: 'A', side: 'exarch', weight: 100, text: 'x' }, { id: 'b', type: 'B', side: 'exarch', weight: 300, text: 'x' },
    { id: 'c', type: 'C', side: 'eater', weight: 100, text: '+40 to maximum Life' }, { id: 'd', type: 'D', side: 'eater', weight: 900, text: 'x' }];
  const pick = pickEldritch(rows, text => eldritchValue(text, axes, 'caster'));
  assert.equal(pick.exarch.id, 'b');
  assert.equal(pick.eater.id, 'c');
});
