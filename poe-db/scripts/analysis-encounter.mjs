// Survival and damage analysis against the enemy database: one encounter, a per-map-mod sweep, and a full
// report (standard enemies, boss skills and map mods) with a Markdown rendering. All calculations are ordinary
// `pob run --full` jobs batched by analysis-engine; the verdict rules are explicit heuristics, not game tests.
import fs from 'node:fs';
import path from 'node:path';
import { runBatch, defaultConcurrency } from './analysis-engine.mjs';
import { canonicalJson, effectiveDps } from './analysis-core.mjs';
import { buildEncounter, cleanSpec, mergeChanges, parseEnemy, isBossOnly } from './encounter.mjs';
import { loadEnemyDb, bandOfTier, enemyLife } from './enemy-db.mjs';
import { loadBossScenarios, dotOf } from './analysis-bosses.mjs';
import { approximateModels, enemyResistsOf, parseThorns } from './mechanic-models.mjs';
export { dotOf };

const types = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'];
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (before, after) => (before > 0 && after != null ? round((after / before - 1) * 100, 1) : null);
export const thresholds = {
  one_shot: 'engine hits to die < 1',
  dangerous: 'one enemy hit takes >= 70% of the effective pool',
  avoid: 'map mod causes a new one-shot, or costs >= 40% DPS, hits-to-die or max hit of a damage type, or a reflect risk',
  caution: 'map mod costs >= 15% DPS or >= 20% hits-to-die, max hit of a damage type or EHP, or has an engine-unmodelled risk for this build',
  degen: 'boss degen: sustained when recovery >= taken per second; dangerous below 4 s to die'
};
const disclaimer = 'Numeric PoB experiment against modelled enemies; not a game test. Avoidance between hits, layout, density, ground effects, reflect and on-death effects are not calculated; see not_modelled and build_checks.';

// ---------- Assessment of one calculation ----------
export function defenceOf(o) {
  const hits = num(o.NumberOfDamagingHits);
  const maxHit = Object.fromEntries(types.map(t => [t, round(num(o[`${t}MaximumHitTaken`]))]));
  const taken = Object.fromEntries(types.map(t => [t, num(o[`${t}TakenHit`])]).filter(([, v]) => v > 0).map(([t, v]) => [t, round(v)]));
  const dominant = Object.entries(taken).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const fraction = hits > 0 ? 1 / hits : hits === 0 ? Infinity : null;
  const verdict = hits == null ? 'unknown' : hits < 1 ? 'one_shot' : fraction >= 0.7 ? 'dangerous' : 'survives_hit';
  const regen = num(o.LifeRegenRecovery) ?? 0, leech = num(o.LifeLeechGainRate) ?? 0, esRegen = num(o.EnergyShieldRegenRecovery) ?? 0;
  return {
    verdict, hits_to_die: round(hits, 2), enemy_hit_raw: round(num(o.totalEnemyDamageIn)), enemy_hit_after_mods: round(num(o.totalEnemyDamage)),
    enemy_crit_chance: round(num(o.EnemyCritChance), 1), taken_per_hit: taken, dominant_type: dominant, total_taken_per_hit: round(num(o.totalTakenHit)),
    pen: Object.fromEntries(['Fire', 'Cold', 'Lightning'].map(t => [t, num(o[`${t}EnemyPen`])]).filter(([, v]) => v)),
    max_hit: maxHit, weakest_type: Object.entries(maxHit).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1])[0]?.[0] ?? null,
    ehp: round(num(o.TotalEHP)), survival_time_s: round(num(o.EHPSurvivalTime), 2),
    pool: { life: num(o.Life), energy_shield: num(o.EnergyShield), mana: num(o.Mana) },
    resists: { fire: num(o.FireResist), cold: num(o.ColdResist), lightning: num(o.LightningResist), chaos: num(o.ChaosResist) },
    avoidance: { block: num(o.EffectiveBlockChance) ?? num(o.BlockChance), spell_block: num(o.EffectiveSpellBlockChance) ?? num(o.SpellBlockChance), suppression: num(o.EffectiveSpellSuppressionChance) ?? num(o.SpellSuppressionChance) },
    recovery_per_s: { life_regen: round(regen, 1), life_leech: round(leech, 1), es_regen: round(esRegen, 1), total: round(regen + leech + esRegen, 1) }
  };
}

