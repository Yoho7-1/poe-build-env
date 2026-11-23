// Progression analysis: check a build guide stage by stage (campaign, early maps, endgame), not only its final
// state. Stages come from the PoB tree specs, item sets and skill sets (paired by an explicit printed rule) or
// from a --stages file. Each stage x enemy is an ordinary `pob run --full` in one batch; enemies come from the
// enemy database (buildEncounter). Levels derived from titles or passive points are estimates and labelled so.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicJson, flags } from './workspace.mjs';
import { decodeBuild } from './pob.mjs';
import { runBatch, defaultConcurrency } from './analysis-engine.mjs';
import { canonicalJson, metrics } from './analysis-core.mjs';
import { buildEncounter, mergeChanges } from './encounter.mjs';
import { loadEnemyDb } from './enemy-db.mjs';
import { loadBossScenarios } from './analysis-bosses.mjs';
import { defenceOf, damageOf } from './analysis-encounter.mjs';
import { loadTree, treeCost } from './tree-graph.mjs';

const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- Campaign model (approximate, stated in every report) ----------
// End-of-act area levels (zone of the act boss) and cumulative passive quest points after finishing each act
// (24 in total with "kill all" bandits: 2+3+2+1+2+3+3+3+2+3).
export const actEndAreaLevel = { 1: 13, 2: 23, 3: 33, 4: 40, 5: 45, 6: 50, 7: 55, 8: 60, 9: 64, 10: 67 };
export const actQuestPoints = { 1: 2, 2: 5, 3: 7, 4: 8, 5: 10, 6: 13, 7: 16, 8: 19, 9: 21, 10: 24 };
export const actStartLevel = act => (act <= 1 ? 1 : actEndAreaLevel[act - 1] + 1);
export const actOfLevel = level => Number(Object.entries(actEndAreaLevel).find(([, end]) => level <= end)?.[0] ?? 11);
export const questPointsAtLevel = level => Object.entries(actEndAreaLevel).reduce((q, [act, end]) => (level >= end ? actQuestPoints[act] : q), 0);
// Smallest character level whose (level - 1) + quest points (acts finished at that level) covers `points`.
export function levelFromPoints(points) {
  if (!(points >= 0)) return null;
  for (let level = 1; level <= 100; level++) if (level - 1 + questPointsAtLevel(level) >= points) return level;
  return 100;
}
// PoB `resistancePenalty` (ConfigOptions.lua: 0 None, -30 Act 5, -60 Act 10). Rule: no penalty while playing
// acts 1-5, -30 in acts 6-10 (after the Act 5 Kitava kill), -60 after the Act 10 Kitava kill (maps).
export function resistancePenaltyOf({ category, act = null, after_kill = false, area_level = null }) {
  if (category !== 'campaign' && category !== 'leveling') return -60;
  const a = act ?? actOfLevel(area_level ?? 1);
  if (a > 10) return -60;
  if (after_kill) return a >= 10 ? -60 : a >= 5 ? -30 : 0;
  return a <= 5 ? 0 : -30;
}
export const resistanceRule = 'PoB resistancePenalty per stage: 0 in acts 1-5, -30 in acts 6-10 (after the Act 5 Kitava kill), -60 after the Act 10 Kitava kill and in maps; "End of Act N" counts as after that act\'s kill.';

// ---------- Title parsing ----------
export const cleanTitle = t => String(t ?? '').replace(/\^x[0-9a-f]{6}/gi, '').replace(/\^\d/g, '').replace(/\s+/g, ' ').trim();
const normTitle = t => cleanTitle(t).replace(/\{[^}]*\}/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Nominal progress (character level scale) and level range of the non-campaign categories.
export const categories = {
  early_maps: { nominal: 70, range: [68, 80], label: 'early maps' },
  maps: { nominal: 78, range: [70, 90], label: 'maps' },
  early_endgame: { nominal: 85, range: [75, 92], label: 'early endgame' },
  endgame: { nominal: 92, range: [85, 100], label: 'endgame' },
  final: { nominal: 97, range: [90, 100], label: 'final endgame' }
};

function parseMarkers(text) {
  const m = String(text ?? '').match(/\{([\d,\s-]+)\}/);
  if (!m) return [];
  return m[1].split(',').flatMap(part => { const [a, b] = part.split('-').map(s => Number(s.trim())); return Number.isInteger(a) ? (Number.isInteger(b) ? Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i) : [a]) : []; });
}

