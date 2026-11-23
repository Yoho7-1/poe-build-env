import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbRoot } from '../scripts/workspace.mjs';
import { parseStageTitle, levelFromPoints, questPointsAtLevel, resistancePenaltyOf, detectStages, planStages, mainGroupFor, regressions,
  buildSets, stageLevel, analyzeProgression, markdownProgression, progressionCommand, progressionHelp, cleanTitle } from '../scripts/analysis-progression.mjs';

const fixture = path.join(dbRoot, 'fixtures/fireball-control.xml');

test('stage titles: acts, levels, points, markers, categories', () => {
  assert.equal(cleanTitle('^2^3LvLing Tree 70 points'), 'LvLing Tree 70 points');
  let p = parseStageTitle('act 1');
  assert.deepEqual([p.category, p.act, p.from, p.to, p.after_kill], ['campaign', 1, 1, 13, false]);
  p = parseStageTitle('End of Act 10');
  assert.deepEqual([p.category, p.act, p.after_kill, p.to], ['campaign', 10, true, 67]);
  p = parseStageTitle('^2Act 4-10');
  assert.deepEqual([p.category, p.from, p.to, p.act], ['campaign', 34, 67, 10]);
  p = parseStageTitle('Level 33-70 {3,4,5}');
  assert.deepEqual([p.from, p.to, p.level_from_title, p.markers], [33, 70, 70, [3, 4, 5]]);
  p = parseStageTitle('LvLing Tree 70 points');
  assert.equal(p.points_in_title, 70); assert.equal(p.category, 'campaign'); assert.equal(p.to, levelFromPoints(70));
  assert.equal(parseStageTitle('Early Maps {6}').category, 'early_maps');
  assert.equal(parseStageTitle('^6Early End Game').category, 'early_endgame');
  assert.equal(parseStageTitle('Endgame - Basic Gems {7,8}').category, 'endgame');
  assert.equal(parseStageTitle('End Game Min Max (Overkill)').category, 'final');
  assert.equal(parseStageTitle('Leveling').category, 'leveling');
  assert.equal(parseStageTitle('1 Cluster {8}').category, 'unknown');
  assert.equal(parseStageTitle(null).category, 'unknown');
});

test('levels from passive points and the act resistance penalty', () => {
  assert.equal(questPointsAtLevel(12), 0); assert.equal(questPointsAtLevel(13), 2); assert.equal(questPointsAtLevel(67), 24);
  assert.equal(levelFromPoints(12), 13);
  assert.equal(levelFromPoints(123), 100);
  assert.equal(levelFromPoints(100), 77);
  const l = stageLevel(parseStageTitle('act 1'), 30);
  assert.equal(l.value, 13); assert.ok(l.estimate); assert.match(l.basis, /clamped/);
  assert.deepEqual(stageLevel(parseStageTitle('Level 40'), 80), { value: 40, basis: 'title', estimate: false });
  assert.equal(resistancePenaltyOf({ category: 'campaign', act: 3 }), 0);
  assert.equal(resistancePenaltyOf({ category: 'campaign', act: 5 }), 0);
  assert.equal(resistancePenaltyOf({ category: 'campaign', act: 5, after_kill: true }), -30);
  assert.equal(resistancePenaltyOf({ category: 'campaign', act: 7 }), -30);
  assert.equal(resistancePenaltyOf({ category: 'campaign', act: 10, after_kill: true }), -60);
  assert.equal(resistancePenaltyOf({ category: 'early_maps' }), -60);
});

const g = (index, active, supports, enabled = true) => ({ index, label: null, active, supports, enabled });
const sets = {
  class_name: 'Templar', ascendancy: 'Inquisitor', level: 95, main_socket_group: 1, active: { tree_spec: 4, item_set: 3, skill_set: 3 },
  tree_specs: [{ index: 1, title: 'Endgame', points: 118 }, { index: 2, title: 'act 1', points: 12 }, { index: 3, title: 'Act 5', points: 50 }, { index: 4, title: 'Early Maps', points: 100 }],
  item_sets: [{ id: 3, title: 'Endgame' }, { id: 5, title: 'Act 5' }, { id: 1, title: 'Early Maps' }],
  skill_sets: [{ id: 8, title: 'Leveling', groups: [g(1, ['Holy Flame Totem'], 2), g(2, ['Frostblink'], 0)] }, { id: 3, title: 'Endgame', groups: [g(1, ['Tornado'], 5), g(2, ['Hatred'], 1)] }]
};

test('stage detection orders by progress and pairs sets by the printed rule', () => {
  const d = detectStages(sets);
  assert.equal(d.driver, 'tree_spec');
  assert.match(d.rule, /marker/);
  assert.deepEqual(d.stages.map(s => s.title), ['act 1', 'Act 5', 'Early Maps', 'Endgame']);
  const [a1, a5, maps, end] = d.stages;
  assert.deepEqual(a1.selection, { tree_spec: 2, item_set: 5, skill_set: 8, main_socket_group: 1 });
  assert.equal(a1.pairing.item_set.rule, 'earliest_later');
  assert.equal(a1.pairing.skill_set.rule, 'in_use');
  assert.equal(a5.pairing.item_set.rule, 'title');
  assert.equal(maps.selection.skill_set, 8, 'Leveling is the last set already in use before Early Maps');
  assert.equal(end.selection.skill_set, 3); assert.equal(end.pairing.skill_set.rule, 'title');
  assert.match(a1.pairing.main_socket_group.basis, /most supported/);
  assert.equal(mainGroupFor(sets, 3).group, 1);
});