// Player output, or the minion output when the player itself deals no damage (minion builds).
export function damageOf(o, life, minion = null) {
  const playerBest = Math.max(num(o.FullDPS) ?? 0, effectiveDps(o).value ?? 0);
  const useMinion = !(playerBest > 0) && minion && Math.max(num(minion.FullDPS) ?? 0, effectiveDps(minion).value ?? 0) > 0;
  const src = useMinion ? minion : o;
  const eff = effectiveDps(src);
  const dps = num(src.CombinedDPS), full = num(useMinion ? o.FullDPS ?? minion.FullDPS : src.FullDPS);
  // FullDPS covers only groups marked include_in_full_dps; the main skill may be absent from it, so take the larger.
  const effective = eff.value ?? 0;
  const best = Math.max(full ?? 0, effective);
  const basis = !(best > 0) ? null : (full ?? 0) >= effective ? 'FullDPS' : eff.basis === 'CombinedDPS' ? 'CombinedDPS' : 'TotalDotDPS+hit';
  return { scope: useMinion ? 'minion' : 'player', combined_dps: round(dps), full_dps: round(full), effective_dps: round(eff.value), best_dps: round(best) || null, dps_basis: basis,
    dps_basis_note: eff.note ?? null, total_dot_dps: round(num(src.TotalDotDPS) ?? num(src.TotalDot)),
    hit_chance: round(num(src.HitChance), 1), crit_chance: round(num(src.CritChance), 2),
    hit_average_by_type: Object.fromEntries(types.map(t => [t, round(num(src[`${t}HitAverage`]))]).filter(([, v]) => v > 0)),
    ignite_dps: round(num(src.IgniteDPS)), poison_dps: round(num(src.PoisonDPS)), bleed_dps: round(num(src.BleedDPS)),
    enemy_life: life?.value ?? null, enemy_life_range: life?.range ?? null, enemy_life_basis: life?.basis ?? null,
    time_to_kill_s: life?.value && best > 0 ? round(life.value / best, 2) : null,
    // Derived boss life is a range (two formulas); the time to kill is then a range too.
    time_to_kill_range_s: !life?.value && life?.range && best > 0 ? life.range.map(v => round(v / best, 2)) : null,
    time_to_kill_basis: (life?.value || life?.range) && basis ? basis + ' against this enemy; ignores travel, uptime, phases and overkill' : null };
}

// On-kill monster explosions (Profane Bloom: 50% / 25% of max life as chaos on cursed kills; item mods such as
// 10% / 250% as fire). PoB's "On Kill Monster Explosion" group uses monsterLifeTable[enemy level], not this enemy's
// life, and is per kill rather than per second, so it is not part of DPS or time to kill. Here the base damage of one
// explosion is scaled by the encounter enemy's life; player damage modifiers, enemy resistances and hit-to-other-
// enemies geometry are not applied (method base_damage_from_enemy_life).
export function explosionsOf(explodeMods, life) {
  if (!Array.isArray(explodeMods) || !explodeMods.length) return null;
  const lives = life?.value ? [life.value] : life?.range ?? null;
  const rows = explodeMods.map(m => {
    const pctOfLife = num(m.amount), chance = num(m.chance);
    const types = m.type === 'RandomElement' ? 'Fire/Cold/Lightning (random)' : m.type;
    const per = lives && pctOfLife != null ? lives.map(l => round(l * pctOfLife / 100)) : null;
    const requires = (m.conditions ?? []).map(c => c === 'enemy:Cursed' ? 'enemy cursed' : c);
    return { source: m.source ?? null, source_name: m.source_name ?? null, damage_type: types, chance_pct: chance == null ? null : round(chance * 100, 1), percent_of_enemy_life: pctOfLife,
      requires, damage_per_explosion: per?.length === 1 ? per[0] : null, damage_per_explosion_range: per?.length > 1 ? per : null,
      expected_damage_per_kill: per && chance != null ? (per.length === 1 ? round(per[0] * chance) : null) : null,
      expected_damage_per_kill_range: per && chance != null && per.length > 1 ? per.map(v => round(v * chance)) : null };
  });
  return { method: lives ? 'base_damage_from_enemy_life' : 'not_modelled', enemy_life_basis: life?.basis ?? null, rows,
    note: 'Per kill, dealt to nearby enemies; not in DPS. Unscaled base damage: player modifiers, penetration and enemy resistances are not applied; conditions (e.g. enemy cursed) are assumed met. PoB own explosion group uses generic monster life for the enemy level.' };
}

