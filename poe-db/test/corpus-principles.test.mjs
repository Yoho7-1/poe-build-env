import test from 'node:test';
import assert from 'node:assert/strict';
import { contextsOf, buildKeyTable, principleCandidates } from '../scripts/corpus-principles.mjs';

test('contexts come from BuildCard features and foundation', () => {
  const c = contextsOf({ skills: { main: { tags: ['attack', 'melee'] } }, damage: { primary_form: 'bleed', scope: 'player' }, features: { primary_type: 'Physical', defense_pool: 'life', ascendancy: 'None' }, foundation: { mana: { applies: true, primary: 'leech' } } });
  assert.deepEqual(c, { family: 'attack', form: 'dot', type: 'Physical', pool: 'life', mana: 'leech' });
});

test('a component that carries in one context and not elsewhere becomes a candidate with counterexamples', () => {
  const rows = [];
  const contexts = new Map();
  for (let i = 0; i < 5; i++) { contexts.set(`c${i}`, { type: 'Cold' }); rows.push({ build: `c${i}`, keys: ['support:Cold Penetration'], tier: i < 4 ? 'core' : 'minor' }); }
  for (let i = 0; i < 4; i++) { contexts.set(`f${i}`, { type: 'Fire' }); rows.push({ build: `f${i}`, keys: ['support:Cold Penetration'], tier: 'negligible' }); }
  const out = principleCandidates({ table: buildKeyTable(rows), contexts });
  const cold = out.find(c => c.context.type === 'Cold');
  assert.equal(cold.direction, 'carries_in_context'); assert.equal(cold.share_in, 0.8); assert.equal(cold.share_out, 0);
  assert.deepEqual(cold.counterexamples, ['c4']);
  const fire = out.find(c => c.context.type === 'Fire');
  assert.equal(fire.direction, 'weak_in_context');
  assert.equal(principleCandidates({ table: buildKeyTable(rows.slice(0, 7)), contexts }).length, 0, 'fewer than 3 builds outside the context');
});