// Title -> { category, from, to, act, after_kill, level_from_title, points_in_title, markers }.
// from = level from which a set applies; to = level at the end of the stage. Unknown titles: category 'unknown'.
export function parseStageTitle(title) {
  const raw = cleanTitle(title);
  const markers = parseMarkers(raw);
  const t = raw.replace(/\{[^}]*\}/g, ' ').toLowerCase();
  const out = { title: raw, category: 'unknown', from: null, to: null, act: null, act_in_title: false, after_kill: false, level_from_title: null, points_in_title: null, markers };
  const pts = t.match(/(\d{1,3})\s*(?:points|pts|passives|pp)\b/);
  if (pts) out.points_in_title = Number(pts[1]);
  const lvl = t.match(/\b(?:level|lvl|lv)\.?\s*(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?/);
  const act = t.match(/\bact\s*(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?/);
  const has = re => re.test(t);
  if (has(/ultra|min ?max|overkill|very high budget|mirror|final|perfect|bis\b|best in slot/)) out.category = 'final';
  else if (has(/early ?end ?-?game|early ?late ?game/)) out.category = 'early_endgame';
  else if (has(/end ?-?game|late ?game|uber|pinnacle|high budget/)) out.category = 'endgame';
  else if (has(/early map|white map|start(?:ing)? map|first map|early mapping|t1\b|tier 1\b/)) out.category = 'early_maps';
  else if (has(/\bmaps?\b|mapping|yellow|red map|atlas/) && !act) out.category = 'maps';
  if (act && !['final', 'endgame', 'early_endgame'].includes(out.category) && !(out.category === 'early_maps' && !/end of act|after act/.test(t))) {
    const a = clamp(Number(act[1]), 1, 10), b = act[2] ? clamp(Number(act[2]), a, 10) : a;
    out.category = 'campaign'; out.act = b; out.act_in_title = true; out.after_kill = /\b(end of|after|post|finish(?:ed)?|beat(?:en)?|kill(?:ed)?)\b/.test(t);
    out.from = out.after_kill ? actEndAreaLevel[a] : actStartLevel(a);
    out.to = actEndAreaLevel[b];
    if (out.after_kill && b === 10) out.category_after = 'maps_next';
  }
  if (lvl) {
    const a = clamp(Number(lvl[1]), 1, 100), b = lvl[2] ? clamp(Number(lvl[2]), a, 100) : a;
    out.level_from_title = b;
    if (out.category === 'unknown' || out.category === 'campaign') {
      if (out.category === 'unknown') out.category = b < 68 ? 'campaign' : b < 80 ? 'early_maps' : b < 90 ? 'maps' : 'endgame';
      if (out.category === 'campaign') { out.act = out.act ?? actOfLevel(b); }
      out.from = a; out.to = b;
    }
  }
  if (out.category === 'unknown' && out.points_in_title == null && has(/level(?:l)?ing|lvl?ing|campaign|acts?\b|story/)) { out.category = 'leveling'; out.from = 1; out.to = 67; }
  if (out.category === 'unknown' && out.points_in_title != null) {
    const l = levelFromPoints(out.points_in_title);
    out.category = l < 68 ? 'campaign' : l < 85 ? 'maps' : 'endgame';
    if (out.category === 'campaign') out.act = actOfLevel(l);
    out.from = l; out.to = l;
  }
  if (categories[out.category] && out.from == null) { out.from = categories[out.category].nominal; out.to = categories[out.category].nominal; }
  return out;
}

// ---------- Build structure ----------
// Tree specs (1-based PoB index), item sets and skill sets (PoB ids) in XML order, plus class and active choices.
export function buildSets(input) {
  const { root } = decodeBuild(input);
  const specs = asArray(root.Tree?.Spec);
  return {
    class_name: root.Build.className ?? null, ascendancy: root.Build.ascendClassName ?? null, level: Number(root.Build.level ?? 1), main_socket_group: Number(root.Build.mainSocketGroup ?? 1),
    tree_specs: specs.map((s, i) => ({ index: i + 1, title: cleanTitle(s.title) || null, class_id: s.classId != null ? Number(s.classId) : null, nodes: String(s.nodes ?? '').split(',').filter(Boolean).map(Number) })),
    item_sets: asArray(root.Items?.ItemSet).map(s => ({ id: Number(s.id), title: cleanTitle(s.title) || null })),
    skill_sets: asArray(root.Skills?.SkillSet).map(s => ({ id: Number(s.id), title: cleanTitle(s.title) || null, groups: asArray(s.Skill).map(groupOf) })),
    active: { tree_spec: Number(root.Tree?.activeSpec ?? 1), item_set: Number(root.Items?.activeItemSet ?? 1), skill_set: Number(root.Skills?.activeSkillSet ?? 1) }
  };
}

const isSupport = g => /Support/.test(String(g.gemId ?? '')) || /^Support/.test(String(g.skillId ?? ''));
function groupOf(skill, i) {
  const gems = asArray(skill.Gem).filter(g => g.enabled !== 'false');
  return { index: i + 1, label: cleanTitle(skill.label) || null, enabled: skill.enabled !== 'false', active: gems.filter(g => !isSupport(g)).map(g => g.nameSpec), supports: gems.filter(isSupport).length };
}

// Main socket group per skill set. Rule: (1) explicit; (2) the group with the build's main active gem (main group of
// the active skill set), most supports first; (3) the enabled group with an active gem and the most supports
// (lowest index on ties); (4) the build's mainSocketGroup.
export function mainGroupFor(sets, skillSetId) {
  const activeSet = sets.skill_sets.find(x => x.id === sets.active.skill_set);
  const mainGem = activeSet?.groups?.[sets.main_socket_group - 1]?.active?.[0] ?? null;
  const set = sets.skill_sets.find(x => x.id === skillSetId);
  const groups = (set?.groups ?? []).filter(g => g.enabled && g.active.length);
  const best = list => list.slice().sort((a, b) => b.supports - a.supports || a.index - b.index)[0];
  const withMain = mainGem ? best(groups.filter(g => g.active.includes(mainGem))) : null;
  if (withMain) return { group: withMain.index, basis: `group with the build main skill ${mainGem}` };
  const most = best(groups);
  if (most) return { group: most.index, basis: `most supported group (${most.active[0]}, ${most.supports} supports); build main skill ${mainGem ?? '-'} not in this set` };
  return { group: sets.main_socket_group, basis: 'build mainSocketGroup' };
}

// Main-tree points of each spec through the GGG 3.30 tree (masteries count, granted points subtracted); null when
// the tree data is unavailable. Loaded lazily so the pure functions do not need it.
export function treePointsOf(sets) {
  let t;
  try { t = loadTree(); } catch { return sets.tree_specs.map(() => null); }
  return sets.tree_specs.map(spec => {
    try {
      const from = t.classes?.[spec.class_id]?.name ?? sets.class_name;
      // Cluster jewel nodes (ids >= 65536) are not in the GGG tree; each allocated one costs a point.
      const cluster = spec.nodes.filter(id => id >= 65536).length;
      const c = treeCost({ from, allocated: spec.nodes.filter(id => id < 65536).map(String).join(',') }, t);
      return c.points.main_tree - (c.points.granted_extra_points ?? 0) + cluster;
    } catch { return null; }
  });
}

export const pairingRule = [
  'Driver list: the longest of tree specs / skill sets / item sets (ties: tree specs, then skill sets); every driver entry is one stage.',
  'For each other list, in order: (a) a set whose {n} marker lists the stage number (the driver\'s own {n} marker, else its 1-based position);',
  '(b) a set with the same normalized title; (c) the parsed set with the largest start level <= the stage end level (the set already in use);',
  '(d) the parsed set with the smallest start level (stage is earlier than every set); (e) nothing parsed: same position, clamped to the last set.',
  'Main socket group per skill set: the group holding the build main skill (main group of the active skill set), else the enabled group with the most supports.',
  'Stages are then ordered by estimated progress (end level, category); XML order breaks ties.'
].join(' ');

function pickSet(list, stage, driverOrdinal) {
  if (!list.length) return { set: null, rule: 'none' };
  const parsed = list.map((s, i) => ({ s, i, p: parseStageTitle(s.title) }));
  const ordinal = stage.parsed.markers[0] ?? driverOrdinal;
  const byMarker = parsed.find(x => x.p.markers.includes(ordinal));
  if (byMarker) return { set: byMarker.s, rule: 'marker' };
  const title = normTitle(stage.title);
  const byTitle = title ? parsed.find(x => normTitle(x.s.title) === title) : null;
  if (byTitle) return { set: byTitle.s, rule: 'title' };
  const known = parsed.filter(x => x.p.from != null);
  const end = stage.parsed.to ?? stage.level?.value ?? null;
  if (known.length && end != null) {
    const before = known.filter(x => x.p.from <= end).sort((a, b) => b.p.from - a.p.from || a.i - b.i)[0];
    if (before) return { set: before.s, rule: 'in_use' };
    return { set: known.sort((a, b) => a.p.from - b.p.from || a.i - b.i)[0].s, rule: 'earliest_later' };
  }
  return { set: list[Math.min(stage.position, list.length - 1)], rule: 'order' };
}

// Character level of a stage: title level, else passive points (clamped to the category range), else default.
export function stageLevel(parsed, points) {
  if (parsed.level_from_title != null) return { value: parsed.level_from_title, basis: 'title', estimate: false };
  const range = parsed.category === 'campaign' ? [parsed.after_kill ? parsed.to : actStartLevel(parsed.act), parsed.to]
    : parsed.category === 'leveling' ? [1, 67] : categories[parsed.category]?.range ?? [1, 100];
  const p = points ?? parsed.points_in_title;
  if (p != null) {
    const raw = levelFromPoints(p);
    const value = clamp(raw, range[0], range[1]);
    return { value, basis: `estimate from ${p} main-tree points (act quest points)${value !== raw ? `; points imply level ${raw}, clamped to ${range[0]}-${range[1]}` : ''}`, estimate: true, points_level: raw };
  }
  const fallback = parsed.category === 'campaign' ? parsed.to : categories[parsed.category]?.nominal ?? null;
  return fallback != null ? { value: fallback, basis: `estimate: default level of ${parsed.category}`, estimate: true } : { value: null, basis: 'unknown', estimate: true };
}

// Pure: sets = buildSets() output (tree specs may carry `points`). Returns ordered stages with selection.
export function detectStages(sets) {
  const lists = { tree_spec: sets.tree_specs, skill_set: sets.skill_sets, item_set: sets.item_sets };
  const driverKey = ['tree_spec', 'skill_set', 'item_set'].reduce((best, k) => (lists[k].length > lists[best].length ? k : best), 'tree_spec');
  const driver = lists[driverKey];
  const stages = driver.map((entry, position) => {
    const parsed = parseStageTitle(entry.title);
    const points = driverKey === 'tree_spec' ? entry.points ?? null : null;
    const stage = { position, title: entry.title ?? `${driverKey} ${position + 1}`, parsed, driver: driverKey };
    stage.level = stageLevel(parsed, points);
    // A single untitled stage (ordinary build): the build's own level, not an estimate.
    if (driver.length === 1 && parsed.category === 'unknown' && parsed.level_from_title == null) stage.level = { value: sets.level ?? null, basis: 'build level (single stage)', estimate: false };
    const selection = {}, pairing = {};
    for (const key of ['tree_spec', 'item_set', 'skill_set']) {
      if (key === driverKey) { selection[key] = key === 'tree_spec' ? entry.index : entry.id; pairing[key] = { title: entry.title, rule: 'driver' }; continue; }
      const { set, rule } = pickSet(lists[key], stage, position + 1);
      if (set) { selection[key] = key === 'tree_spec' ? set.index : set.id; pairing[key] = { title: set.title, rule }; }
    }
    // A skill/item driver still needs a tree spec: points of the paired spec refine the level estimate.
    if (driverKey !== 'tree_spec' && selection.tree_spec) {
      const spec = sets.tree_specs.find(s => s.index === selection.tree_spec);
      if (spec?.points != null && parsed.level_from_title == null) stage.level = stageLevel(parsed, spec.points);
    }
    const treePoints = sets.tree_specs.find(s => s.index === selection.tree_spec)?.points ?? null;
    if (selection.skill_set != null && sets.skill_sets.some(x => x.groups)) { const m = mainGroupFor(sets, selection.skill_set); selection.main_socket_group = m.group; pairing.main_socket_group = { title: null, rule: 'main_group', basis: m.basis }; }
    return { ...stage, tree_points: treePoints, selection, pairing };
  });
  // Unknown titles: inherit progress from the previous stage in XML order.
  let last = 1;
  for (const s of stages) { s.progress = s.parsed.to ?? s.level.value ?? last; last = s.progress; }
  stages.sort((a, b) => a.progress - b.progress || a.position - b.position);
  return { driver: driverKey, stages, rule: pairingRule };
}

// ---------- Encounters per stage ----------
// Campaign: rare + unique (act boss proxy, not real boss skills) at the stage area level. Maps: tier by category.
export function stageEncounterSpecs(stage) {
  const c = stage.category;
  if (stage.enemies) return stage.enemies;
  if (c === 'campaign' || c === 'leveling') {
    const area = stage.area_level;
    return [{ enemy: 'rare', tier: 1, level: area, campaign: true }, { enemy: 'unique', tier: 1, level: area, campaign: true }];
  }
  if (c === 'early_maps') return [{ enemy: 'rare', tier: 5 }, { enemy: 'map_boss', tier: 5 }];
  if (c === 'maps') return [{ enemy: 'rare', tier: 10 }, { enemy: 'map_boss', tier: 10 }];
  if (c === 'early_endgame') return [{ enemy: 'rare', tier: 16 }, { enemy: 'map_boss', tier: 16 }];
  const end = [{ enemy: 'rare', tier: 16 }, { enemy: 'map_boss', tier: 16 }, { enemy: 'rare', tier: 17 }, { enemy: 'pinnacle' }];
  return c === 'final' ? [...end, { enemy: 'uber' }] : end;
}

// Area level of a stage: campaign = end-of-act area level (title act) or character level capped at 67.
export function stageAreaLevel(parsed, level) {
  if (parsed.category === 'campaign' && parsed.act_in_title && parsed.level_from_title == null) return actEndAreaLevel[parsed.act];
  if (parsed.category === 'campaign' || parsed.category === 'leveling') return clamp(level ?? 1, 1, 67);
  return null;
}

// Normalized stage plan from detection or a --stages file. File entries:
// { label, tree_spec, item_set, skill_set, character_level, area_level, main_socket_group?, resistance_penalty?, enemies? }
export function planStages({ sets, stagesFile = null }) {
  let detection;
  if (stagesFile) {
    const list = Array.isArray(stagesFile) ? stagesFile : stagesFile.stages;
    if (!Array.isArray(list) || !list.length) throw new Error('--stages file: a non-empty list of {label, tree_spec, item_set, skill_set, character_level, area_level}');
    const stages = list.map((s, position) => {
      const parsed = parseStageTitle(s.label);
      const area = s.area_level != null ? Number(s.area_level) : null;
      if (area != null && (!Number.isInteger(area) || area < 1 || area > 100)) throw new Error(`Stage ${s.label}: area_level 1-100`);
      if (area != null) {
        if (area < 68) { parsed.category = 'campaign'; parsed.act = actOfLevel(area); }
        else { const tier = clamp(area - 67, 1, 17); parsed.category = tier <= 5 ? 'early_maps' : tier <= 13 ? 'maps' : tier <= 16 ? 'early_endgame' : 'endgame'; }
      }
      const selection = {};
      for (const k of ['tree_spec', 'item_set', 'skill_set', 'main_socket_group']) if (s[k] != null) selection[k] = Number(s[k]);
      if (s.main_socket_group == null && sets?.skill_sets?.length) { const m = mainGroupFor(sets, selection.skill_set ?? sets.active.skill_set); selection.main_socket_group = m.group; }
      const level = s.character_level != null ? { value: Number(s.character_level), basis: 'stages file', estimate: false } : stageLevel(parsed, null);
      return { position, title: s.label ?? `Stage ${position + 1}`, parsed, driver: 'stages_file', level, selection, pairing: { rule: 'stages_file' },
        area_override: area, penalty_override: s.resistance_penalty ?? null, enemies: s.enemies ?? null, progress: position };
    });
    detection = { driver: 'stages_file', stages, rule: 'Explicit --stages file: stages in file order, selections and levels as given; missing values use the build defaults or estimates.' };
  } else detection = detectStages(sets);
  for (const s of detection.stages) {
    s.category = s.parsed.category === 'unknown' ? (s.level.value != null && s.level.value < 68 ? 'campaign' : s.level.value != null && s.level.value < 85 ? 'maps' : 'endgame') : s.parsed.category;
    if (s.category === 'campaign' && !s.parsed.act) s.parsed = { ...s.parsed, act: actOfLevel(s.level.value ?? 1) };
    s.area_level = s.area_override ?? stageAreaLevel({ ...s.parsed, category: s.category }, s.level.value);
    s.resistance_penalty = s.penalty_override ?? resistancePenaltyOf({ category: s.category, act: s.parsed.act, after_kill: s.parsed.after_kill, area_level: s.area_level });
    if (s.level.value != null) s.selection.character_level = clamp(Math.round(s.level.value), 1, 100);
    // Passive budget of this stage with act-based quest points (the engine assumes all quest points).
    const questPoints = s.category === 'campaign' || s.category === 'leveling' ? questPointsAtLevel(s.area_level ?? s.level.value ?? 1) : 24;
    s.passive_budget = s.level.value != null ? { available: s.level.value - 1 + questPoints, quest_points_assumed: questPoints, used: s.tree_points ?? null } : null;
    s.encounter_specs = stageEncounterSpecs(s);
  }
  return detection;
}

// ---------- Assessment ----------
const elementTypes = ['Fire', 'Cold', 'Lightning'];
export const flagRules = {
  one_shot: 'any stage enemy: engine hits to die < 1',
  dangerous: 'one enemy hit takes >= 70% of the effective pool',
  resist_below_cap: 'fire/cold/lightning resistance below its maximum (PoB Missing*Resist > 0) after the stage penalty',
  unmet_requirements: 'PoB warning about an unmet attribute/level requirement',
  not_enough_mana: 'PoB warning: not enough unreserved mana for a skill',
  mana_negative: 'mana_sustain < 0 (recovery minus cost of the selected skill per second, continuous use)',
  skill_disabled: 'main skill disabled (skill_disabled_reason)',
  no_damage: 'no player or minion DPS for the main skill',
  over_budget: 'main-tree points exceed (level - 1) + quest points expected at this stage',
  regression_dps: 'DPS (primary enemy) drops >= 15% from the previous stage',
  regression_pool: 'life + energy shield drops >= 10% from the previous stage',
  regression_max_hit: 'smallest max hit drops >= 20% from the previous stage (includes resistance penalty steps)',
  regression_resists: 'more missing elemental resistance than the previous stage',
  regression_mana: 'mana sustain turns negative'
};

function mainSkillOf(result) {
  const g = asArray(result.groups)[(result.selection?.main_socket_group ?? 1) - 1];
  const gems = (g?.gems ?? []).filter(x => x.enabled !== false);
  return g ? { group: g.index, label: cleanTitle(g.label) || null, skill: (gems.find(x => !/Support/.test(String(x.id ?? ''))) ?? gems[0])?.name ?? null } : null;
}

export function assessStage(stage, rows) {
  const first = rows[0];
  const o = first.result.output;
  const missing = Object.fromEntries([...elementTypes, 'Chaos'].map(t => [t, num(o[`Missing${t}Resist`])]));
  const resists = Object.fromEntries([...elementTypes, 'Chaos'].map(t => [t, { value: num(o[`${t}Resist`]), missing: missing[t] }]));
  const warnings = first.result.engine_warnings ?? [];
  const enc = rows.map(r => ({ label: r.encounter.label, enemy_level: r.encounter.enemy.level, life: r.encounter.life,
    damage: damageOf(r.result.output, r.encounter.life, r.result.minion_output), defence: defenceOf(r.result.output) }))
    .map(e => ({ label: e.label, enemy_level: e.enemy_level, dps: e.damage.full_dps > 0 ? e.damage.full_dps : e.damage.combined_dps, dps_scope: e.damage.scope,
      time_to_kill_s: e.damage.time_to_kill_s, enemy_life: e.damage.enemy_life, hits_to_die: e.defence.hits_to_die, verdict: e.defence.verdict, dominant_type: e.defence.dominant_type,
      weakest_type: e.defence.weakest_type, weakest_max_hit: e.defence.weakest_type ? e.defence.max_hit[e.defence.weakest_type] : null, ehp: e.defence.ehp, max_hit: e.defence.max_hit }));
  const p = enc[0];
  const mana = metrics.mana_sustain.read(o);
  const flagsOut = [];
  const add = (code, detail) => flagsOut.push({ code, detail });
  for (const e of enc) if (e.verdict === 'one_shot') add('one_shot', `${e.label}: ${e.hits_to_die} hits to die`); else if (e.verdict === 'dangerous') add('dangerous', `${e.label}: ${e.hits_to_die} hits to die`);
  const below = elementTypes.filter(t => missing[t] > 0);
  if (below.length) add('resist_below_cap', below.map(t => `${t} ${resists[t].value} (-${missing[t]})`).join(', '));
  const req = warnings.filter(w => /requirement/i.test(w));
  if (req.length) add('unmet_requirements', req.join('; '));
  const manaW = warnings.filter(w => /enough mana/i.test(w));
  if (manaW.length) add('not_enough_mana', manaW.join('; '));
  if (mana != null && mana < 0) add('mana_negative', `${round(mana, 1)} mana/s`);
  if (first.result.skill_disabled_reason) add('skill_disabled', String(first.result.skill_disabled_reason));
  if (!(p.dps > 0)) add('no_damage', 'DPS 0 for the selected main skill');
  const b = stage.passive_budget;
  if (b?.used != null && b.used > b.available) add('over_budget', `${b.used} points > ${b.available} (level ${stage.level.value}, ${b.quest_points_assumed} quest points)`);
  return { label: stage.title, category: stage.category, character_level: stage.level, area_level: stage.area_level, resistance_penalty: stage.resistance_penalty,
    selection: first.result.selection ?? stage.selection, pairing: stage.pairing, main_skill: mainSkillOf(first.result), calculation_id: first.result.calculation_id,
    passive_budget: b, engine_budget: first.result.budget ?? null,
    primary: p, encounters: enc,
    pool: { life: num(o.Life), energy_shield: num(o.EnergyShield), mana: num(o.Mana), mana_unreserved: num(o.ManaUnreserved) },
    resists, mana_sustain: round(mana, 1), engine_warnings: warnings, skill_disabled_reason: first.result.skill_disabled_reason ?? null,
    unparsed_item_modifiers: first.result.unparsed_item_modifiers ?? [], flags: flagsOut };
}

const poolOf = s => (s.pool.life ?? 0) + (s.pool.energy_shield ?? 0);
const minMaxHit = s => { const v = Object.values(s.primary.max_hit ?? {}).filter(x => x != null); return v.length ? Math.min(...v) : null; };
const missingSum = s => elementTypes.reduce((a, t) => a + Math.max(0, s.resists[t].missing ?? 0), 0);
const change = (a, b) => (a > 0 && b != null ? round((b / a - 1) * 100, 1) : null);
// Regressions between consecutive stages (in progress order); added to the later stage's flags.
export function regressions(stages) {
  const out = [];
  for (let i = 1; i < stages.length; i++) {
    const a = stages[i - 1], b = stages[i], list = [];
    const dps = change(a.primary.dps, b.primary.dps);
    if (dps != null && dps <= -15) list.push({ code: 'regression_dps', detail: `DPS ${dps}% (${round(a.primary.dps)} -> ${round(b.primary.dps)})` });
    const pool = change(poolOf(a), poolOf(b));
    if (pool != null && pool <= -10) list.push({ code: 'regression_pool', detail: `life+ES ${pool}% (${poolOf(a)} -> ${poolOf(b)})` });
    const mh = change(minMaxHit(a), minMaxHit(b));
    if (mh != null && mh <= -20) list.push({ code: 'regression_max_hit', detail: `smallest max hit ${mh}%${a.resistance_penalty !== b.resistance_penalty ? ` (resistance penalty ${a.resistance_penalty} -> ${b.resistance_penalty})` : ''}` });
    if (missingSum(b) > missingSum(a)) list.push({ code: 'regression_resists', detail: `missing elemental resistance ${missingSum(a)} -> ${missingSum(b)}` });
    if ((a.mana_sustain ?? -1) >= 0 && b.mana_sustain != null && b.mana_sustain < 0) list.push({ code: 'regression_mana', detail: `mana sustain ${a.mana_sustain} -> ${b.mana_sustain}` });
    if (list.length) out.push({ from: a.label, to: b.label, items: list });
    b.flags.push(...list);
  }
  return out;
}

// ---------- Orchestration ----------
function buildStageEncounters(db, bosses, stage) {
  return stage.encounter_specs.map(spec => {
    const e = buildEncounter(db, bosses, spec);
    if (spec.campaign) e.label = `${db.archetypes[spec.enemy]?.label?.replace(/ map monster.*$/i, ' monster') ?? spec.enemy}, campaign area level ${spec.level}${spec.enemy === 'unique' ? ' (act boss proxy, no boss skills)' : ''}`;
    return e;
  });
}
const stageBase = stage => ({ selection: { ...stage.selection }, config: { resistancePenalty: stage.resistance_penalty } });

const assumptions = [
  resistanceRule,
  'Campaign area levels at the end of each act (approx.): ' + Object.entries(actEndAreaLevel).map(([a, l]) => `A${a} ${l}`).join(', ') + '; campaign enemies are a rare and a unique monster of that area level (the unique monster stands in for the act boss without its skills).',
  'Character level: title number when present, else estimated from main-tree points with act quest points (2/5/7/8/10/13/16/19/21/24 after acts 1-10, kill-all bandits), clamped to the stage range; estimates are marked.',
  'Maps: early maps T5 (rare, map boss), maps T10, early endgame T16, endgame T16/T17 + pinnacle generic hit, final endgame + uber generic hit; no map mods.',
  'Each stage uses the sets selected for it; gems, flasks and configuration are those saved in the guide (scenario overrides only the listed toggles).'
];
const disclaimer = 'Numeric PoB experiment per guide stage against modelled enemies; not a game test. Campaign bosses, density, layouts and the real leveling gear are not modelled.';

export function analyzeProgression({ file, scenario = 'sustained', stages: stagesFile = null, concurrency = defaultConcurrency, plan = false, base = {} }) {
  const input = fs.readFileSync(path.resolve(file));
  const sets = buildSets(input);
  const points = treePointsOf(sets);
  sets.tree_specs.forEach((s, i) => { s.points = points[i]; });
  const detection = planStages({ sets, stagesFile });
  const db = loadEnemyDb(), bosses = loadBossScenarios();
  for (const s of detection.stages) {
    if (s.tree_points == null && s.selection.tree_spec) s.tree_points = sets.tree_specs.find(t => t.index === s.selection.tree_spec)?.points ?? null;
    if (s.passive_budget) s.passive_budget.used = s.tree_points;
    s.encounters = buildStageEncounters(db, bosses, s);
  }
  const header = { game: 'poe1', patch: '3.30', analysis: 'progression', build_file: path.basename(file), scenario, class: sets.class_name, ascendancy: sets.ascendancy,
    available: { tree_specs: sets.tree_specs.map(s => ({ index: s.index, title: s.title, points: s.points })), item_sets: sets.item_sets, skill_sets: sets.skill_sets },
    driver: detection.driver, pairing_rule: detection.rule, assumptions, flag_rules: flagRules };
  const planned = detection.stages.map(s => ({ label: s.title, category: s.category, character_level: s.level, area_level: s.area_level, resistance_penalty: s.resistance_penalty,
    selection: s.selection, pairing: s.pairing, passive_budget: s.passive_budget, encounters: s.encounters.map(e => ({ label: e.label, enemy_level: e.enemy.level, life: e.life })) }));
  if (plan) return { ...header, mode: 'plan', stages: planned, engine_runs_planned: planned.reduce((a, s) => a + s.encounters.length, 0), disclaimer };

  const jobs = detection.stages.flatMap((s, si) => s.encounters.map((e, ei) => ({ si, ei, changes: mergeChanges(mergeChanges(base, stageBase(s)), e.changes) })));
  const batch = runBatch({ file, scenario, changesList: jobs.map(j => j.changes), concurrency, full: true });
  const results = detection.stages.map(() => []);
  const errors = [];
  for (const j of jobs) {
    const r = batch.results.get(canonicalJson(j.changes));
    if (!r || r.error) errors.push({ stage: detection.stages[j.si].title, encounter: detection.stages[j.si].encounters[j.ei].label, error: r?.error ?? 'missing' });
    else results[j.si].push({ encounter: detection.stages[j.si].encounters[j.ei], result: r });
  }
  const stages = detection.stages.map((s, i) => (results[i].length ? assessStage(s, results[i]) : { label: s.title, category: s.category, error: 'all calculations failed', flags: [] }));
  const ok = stages.filter(s => !s.error);
  const regs = regressions(ok);
  const summary = {
    stages: stages.length, failed: stages.filter(s => s.error).map(s => s.label),
    one_shots: ok.filter(s => s.flags.some(f => f.code === 'one_shot')).map(s => s.label),
    resist_below_cap: ok.filter(s => s.flags.some(f => f.code === 'resist_below_cap') && !['campaign', 'leveling'].includes(s.category)).map(s => s.label),
    resist_below_cap_campaign: ok.filter(s => s.flags.some(f => f.code === 'resist_below_cap') && ['campaign', 'leveling'].includes(s.category)).map(s => s.label),
    unmet_requirements: ok.filter(s => s.flags.some(f => f.code === 'unmet_requirements')).map(s => s.label),
    skill_disabled: ok.filter(s => s.flags.some(f => f.code === 'skill_disabled' || f.code === 'no_damage')).map(s => s.label),
    regressions: regs.map(r => ({ from: r.from, to: r.to, codes: r.items.map(x => x.code) }))
  };
  return { ...header, mode: 'run', summary, stages, regressions: regs, errors, timing: { engine_runs: batch.runs, batch_elapsed_ms: batch.elapsed_ms }, disclaimer };
}

// ---------- Markdown ----------
const fmt = v => (v == null ? '-' : typeof v === 'number' ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(round(v, 2))) : String(v));
const verdictRu = { one_shot: 'ваншот', dangerous: 'опасно', survives_hit: 'держит', unknown: '?' };
const ruleRu = { driver: 'ведущий', marker: '{n}', title: 'название', in_use: 'уже в игре', earliest_later: 'ближайший поздний', order: 'по порядку', stages_file: 'файл', none: '-' };
const flagRu = { one_shot: 'ваншот', dangerous: 'опасный удар', resist_below_cap: 'резисты ниже капа', unmet_requirements: 'не выполнены требования', not_enough_mana: 'не хватает маны',
  mana_negative: 'мана в минус', skill_disabled: 'скилл отключён', no_damage: 'нет урона', over_budget: 'дерево сверх бюджета', regression_dps: 'регресс DPS',
  regression_pool: 'регресс life/ES', regression_max_hit: 'регресс max hit', regression_resists: 'регресс резистов', regression_mana: 'регресс маны' };