// Build-specific checks for mechanics the engine does not calculate (danger axes from the enemy database).
export function buildChecks(axes, o) {
  const has = k => num(o[k]) > 0;
  const avoid = k => num(o[k]) ?? 0;
  const regen = num(o.LifeRegenRecovery) ?? 0, leech = num(o.LifeLeechGainRate) ?? 0, esRegen = num(o.EnergyShieldRegenRecovery) ?? 0;
  const total = regen + leech + esRegen;
  const noHitData = !types.some(t => has(`${t}HitAverage`));
  const rules = {
    reflect_physical: () => noHitData ? ['manual', 'No hit damage data for the main skill (DoT, minion or trigger skill); check reflect by hand.']
      : has('PhysicalHitAverage') ? ['risk', `Main skill deals ${round(o.PhysicalHitAverage)} physical per hit; physical thorns reflect is not calculated.`] : ['ok', 'Main skill deals no physical hit damage.'],
    reflect_elemental: () => noHitData ? ['manual', 'No hit damage data for the main skill (DoT, minion or trigger skill); check reflect by hand.']
      : ['Fire', 'Cold', 'Lightning'].some(t => has(`${t}HitAverage`)) ? ['risk', 'Main skill deals elemental hit damage; elemental thorns reflect is not calculated.'] : ['ok', 'Main skill deals no elemental hit damage.'],
    no_regeneration: () => total > 0 && (regen + esRegen) / total > 0.5 ? ['risk', `Regeneration is ${round((regen + esRegen) / total * 100)}% of sustained recovery.`] : ['ok', 'Regeneration is not the main recovery.'],
    ailments_on_player: () => ['IgniteAvoidChance', 'FreezeAvoidChance', 'ShockAvoidChance'].some(k => avoid(k) < 100) ? ['caution', `Ailment avoidance: ignite ${avoid('IgniteAvoidChance')}%, freeze ${avoid('FreezeAvoidChance')}%, shock ${avoid('ShockAvoidChance')}%.`] : ['ok', 'Immune to ignite, freeze and shock.'],
    poison_on_player: () => avoid('PoisonAvoidChance') < 100 ? ['caution', `Poison avoidance ${avoid('PoisonAvoidChance')}%; poison stacks are not calculated.`] : ['ok', 'Poison immune.'],
    impale_on_player: () => avoid('ImpaleAvoidChance') < 100 ? ['caution', `Impale avoidance ${avoid('ImpaleAvoidChance')}%.`] : ['ok', 'Impale immune.'],
    blind_on_player: () => avoid('BlindAvoidChance') < 100 ? ['caution', `Blind avoidance ${avoid('BlindAvoidChance')}%.`] : ['ok', 'Blind immune.'],
    ground_degen: () => ['caution', 'Burning/desecrated ground degen is not calculated; compare with DoT EHP (FireDotEHP/ChaosDotEHP) and recovery.'],
    ground_shock: () => ['caution', 'Shocked ground increases damage taken; not calculated.']
  };
  return axes.map(axis => { const [status, evidence] = rules[axis]?.() ?? ['manual', 'Not calculated; judge from playstyle and gear.']; return { axis, status, evidence }; });
}

// WP9 approximate models (mechanic-models.mjs) for one encounter result: a separate block, never merged into PoB numbers.
export function approximationsFor(encounter, result, db, { thornsTexts = null } = {}) {
  const config = encounter.changes?.config ?? {};
  const level = config.enemyLevel ?? encounter.map?.area_level ?? null;
  const targets = db && level ? Object.fromEntries(['normal', 'magic'].map(a => [a, enemyLife(db, a, level).value])) : {};
  const texts = thornsTexts ?? (encounter.modifiers ?? []).map(m => m.text ?? '');
  return approximateModels({ output: result.output, explodeMods: result.explode_mods, kind: encounter.enemy.kind, life: encounter.life, targets,
    enemyResists: enemyResistsOf(config, 'None'), thorns: parseThorns(texts) });
}

let enemyDbCache = null;
const cachedEnemyDb = () => (enemyDbCache ??= loadEnemyDb());

