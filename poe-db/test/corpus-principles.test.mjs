import test from 'node:test';
import assert from 'node:assert/strict';
import { contextsOf, buildKeyTable, principleCandidates, configTautology, filterCandidates } from '../scripts/corpus-principles.mjs';

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

test('config tautologies are filtered with a reason, other config flags stay flagged', () => {
  const asc = new Map([['Gladiator', ['25% more Damage if you have Blocked Recently']], ['Juggernaut', ['Gain Endurance Charges']]]);
  const c = (key, context, direction, score = 1) => ({ key, context, direction, score });
  const cands = [
    c('config:conditionEnemyShocked', { type: 'Lightning' }, 'carries_in_context', 3),
    c('config:conditionEnemyShocked', { type: 'Cold' }, 'weak_in_context', 2),
    c('config:conditionBlockedRecently', { ascendancy: 'Gladiator' }, 'carries_in_context'),
    c('config:conditionBlockedRecently', { ascendancy: 'Juggernaut' }, 'carries_in_context'),
    c('config:conditionStationary', { pool: 'life' }, 'carries_in_context'),
    c('config:conditionEnemyShocked', { type: 'Lightning' }, 'weak_in_context'),
    c('node:Mind Over Matter', { form: 'hit' }, 'carries_in_context'),
  ];
  assert.equal(configTautology(cands[0], asc).kind, 'definitional');
  assert.equal(configTautology(cands[1], asc).kind, 'complement');
  assert.equal(configTautology(cands[2], asc).kind, 'ascendancy_defines');
  assert.match(configTautology(cands[2], asc).reason, /Blocked Recently/);
  assert.equal(configTautology(cands[3], asc), null, 'Juggernaut nodes do not read the condition');
  assert.equal(configTautology(cands[5], asc), null, 'weak in its own linked value is not a tautology');
  const { kept, filtered } = filterCandidates(cands, { asc });
  assert.deepEqual(filtered.map(f => f.filtered.kind), ['definitional', 'complement', 'ascendancy_defines']);
  assert.ok(filtered.every(f => f.filtered.reason));
  assert.deepEqual(kept.map(k => k.key), ['config:conditionBlockedRecently', 'config:conditionStationary', 'config:conditionEnemyShocked', 'node:Mind Over Matter']);
  assert.equal(kept.find(k => k.key === 'config:conditionStationary').config_assumption, true);
  assert.equal(filterCandidates(cands, { asc, keepTautologies: true }).kept[0].tautology.kind, 'definitional');
  assert.equal(filterCandidates(cands, { asc, noConfig: true }).kept.length, 1);
});
