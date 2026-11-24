import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { critProfile, noveltyVector, cardDistance, noveltyPairs, pairAuc, fitNoveltyWeights, calibrateNoveltyWeights, noveltyPriorWeights, noveltyWeights } from '../scripts/novelty.mjs';

// Synthetic corpus: 6 archetypes x 3 variants. Variants share form/types/supports/crit and differ in uniques (items);
// other archetypes differ in skill, ascendancy and structure. Deterministic, no randomness.
const skills = ['Vortex', 'Cyclone', 'Smite', 'Penance Brand', 'Toxic Rain', 'Raise Spectre'];
const ascs = ['Occultist', 'Slayer', 'Luminary', 'Elementalist', 'Pathfinder', 'Necromancer'];
const types = ['Cold', 'Physical', 'Lightning', 'Fire', 'Chaos', 'Cold'];
const forms = [{ skill_dot: 1 }, { hit: 1 }, { hit: 1 }, { hit: 0.5, ignite: 0.5 }, { poison: 1 }, { hit: 1 }];
const uniquePool = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9'];
function card(a, v) {
  return {
    kind: 'build_card', _card: `${a}-${v}.json`, signature: `s${a}${v}`,
    identity: { file: `${a}-${v}.xml`, pob_sha256: `sha${a}-${v}`, level: 95 },
    features: { class: `C${a}`, ascendancy: ascs[a], main_skill: skills[a], damage_scope: a === 5 ? 'minion' : 'player', primary_type: types[a],
      defense_pool: a % 2 ? 'life' : 'es', defense_layers: a % 2 ? ['armour', 'life_regen'] : ['spell_suppression', 'energy_shield'], keystones: a % 3 ? [] : ['Eldritch Battery'],
      uniques: [uniquePool[(a + v) % 9], uniquePool[(a * 2 + v * 3) % 9]] },
    skills: { main: { tags: a % 2 ? ['attack', 'melee'] : ['spell', 'area'], supports: [`S${a}a`, `S${a}b`, v === 2 ? 'Swap' : `S${a}c`] } },
    damage: { parts: forms[a], types: { [types[a]]: 1 }, scope: a === 5 ? 'minion' : 'player', crit: { chance: [5, 70, 40, 10, 20, 50][a], multiplier: [1.5, 4, 3, 1.5, 2, 3][a] } },
    resources: { sustained: true }
  };
}
const corpus = skills.flatMap((_, a) => [0, 1, 2].map(v => card(a, v)));

test('crit: card field first, else cached calculation by id (minion scope -> minion_output), else null and left out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelty-calc-'));
  try {
    const id = 'ab'.repeat(16);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ output: { CritChance: 150, CritMultiplier: 4 }, minion_output: { CritChance: 10, CritMultiplier: 2 } }));
    const own = critProfile({ damage: { crit: { chance: 50, multiplier: 3 } } }, { calcDir: dir });
    assert.deepEqual(own, { chance: 0.5, multiplier: 3, share: 0.5, source: 'card' });
    const player = critProfile({ identity: { calculation_id: id }, damage: { scope: 'player' } }, { calcDir: dir });
    assert.equal(player.chance, 1); assert.equal(player.share, 0.75); assert.equal(player.source, 'calculation_cache');
    assert.equal(critProfile({ identity: { calculation_id: id }, damage: { scope: 'minion' } }, { calcDir: dir }).chance, 0.1);
    assert.equal(critProfile({ identity: { calculation_id: 'cd'.repeat(16) } }, { calcDir: dir }), null);
    assert.equal(critProfile({ identity: { calculation_id: '../x' } }, { calcDir: dir }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Missing crit on one side: the axis drops out of the mean instead of counting as a difference.
  const a = card(0, 0), b = card(0, 1), bNo = structuredClone(b); delete bNo.damage.crit;
  const with_ = cardDistance(a, b), without = cardDistance(a, bNo);
  assert.equal(with_.groups.crit, 0); assert.equal(without.groups.crit, null);
  assert.ok(noveltyVector(bNo).crit === null || noveltyVector(bNo).crit.source === 'calculation_cache');
  assert.ok(noveltyWeights.crit > 0 && noveltyPriorWeights.crit === noveltyWeights.crit);
});

test('pairs and AUC: variants vs other archetypes, ties count half', () => {
  const { pairs } = noveltyPairs(corpus);
  assert.equal(pairs.filter(p => p.positive).length, 18);
  assert.equal(pairs.length, 18 * 17 / 2);
  assert.ok(pairs.every(p => !(p.positive && p.hard)));
  const only = k => Object.fromEntries(Object.keys(noveltyPriorWeights).map(x => [x, x === k ? 1 : 0]));
  assert.equal(pairAuc(pairs, only('main_skill')), 1);
  // Uniques of variants overlap no more than across archetypes here -> near chance, crit separates.
  assert.ok(pairAuc(pairs, only('crit')) > pairAuc(pairs, only('uniques')));
  assert.equal(pairAuc([{ positive: true, hard: false, groups: { crit: 0.2 } }, { positive: false, hard: false, groups: { crit: 0.2 } }], only('crit')), 0.5);
});

test('fit: label groups untouched, objective does not drop, shrinkage keeps the prior, calibration reproducible', () => {
  const { pairs } = noveltyPairs(corpus);
  const free = fitNoveltyWeights(pairs);
  for (const k of ['ascendancy', 'main_skill', 'delivery', 'damage_scope']) assert.equal(free.weights[k], noveltyPriorWeights[k]);
  const prior = fitNoveltyWeights(pairs, { passes: 0 });
  assert.ok(free.objective >= prior.objective);
  assert.deepEqual(fitNoveltyWeights(pairs, { lambda: 10 }).weights, { ...noveltyPriorWeights });
  const a = calibrateNoveltyWeights(corpus, { folds: 3 }), b = calibrateNoveltyWeights(corpus, { folds: 3 });
  assert.deepEqual(a, b);
  assert.equal(a.pairs.variant, 18); assert.equal(a.pairs.archetypes_with_variants, 6);
  assert.ok(a.after.mean_distance_variant < a.after.mean_distance_other);
  assert.ok(a.before.auc_full >= 0.99);
  assert.deepEqual(a.recommended_weights, a.adopted ? a.after.weights : { ...noveltyPriorWeights });
  assert.ok(a.cross_validation.by_lambda.length >= 2);
});