function summarize(encounter, result, clean) {
  const o = result.output;
  const axes = [...new Set(encounter.not_modelled.flatMap(n => n.axes).concat(encounter.modifiers.flatMap(m => m.axes ?? [])))];
  const row = { label: encounter.label, enemy: encounter.enemy, map: encounter.map, calculation_id: result.calculation_id,
    damage: { ...damageOf(o, encounter.life, result.minion_output), on_kill_explosions: explosionsOf(result.explode_mods, encounter.life) }, defence: defenceOf(o), modifiers: encounter.modifiers, not_modelled: encounter.not_modelled,
    build_checks: buildChecks(axes, o), assumptions: encounter.assumptions,
    engine_warnings: result.engine_warnings ?? [], unparsed_custom_mods: result.unparsed_custom_mods ?? [] };
  try { row.approximations = approximationsFor(encounter, result, cachedEnemyDb()); } catch (e) { row.approximations = { error: String(e.message ?? e) }; }
  if (encounter.enemy.kind === 'damage_over_time') {
    // A degen skill has no configured hit: replace the hit verdict with the degen assessment.
    row.defence.dot = dotOf(o, encounter.enemy.dot_raw_dps);
    Object.assign(row.defence, { verdict: row.defence.dot.verdict, hits_to_die: null, enemy_hit_raw: null, enemy_hit_after_mods: null, taken_per_hit: {}, dominant_type: row.defence.dot.rows?.slice().sort((a, b) => (b.taken_dps ?? 0) - (a.taken_dps ?? 0))[0]?.type ?? null });
  }
  if (clean) {
    const c = clean.output, cd = defenceOf(c);
    const best = d => d.best_dps;
    // Worst per-type change of max hit: catches resistance/defence losses the physical generic hit cannot show.
    const maxHit = types.map(t => ({ type: t, pct: pct(cd.max_hit[t], row.defence.max_hit[t]) })).filter(x => x.pct != null).sort((a, b) => a.pct - b.pct)[0] ?? null;
    row.vs_clean = { dps_pct: pct(best(damageOf(c, null, clean.minion_output)), best(row.damage)), hits_to_die_pct: pct(cd.hits_to_die, row.defence.hits_to_die),
      max_hit_pct: maxHit?.pct ?? null, max_hit_type: maxHit?.pct < 0 ? maxHit.type : null,
      ehp_pct: pct(cd.ehp, row.defence.ehp), enemy_hit_pct: pct(cd.enemy_hit_after_mods, row.defence.enemy_hit_after_mods), clean_verdict: cd.verdict };
  }
  if (row.unparsed_custom_mods.length) row.assumptions = [...row.assumptions, `PoB could not parse: ${row.unparsed_custom_mods.map(u => u.line).join('; ')}`];
  return row;
}

// ---------- Engine plumbing ----------
function runAll({ file, scenario, jobs, base, concurrency }) {
  const changesList = jobs.map(j => mergeChanges(base, j.changes));
  const batch = runBatch({ file, scenario, changesList, concurrency, full: true });
  const get = changes => { const r = batch.results.get(canonicalJson(changes)); if (!r || r.error) throw new Error(`Encounter calculation failed: ${r?.error ?? 'missing'}`); return r; };
  return { results: changesList.map(get), runs: batch.runs, elapsed_ms: batch.elapsed_ms };
}
function contextOf(spec) { return { db: loadEnemyDb(), bosses: loadBossScenarios(), spec }; }
const header = (file, scenario, extra = {}) => ({ game: 'poe1', patch: '3.30', build_file: path.basename(file), scenario, ...extra });

export function analyzeEncounter({ file, scenario = 'sustained', spec, base = {}, concurrency = defaultConcurrency }) {
  const { db, bosses } = contextOf(spec);
  const encounter = buildEncounter(db, bosses, spec);
  const hasMods = (spec.mods ?? []).length || spec.map_mod_effect || spec.delirium;
  const clean = hasMods ? buildEncounter(db, bosses, cleanSpec(spec)) : null;
  const jobs = [encounter, ...(clean ? [clean] : [])];
  const run = runAll({ file, scenario, jobs, base, concurrency });
  return { ...header(file, scenario, { analysis: 'encounter' }), ...summarize(encounter, run.results[0], clean ? run.results[1] : null),
    changes: encounter.changes, thresholds, timing: { engine_runs: run.runs, batch_elapsed_ms: run.elapsed_ms }, disclaimer };
}