test('{n} markers win over titles and level order', () => {
  const s = { ...sets, tree_specs: [{ index: 1, title: 'Act 1 {1}', points: 12 }, { index: 2, title: 'Early Maps {2}', points: 98 }],
    item_sets: [{ id: 2, title: 'Leveling {1}' }, { id: 4, title: 'Budget {2}' }], skill_sets: [{ id: 1, title: 'Level 1-12 {1}' }, { id: 6, title: 'Whatever {2}' }] };
  const d = detectStages(s);
  assert.deepEqual(d.stages.map(x => [x.selection.item_set, x.selection.skill_set, x.pairing.item_set.rule]), [[2, 1, 'marker'], [4, 6, 'marker']]);
});

test('plan: stage enemies, area levels, penalties and the --stages override', () => {
  const plan = planStages({ sets });
  const [a1, a5, maps, end] = plan.stages;
  assert.equal(a1.area_level, 13); assert.equal(a1.resistance_penalty, 0);
  assert.deepEqual(a1.encounter_specs.map(e => e.enemy), ['rare', 'unique']);
  assert.equal(a5.area_level, 45);
  assert.equal(maps.resistance_penalty, -60); assert.deepEqual(maps.encounter_specs.map(e => e.tier), [5, 5]);
  assert.deepEqual(end.encounter_specs.map(e => e.enemy), ['rare', 'map_boss', 'rare', 'pinnacle']);
  assert.ok(a1.passive_budget.available === 13 - 1 + 2);
  const file = planStages({ sets, stagesFile: [{ label: 'Mid acts', tree_spec: 3, item_set: 5, skill_set: 8, character_level: 50, area_level: 52 }, { label: 'Red maps', area_level: 83 }] });
  assert.equal(file.driver, 'stages_file');
  assert.deepEqual([file.stages[0].category, file.stages[0].resistance_penalty, file.stages[0].selection.character_level], ['campaign', -30, 50]);
  assert.equal(file.stages[1].category, 'early_endgame'); assert.equal(file.stages[1].resistance_penalty, -60);
  assert.throws(() => planStages({ sets, stagesFile: [] }), /non-empty/);
});

test('regressions between consecutive stages', () => {
  const st = (dps, life, missing, mana, pen = 0) => ({ label: `s${dps}`, resistance_penalty: pen, primary: { dps, max_hit: { Fire: life } }, pool: { life, energy_shield: 0 },
    resists: { Fire: { missing }, Cold: { missing: 0 }, Lightning: { missing: 0 } }, mana_sustain: mana, flags: [] });
  const list = [st(1000, 1000, 0, 5), st(700, 800, 10, -2, -30)];
  const r = regressions(list);
  assert.deepEqual(r[0].items.map(i => i.code).sort(), ['regression_dps', 'regression_mana', 'regression_max_hit', 'regression_pool', 'regression_resists']);
  assert.match(r[0].items.find(i => i.code === 'regression_max_hit').detail, /penalty 0 -> -30/);
  assert.equal(list[1].flags.length, 5);
});

test('real guide: sets read from XML and plan mode needs no engine', () => {
  const file = path.join(dbRoot, 'references/migrated/tornado-shads-balormage-53b8af051baef699.xml');
  if (!fs.existsSync(file)) return;
  const s = buildSets(fs.readFileSync(file));
  assert.equal(s.tree_specs.length, 10); assert.equal(s.item_sets.length, 5);
  const r = progressionCommand([file, '--plan']);
  assert.equal(r.mode, 'plan'); assert.equal(r.stages[0].label, 'act 1'); assert.equal(r.stages.at(-1).label, 'Final Endgame');
  assert.ok(r.engine_runs_planned > 10);
  assert.match(markdownProgression(r), /План/);
  assert.ok(Object.keys(progressionHelp)[0].startsWith('progression <build.xml>'));
});

test('engine: two explicit stages on the fixture, penalty and level change the result', () => {
  const stages = [{ label: 'Act 3 check', character_level: 30, area_level: 30, enemies: [{ enemy: 'rare', tier: 1, level: 30, campaign: true }] },
    { label: 'Red maps', character_level: 90, area_level: 83, enemies: [{ enemy: 'rare', tier: 16 }] }];
  const r = analyzeProgression({ file: fixture, stages, concurrency: 2 });
  assert.equal(r.errors.length, 0);
  assert.equal(r.stages.length, 2);
  const [a, b] = r.stages;
  assert.equal(a.resistance_penalty, 0); assert.equal(b.resistance_penalty, -60);
  assert.equal(a.selection.character_level, 30); assert.equal(b.selection.character_level, 90);
  assert.equal(a.resists.Fire.value - b.resists.Fire.value, 60, 'only the penalty differs for an uncapped resist');
  assert.ok(a.primary.dps > 0 && a.primary.time_to_kill_s > 0);
  assert.ok(b.pool.life > a.pool.life);
  assert.ok(Array.isArray(a.engine_warnings));
  const md = markdownProgression(r);
  assert.match(md, /Прогрессия по этапам/); assert.match(md, /Red maps/);
  const out = path.join(os.tmpdir(), `progression-${process.pid}.md`);
  try { fs.writeFileSync(out, md); assert.ok(fs.statSync(out).size > 500); } finally { fs.rmSync(out, { force: true }); }
});