const levelText = l => (l?.value == null ? '-' : `${l.value}${l.estimate ? '~' : ''}`);

export function markdownProgression(report) {
  const out = [];
  const push = (...l) => out.push(...l);
  push(`# Прогрессия по этапам: ${report.build_file}`, '', `Класс: ${report.class ?? '-'} / ${report.ascendancy ?? '-'}; сценарий PoB \`${report.scenario}\`; этапов: ${report.stages.length}.`, '');
  push('## Как определены этапы', '', `- Ведущий список: ${report.driver}. Правило сопоставления (англ.): ${report.pairing_rule}`, '- Уровень с `~` — оценка (по очкам дерева или категории), без `~` — из названия или файла этапов.');
  for (const a of report.assumptions) push(`- ${a}`);
  push('');
  if (report.mode === 'plan') {
    push('## План (без расчёта)', '', '| Этап | Категория | Ур. | Area | Res pen | Tree / Items / Skills | Противники |', '|---|---|---:|---:|---:|---|---|');
    for (const s of report.stages) push(`| ${s.label} | ${s.category} | ${levelText(s.character_level)} | ${fmt(s.area_level)} | ${s.resistance_penalty} | ${setsText(s)} | ${s.encounters.map(e => e.label).join('; ')} |`);
    push('', `Запусков движка будет: ${report.engine_runs_planned}.`, '', `_${report.disclaimer}_`, '');
    return out.join('\n');
  }
  const s = report.summary;
  push('## Итог', '',
    `- Ваншоты: ${s.one_shots.length ? s.one_shots.join('; ') : 'нет'}.`,
    `- Резисты ниже капа в картах: ${s.resist_below_cap.length ? s.resist_below_cap.join('; ') : 'нет'}; в кампании: ${s.resist_below_cap_campaign.length ? s.resist_below_cap_campaign.join('; ') : 'нет'}.`,
    `- Невыполненные требования предметов/гемов: ${s.unmet_requirements.length ? s.unmet_requirements.join('; ') : 'нет'}.`,
    `- Скилл отключён или без урона: ${s.skill_disabled.length ? s.skill_disabled.join('; ') : 'нет'}.`,
    `- Регрессии между соседними этапами: ${s.regressions.length ? s.regressions.map(r => `${r.from} -> ${r.to} (${r.codes.map(c => flagRu[c]).join(', ')})`).join('; ') : 'нет'}.`);
  if (s.failed.length) push(`- Не рассчитаны: ${s.failed.join('; ')}.`);
  push('', '## Этапы', '', '| Этап | Ур. | Res pen | Скилл | DPS | TTK, с | Ударов до смерти | Слабый max hit | F/C/L/Ch | Life / ES | Мана/с | Флаги |', '|---|---:|---:|---|---:|---:|---:|---|---|---:|---:|---|');
  for (const st of report.stages) {
    if (st.error) { push(`| ${st.label} | - | - | - | - | - | - | - | - | - | - | ошибка расчёта |`); continue; }
    const p = st.primary;
    const res = ['Fire', 'Cold', 'Lightning', 'Chaos'].map(t => `${fmt(st.resists[t].value)}${st.resists[t].missing > 0 && t !== 'Chaos' ? '!' : ''}`).join('/');
    push(`| ${st.label} | ${levelText(st.character_level)} | ${st.resistance_penalty} | ${st.main_skill?.skill ?? '-'} | ${fmt(p.dps)}${p.dps_scope === 'minion' ? ' (minion)' : ''} | ${fmt(p.time_to_kill_s)} | ${fmt(p.hits_to_die)} (${verdictRu[p.verdict] ?? p.verdict}) | ${p.weakest_type ? `${p.weakest_type} ${fmt(p.weakest_max_hit)}` : '-'} | ${res} | ${fmt(st.pool.life)} / ${fmt(st.pool.energy_shield)} | ${fmt(st.mana_sustain)} | ${[...new Set(st.flags.map(f => flagRu[f.code] ?? f.code))].join(', ') || '-'} |`);
  }
  push('', 'TTK и удары — против первого противника этапа (rare своего area level); `!` — резист ниже капа.', '');
  for (const st of report.stages.filter(x => !x.error)) {
    push(`### ${st.label}`, '', `- Уровень ${levelText(st.character_level)} (${st.character_level.basis}); area level ${fmt(st.area_level)}; resistancePenalty ${st.resistance_penalty}.`,
      `- Наборы: ${setsText(st)}; main skill: ${st.main_skill?.skill ?? '-'} (группа ${st.main_skill?.group ?? '-'}).`);
    if (st.passive_budget?.used != null) push(`- Очки дерева: ${st.passive_budget.used} из ${st.passive_budget.available} (квестовых ${st.passive_budget.quest_points_assumed}).`);
    push('', '| Противник | DPS | TTK, с | Ударов до смерти | Итог | Тип удара | EHP |', '|---|---:|---:|---:|---|---|---:|');
    for (const e of st.encounters) push(`| ${e.label} | ${fmt(e.dps)} | ${fmt(e.time_to_kill_s)} | ${fmt(e.hits_to_die)} | ${verdictRu[e.verdict] ?? e.verdict} | ${e.dominant_type ?? '-'} | ${fmt(e.ehp)} |`);
    if (st.flags.length) { push(''); for (const f of st.flags) push(`- **${flagRu[f.code] ?? f.code}**: ${f.detail}`); }
    const other = st.engine_warnings.filter(w => !/requirement|enough mana/i.test(w));
    if (other.length) push(`- Прочие предупреждения PoB: ${other.join('; ')}`);
    if (st.unparsed_item_modifiers.length) push(`- Нераспознанные моды предметов: ${st.unparsed_item_modifiers.length}.`);
    push('');
  }
  push(`_${report.disclaimer}_`, '');
  return out.join('\n');
}
function setsText(s) {
  const sel = s.selection ?? {}, pr = s.pairing ?? {};
  return ['tree_spec', 'item_set', 'skill_set'].map(k => `${k.replace('_', ' ')} ${sel[k] ?? '-'}${pr[k]?.title ? ` "${pr[k].title}"` : ''}${pr[k]?.rule && pr[k].rule !== 'driver' ? ` [${ruleRu[pr[k].rule] ?? pr[k].rule}]` : ''}`).join(', ');
}