export function sweepVerdict(row) {
  const v = row.vs_clean ?? {};
  const risk = row.build_checks.filter(c => c.status === 'risk');
  const reasons = [];
  if (row.defence.verdict === 'one_shot' && v.clean_verdict !== 'one_shot') reasons.push('new one-shot');
  if (v.dps_pct != null && v.dps_pct <= -40) reasons.push(`DPS ${v.dps_pct}%`);
  if (v.hits_to_die_pct != null && v.hits_to_die_pct <= -40) reasons.push(`hits to die ${v.hits_to_die_pct}%`);
  if (v.max_hit_pct != null && v.max_hit_pct <= -40) reasons.push(`${v.max_hit_type} max hit ${v.max_hit_pct}%`);
  if (risk.some(c => c.axis.startsWith('reflect'))) reasons.push('reflect risk');
  if (reasons.length) return { verdict: 'avoid', reasons };
  if (v.dps_pct != null && v.dps_pct <= -15) reasons.push(`DPS ${v.dps_pct}%`);
  if (v.hits_to_die_pct != null && v.hits_to_die_pct <= -20) reasons.push(`hits to die ${v.hits_to_die_pct}%`);
  if (v.max_hit_pct != null && v.max_hit_pct > -40 && v.max_hit_pct <= -20) reasons.push(`${v.max_hit_type} max hit ${v.max_hit_pct}%`);
  if (v.ehp_pct != null && v.ehp_pct <= -20) reasons.push(`EHP ${v.ehp_pct}%`);
  if (risk.length) reasons.push(...risk.map(c => c.axis));
  if (reasons.length) return { verdict: 'caution', reasons };
  if (row.modifiers.every(m => ['not_modelled', 'no_combat_effect'].includes(m.method))) {
    const manual = row.build_checks.filter(c => c.status !== 'ok');
    return manual.length ? { verdict: 'manual', reasons: manual.map(c => c.axis) } : { verdict: 'ok', reasons: ['no combat effect in the model'] };
  }
  return { verdict: 'ok', reasons: [] };
}

export function analyzeMapModSweep({ file, scenario = 'sustained', tier = 16, enemy = 'rare', base = {}, concurrency = defaultConcurrency, include = 'combat' }) {
  const db = loadEnemyDb(), bosses = loadBossScenarios();
  const band = bandOfTier(tier);
  const mods = Object.values(db.map_mods).filter(m => m.tiers[band] && (include === 'all' || m.tiers[band].engine.method !== 'no_combat_effect'));
  const spec = { enemy, tier, mods: [] };
  // "Unique Boss ..." mods only affect the map boss: they are compared against the map boss of the same tier.
  const bossSpec = { enemy: 'map_boss', tier, mods: [] };
  const isBossEnemy = parseEnemy(enemy).kind === 'boss' || ['map_boss', 'pinnacle', 'uber'].includes(parseEnemy(enemy).archetype);
  const specFor = m => (isBossOnly(m.tiers[band]) && !isBossEnemy ? bossSpec : spec);
  const clean = buildEncounter(db, bosses, spec), bossClean = buildEncounter(db, bosses, bossSpec);
  const encounters = mods.map(m => ({ boss: specFor(m) === bossSpec, e: buildEncounter(db, bosses, { ...specFor(m), mods: [m.id] }) }));
  const run = runAll({ file, scenario, jobs: [clean, bossClean, ...encounters.map(x => x.e)], base, concurrency });
  const rows = encounters.map(({ e, boss }, i) => {
    const row = summarize(e, run.results[i + 2], run.results[boss ? 1 : 0]);
    return { id: e.modifiers[0].id, name: e.modifiers[0].name, text: e.modifiers[0].text, method: e.modifiers[0].method, compared_against: boss ? 'map_boss' : enemy, ...sweepVerdict(row),
      vs_clean: row.vs_clean, verdict_hit: row.defence.verdict, build_checks: row.build_checks.filter(c => c.status !== 'ok'), unparsed_custom_mods: row.unparsed_custom_mods };
  });
  const order = { avoid: 0, caution: 1, manual: 2, ok: 3 };
  rows.sort((a, b) => order[a.verdict] - order[b.verdict] || (a.vs_clean?.dps_pct ?? 0) + (a.vs_clean?.hits_to_die_pct ?? 0) - ((b.vs_clean?.dps_pct ?? 0) + (b.vs_clean?.hits_to_die_pct ?? 0)));
  const cleanRow = summarize(clean, run.results[0], null);
  return { ...header(file, scenario, { analysis: 'map_mod_sweep', tier, band, enemy }),
    clean: { label: cleanRow.label, damage: cleanRow.damage, defence: cleanRow.defence },
    counts: Object.fromEntries(Object.keys(order).map(k => [k, rows.filter(r => r.verdict === k).length])),
    mods: rows, thresholds, timing: { engine_runs: run.runs, batch_elapsed_ms: run.elapsed_ms },
    note: 'Each map mod alone against the clean enemy of the same tier. Combinations are not additive; check the actual map with analyze encounter.', disclaimer };
}

// Standard set: map content by tier, generic bosses and every PoB boss skill preset.
export function standardEncounters(bosses, { tier = 16, bossTier = 'uber', skills = true } = {}) {
  const list = [
    { enemy: 'rare', tier }, { enemy: 'rare', tier, damage_profile: 'mixed' }, { enemy: 'map_boss', tier }, { enemy: 'rare', tier: 17 }, { enemy: 'rare', tier: 17, damage_profile: 'mixed' }, { enemy: 'map_boss', tier: 17 },
    { enemy: 'pinnacle' }, { enemy: 'uber' }
  ];
  if (skills) for (const b of Object.values(bosses.bosses)) for (const s of b.tiers[bossTier].skills) list.push({ enemy: `boss:${b.id}:${s.skill}`, boss_tier: bossTier });
  return list;
}

export function analyzeReport({ file, scenario = 'sustained', tier = 16, bossTier = 'uber', base = {}, concurrency = defaultConcurrency, sweepTiers = [16, 17], enemyLife = null, extra = {} }) {
  const db = loadEnemyDb(), bosses = loadBossScenarios();
  // extra: options shared by every encounter (pantheon). enemy_life only makes sense for a single boss, so it is applied to bosses.
  const specs = standardEncounters(bosses, { tier, bossTier }).map(s => ({ ...s, ...extra, enemy_life: s.enemy.startsWith('boss:') ? enemyLife : null }));
  const encounters = specs.map(s => buildEncounter(db, bosses, s));
  const run = runAll({ file, scenario, jobs: encounters, base, concurrency });
  const matrix = encounters.map((e, i) => { const r = summarize(e, run.results[i], null); return { label: r.label, calculation_id: r.calculation_id, enemy: r.enemy, damage: r.damage, defence: r.defence, assumptions: r.assumptions }; });
  const sweeps = sweepTiers.map(t => analyzeMapModSweep({ file, scenario, tier: t, enemy: 'rare', base, concurrency }));
  const rareIndex = encounters.findIndex(e => e.enemy.archetype === 'rare');
  const thornsBand = bandOfTier(Math.max(...sweepTiers, tier));
  const thornsTexts = Object.values(db.map_mods).filter(m => (m.danger_axes ?? []).some(a => a.startsWith('reflect')) && m.tiers[thornsBand]).map(m => m.tiers[thornsBand].text);
  const approximations = rareIndex >= 0 ? { encounter: encounters[rareIndex].label, thorns_band: thornsBand, ...approximationsFor(encounters[rareIndex], run.results[rareIndex], db, { thornsTexts }) } : null;
  const hits = matrix.filter(m => m.defence.hits_to_die != null);
  const worst = hits.slice().sort((a, b) => a.defence.hits_to_die - b.defence.hits_to_die)[0] ?? null;
  const weakest = Object.entries(matrix.reduce((acc, m) => { if (m.defence.weakest_type) acc[m.defence.weakest_type] = (acc[m.defence.weakest_type] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { ...header(file, scenario, { analysis: 'survival_damage_report', tier, boss_tier: bossTier }),
    summary: { worst_encounter: worst ? { label: worst.label, hits_to_die: worst.defence.hits_to_die, verdict: worst.defence.verdict, dominant_type: worst.defence.dominant_type } : null,
      one_shots: matrix.filter(m => m.defence.verdict === 'one_shot').map(m => m.label), dangerous: matrix.filter(m => ['dangerous', 'degen_dangerous'].includes(m.defence.verdict)).map(m => m.label),
      weakest_max_hit_type: weakest, map_mods_to_avoid: Object.fromEntries(sweeps.map(s => [s.band, s.mods.filter(m => m.verdict === 'avoid').map(m => m.name)])) },
    matrix, sweeps, approximations, thresholds,
    timing: { engine_runs: run.runs + sweeps.reduce((a, s) => a + s.timing.engine_runs, 0) }, disclaimer };
}

// ---------- Markdown ----------
const ttk = d => (d.time_to_kill_s != null ? fmt(d.time_to_kill_s) : d.time_to_kill_range_s ? `${fmt(d.time_to_kill_range_s[0])}-${fmt(d.time_to_kill_range_s[1])} (оценка)` : '-');
const fmt = v => (v == null ? '-' : typeof v === 'number' ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(round(v, 2))) : String(v));
const signed = v => (v == null ? '-' : `${v > 0 ? '+' : ''}${v}%`);
const verdictRu = { one_shot: 'ваншот', dangerous: 'опасно', survives_hit: 'держит', unknown: '?', avoid: 'избегать', caution: 'осторожно', manual: 'вручную', ok: 'ок', sustains_degen: 'дегген держит', degen_survivable: 'дегген терпимо', degen_dangerous: 'дегген опасен' };

export function markdownReport(report) {
  const out = [];
  const push = (...l) => out.push(...l);
  if (report.analysis === 'survival_damage_report') {
    push(`# Выживаемость и урон: ${report.build_file}`, '', `Сценарий PoB: \`${report.scenario}\`, базовый тир карт T${report.tier}, боссы: ${report.boss_tier}.`, '');
    const s = report.summary;
    push('## Итог', '');
    if (s.worst_encounter) push(`- Самый опасный противник: **${s.worst_encounter.label}** — ${fmt(s.worst_encounter.hits_to_die)} удара до смерти (${verdictRu[s.worst_encounter.verdict]}), основной тип урона ${s.worst_encounter.dominant_type ?? '-'}.`);
    push(`- Ваншоты: ${s.one_shots.length ? s.one_shots.join('; ') : 'нет'}.`, `- Опасные удары (>= 70% запаса): ${s.dangerous.length ? s.dangerous.join('; ') : 'нет'}.`, `- Чаще всего самый низкий max hit: ${s.weakest_max_hit_type ?? '-'}.`);
    for (const [band, list] of Object.entries(s.map_mods_to_avoid)) push(`- Моды карт ${band}, которых стоит избегать: ${list.length ? list.join(', ') : 'нет'}.`);
    push('', '## Противники', '', '| Противник | DPS | TTK, с | Удар врага | Ударов до смерти | Итог | Тип | EHP |', '|---|---:|---:|---:|---:|---|---|---:|');
    for (const m of report.matrix) push(`| ${m.label} | ${fmt(m.damage.best_dps)} | ${ttk(m.damage)} | ${fmt(m.defence.enemy_hit_after_mods)} | ${m.defence.dot ? `дегген: ${fmt(m.defence.dot.taken_dps)}/с vs реген ${fmt(m.defence.dot.recovery_per_s)}/с` : fmt(m.defence.hits_to_die)} | ${verdictRu[m.defence.verdict]} | ${m.defence.dominant_type ?? '-'} | ${fmt(m.defence.ehp)} |`);
    const first = report.matrix[0];
    if (first) push('', `Max hit (${first.label}): ${Object.entries(first.defence.max_hit).map(([t, v]) => `${t} ${fmt(v)}`).join(', ')}.`);
    for (const sw of report.sweeps) push('', ...markdownSweep(sw, 3));
    if (report.approximations) push('', ...markdownApprox(report.approximations, 2, `${report.approximations.encounter}; thorns: моды ${report.approximations.thorns_band}`));
  } else if (report.analysis === 'map_mod_sweep') push(...markdownSweep(report, 2));
  else if (report.analysis === 'encounter') {
    push(`# ${report.label}`, '', `Сборка: ${report.build_file}, сценарий \`${report.scenario}\`.`, '');
    const d = report.damage, f = report.defence, v = report.vs_clean;
    push('| Показатель | Значение | К чистому |', '|---|---:|---:|',
      `| DPS (${d.dps_basis ?? '-'}) | ${fmt(d.best_dps)} | ${signed(v?.dps_pct)} |`,
      `| Время убийства, с | ${ttk(d)} | |`, `| Удар врага после модов | ${fmt(f.enemy_hit_after_mods)} | ${signed(v?.enemy_hit_pct)} |`,
      `| Ударов до смерти | ${fmt(f.hits_to_die)} (${verdictRu[f.verdict]}) | ${signed(v?.hits_to_die_pct)} |`, `| EHP | ${fmt(f.ehp)} | ${signed(v?.ehp_pct)} |`, '');
    push(`Max hit: ${Object.entries(f.max_hit).map(([t, x]) => `${t} ${fmt(x)}`).join(', ')}. Восстановление в секунду: ${fmt(f.recovery_per_s.total)}.`, '');
    if (report.modifiers.length) { push('## Моды карты', ''); for (const m of report.modifiers) push(`- **${m.name}** (${m.method}): ${String(m.text ?? m.status).replace(/\n/g, '; ')}`); push(''); }
    const checks = report.build_checks.filter(c => c.status !== 'ok');
    if (checks.length) { push('## Не рассчитано движком — проверить', ''); for (const c of checks) push(`- ${c.axis} (${c.status}): ${c.evidence}`); push(''); }
    if (report.approximations?.models) push(...markdownApprox(report.approximations, 2), '');
    if (report.assumptions.length) { push('## Допущения', ''); for (const a of report.assumptions) push(`- ${a}`); push(''); }
  }
  push('', `_${report.disclaimer}_`, '');
  return out.join('\n');
}

function markdownApprox(a, level, context = null) {
  const h = '#'.repeat(level), lines = [`${h} Приближённые модели вне PoB (WP9)`, ''];
  if (context) lines.push(`Основа: ${context}.`, '');
  lines.push(`_${a.disclaimer}_`, '');
  for (const m of a.models ?? []) {
    if (!m.applicable) { lines.push(`- **${m.id}**: не применимо — ${m.reason}`); continue; }
    const r = m.result;
    if (m.id === 'recoup_sustain') lines.push(`- **recoup_sustain** (confidence ${m.confidence}): входящий урон ${fmt(r.taken_per_s)}/с; recoup life ${fmt(r.life_recoup_per_s)}/с; восстановление без recoup ${fmt(r.recovery_without_recoup_per_s)}/с (покрытие ${fmt(r.sustain_ratio_without)}), с recoup ${fmt(r.recovery_with_recoup_per_s)}/с (покрытие ${fmt(r.sustain_ratio_with)}); первые ${m.inputs.recoup_duration_s} с без recoup: ${fmt(r.first_window_unrecovered)}.`);
    else if (m.id === 'on_kill_explosions') { lines.push(`- **on_kill_explosions** (confidence ${m.confidence}): ${r.chain_possible}.`); for (const x of r.rows) lines.push(`  - ${x.source_name ?? x.source ?? "explosion"}: ${x.percent_of_enemy_life}% жизни как ${x.damage_type}, шанс ${fmt(x.chance_pct)}%, урон ${fmt(x.damage_per_explosion ?? x.damage_per_explosion_range?.join('-'))}; доля жизни normal/magic: ${fmt(x.fraction_of_target_life.normal)}/${fmt(x.fraction_of_target_life.magic)}; взрывов normal на normal: ${fmt(x.normal_explosions_to_kill_normal)}.`); }
    else if (m.id === 'thorns_retaliation') lines.push(`- **thorns_retaliation** (confidence ${m.confidence}): ${fmt(r.damage_per_trigger)} урона за срабатывание, ${fmt(r.triggers_to_empty_pool)} срабатываний до пустого пула, восстановление держит ${fmt(r.sustainable_triggers_per_s)}/с; итог ${r.verdict}.`);
    else if (m.id === 'degen_tolerance') lines.push(`- **degen_tolerance** (confidence ${m.confidence}): выдерживаемый дегген ${m.result.rows.map(x => `${x.type} ${fmt(x.tolerance_dps)}/с`).join(', ')}; слабейший ${r.weakest_type}.`);
  }
  return lines;
}

function markdownSweep(sw, level) {
  const h = '#'.repeat(level);
  const lines = [`${h} Моды карт ${sw.band} (T${sw.tier}) против ${sw.enemy}`, '', `Чистый противник: ${sw.clean.label}; DPS ${fmt(sw.clean.damage.best_dps)}, ударов до смерти ${fmt(sw.clean.defence.hits_to_die)}.`, '',
    `Итого: избегать ${sw.counts.avoid}, осторожно ${sw.counts.caution}, вручную ${sw.counts.manual}, ок ${sw.counts.ok}.`, '',
    '| Мод | Итог | DPS | Ударов до смерти | Max hit | EHP | Причины |', '|---|---|---:|---:|---:|---:|---|'];
  for (const m of sw.mods.filter(x => x.verdict !== 'ok')) lines.push(`| ${m.name}${m.compared_against === 'map_boss' && sw.enemy !== 'map_boss' ? ' (против босса карты)' : ''} | ${verdictRu[m.verdict]} | ${signed(m.vs_clean?.dps_pct)} | ${signed(m.vs_clean?.hits_to_die_pct)} | ${m.vs_clean?.max_hit_type ? `${m.vs_clean.max_hit_type} ${signed(m.vs_clean.max_hit_pct)}` : '-'} | ${signed(m.vs_clean?.ehp_pct)} | ${m.reasons.join(', ')} |`);
  const ok = sw.mods.filter(x => x.verdict === 'ok').map(x => x.name);
  if (ok.length) lines.push('', `Без заметного влияния: ${ok.join(', ')}.`);
  return lines;
}

export function writeMarkdown(file, report) { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(path.resolve(file), markdownReport(report), 'utf8'); return path.resolve(file); }