// ---------- CLI ----------
export const progressionHelp = {
  'progression <build.xml> [--stages stages.json] [--plan] [--md report.md] [--out report.json] [--concurrency N] [--scenario S]':
    'Guide check by stage: tree specs/item sets/skill sets paired into stages (printed rule) or --stages [{label,tree_spec,item_set,skill_set,character_level,area_level}]; per stage vs campaign rare/unique of its area level (resistancePenalty 0/-30/-60 by act) or maps T5/T10/T16/T17 + bosses: DPS, TTK, hits to die, weakest max hit, resists vs cap, life/ES, mana sustain, warnings, regressions; --plan = stages and enemies only, no engine'
};

export function progressionCommand(rest) {
  const { positional, options } = flags(rest, ['stages', 'md', 'out', 'concurrency', 'scenario'], ['plan']);
  const file = positional[0];
  if (!file) throw new Error('Usage: progression <build.xml> [--stages f.json] [--plan] [--md f.md] [--out f.json] [--concurrency N]');
  const concurrency = Number(options.concurrency ?? defaultConcurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('--concurrency 1-16');
  const report = analyzeProgression({ file, scenario: options.scenario ?? 'sustained', stages: options.stages ? readJson(path.resolve(options.stages)) : null, concurrency, plan: !!options.plan });
  if (options.md) { fs.mkdirSync(path.dirname(path.resolve(options.md)), { recursive: true }); fs.writeFileSync(path.resolve(options.md), markdownProgression(report), 'utf8'); report.markdown_file = path.resolve(options.md); }
  if (options.out) atomicJson(path.resolve(options.out), report);
  return report;
}
