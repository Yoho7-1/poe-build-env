// Boss survival scenarios derived from the pinned Path of Building data (BossSkills, Bosses, monster tables).
// Pure functions only: the engine is not called here. A survival verdict is a numeric estimate, not a game test.
import fs from 'node:fs';
import path from 'node:path';
import { dbRoot, readJson, atomicJson, hashFile } from './workspace.mjs';

export const scenarioFile = path.join(dbRoot, 'scenarios/bosses.json');
export const damageTypes = ['Physical', 'Lightning', 'Cold', 'Fire', 'Chaos'];
export const tiers = {
  pinnacle: { enemyIsBoss: 'Pinnacle', enemy_level: 84, label: 'Guardian/Pinnacle Boss (PoB "Pinnacle")' },
  uber: { enemyIsBoss: 'Uber', enemy_level: 85, label: 'Uber Pinnacle Boss (PoB "Uber")' }
};
export const defaultRollRange = 70;

// Explicit mapping: PoB boss skill presets are named after the boss, profiles use internal ids.
const bossSkillOwners = {
  Atziri: ['Atziri Flameblast'],
  Shaper: ['Shaper Ball', 'Shaper Slam', 'Shaper Beam'],
  Sirus: ['Sirus Meteor'],
  Venarius: ['Cortex Ground Degen'],
  SearingExarch: ['Exarch Ball'],
  EaterOfWorlds: ['Eater Beam'],
  Maven: ['Maven Fireball', 'Maven Memory Game']
};
const displayNames = { SearingExarch: 'The Searing Exarch', EaterOfWorlds: 'The Eater of Worlds', Venarius: 'Venarius (Cortex)',
  Maven: 'The Maven', Shaper: 'The Shaper', Elder: 'The Elder', Sirus: 'Sirus, Awakener of Worlds', Atziri: 'Atziri' };
const aliases = { exarch: 'SearingExarch', 'searing exarch': 'SearingExarch', eater: 'EaterOfWorlds', 'eater of worlds': 'EaterOfWorlds', cortex: 'Venarius',
  'uber maven': 'Maven', 'uber shaper': 'Shaper', 'uber sirus': 'Sirus', 'uber elder': 'Elder', 'uber atziri': 'Atziri' };
// Skill caveats stated by the PoB tooltips; kept as data so the report cannot silently drop them.
const skillCaveats = {
  'Maven Memory Game': ['In game: three separate hits plus a large DoT. PoB converts the hit into cold, fire and lightning together (with the monster phys->elemental conversion multiplier), so its hit is pessimistic for one hit; the DoT is not included.'],
  'Sirus Meteor': ['Damage depends on the wall phase; earlier meteors deal less.', 'Converted parts are scaled by PoB monster phys->elemental conversion multiplier; the pure-type cross-check ignores it.'],
  'Exarch Ball': ['Many waves (8-18); single-hit max hit does not cover overlapping balls.'],
  'Eater Beam': ['Insatiable Appetite atlas node forces a 30% shock; not modelled unless configured.'],
  'Shaper Slam': ['Uber variant cannot be evaded, blocked or dodged; requires Cosmic Wounds for the uber multiplier.'],
  'Shaper Ball': ['Cosmic Wounds raises cold penetration to 40% (uber) and adds projectiles.'],
  'Maven Fireball': ['Throw the Gauntlet doubles damage and adds 30% fire penetration (uber).']
};

function parseLuaNumberTable(text, name) {
  const match = text.match(new RegExp(`${name.replace('.', '\\.')}\\s*=\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`PoB table not found: ${name}`);
  return match[1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
}
function parseMisc(text, key) {
  const match = text.match(new RegExp(`\\b${key}\\s*=\\s*([0-9.]+)\\s*(?:/\\s*([0-9.]+))?`));
  if (!match) throw new Error(`PoB constant not found: ${key}`);
  return match[2] ? Number(match[1]) / Number(match[2]) : Number(match[1]);
}

// Reproduces the placeholder arithmetic of ConfigOptions.lua presetBossSkills for a given tier.
export function skillProfile(name, skill, tier, { damageTable, rollRange = defaultRollRange }) {
  const t = tiers[tier];
  if (!t) throw new Error(`Unknown tier: ${tier}`);
  const isUber = tier === 'uber' || (skill.earlierUber === true && tier === 'pinnacle');
  const roll = Math.min(Math.max(rollRange, 0), 100);
  const base = damageTable[t.enemy_level - 1];
  const damage = {};
  for (const [type, [flat, perRoll]] of Object.entries(skill.DamageMultipliers ?? {}))
    damage[type] = Math.round(base * (flat + roll * perRoll) * (isUber && skill.UberDamageMultiplier ? skill.UberDamageMultiplier : 1));
  const penetration = {};
  for (const [key, value] of Object.entries(skill.DamagePenetrations ?? {})) {
    const chosen = isUber && skill.UberDamagePenetrations?.[key] != null ? skill.UberDamagePenetrations[key] : value;
    if (chosen !== '' && chosen != null) penetration[key] = Number(chosen);
  }
  // PoB iterates only DamagePenetrations keys; an uber-only key would not be applied, so it is not added here either.
  const extra = (isUber ? skill.additionalStats?.uber : skill.additionalStats?.base) ?? {};
  const flags = Object.keys(extra).filter(k => extra[k] === 'flag');
  const conversion = Object.fromEntries(Object.entries(extra).filter(([k, v]) => v !== 'flag' && /ConvertTo/.test(k)).map(([k, v]) => [k.replace('PhysicalDamageSkillConvertTo', 'Physical->'), v]));
  const enemyIncreasedDamage = name === 'Atziri Flameblast' && isUber ? 60 : 0;
  return {
    skill: name, tier, uber_values_applied: isUber, damage_type: skill.DamageType ?? null,
    kind: skill.DamageType === 'DamageOverTime' ? 'damage_over_time' : 'hit',
    damage, penetration, conversion, flags,
    enemy_increased_damage_percent: enemyIncreasedDamage,
    enemy_increased_damage_note: enemyIncreasedDamage ? 'Applied by the engine as an enemy damage modifier; PoB MaximumHitTaken already divides by it, so compare raw damage.' : undefined,
    crit_chance_percent: skill.critChance ?? null,
    attack_time_ms: isUber && skill.UberSpeed ? skill.UberSpeed : skill.speed ?? null,
    roll_range_percent: roll,
    caveats: [...(skillCaveats[name] ?? []), ...(skill.critChance == null ? ['Crit chance not overridden: PoB default enemy crit applies; MaximumHitTaken is a non-crit hit.'] : [])],
    pob_tooltip: String(skill.tooltip ?? '').replace(/\^x[0-9A-F]{6}|\^\d/g, '').trim(),
    config: { enemyIsBoss: t.enemyIsBoss, presetBossSkills: name, enemyDamageRollRange: roll }
  };
}

export function genericProfile(tier, { damageTable, misc }) {
  const t = tiers[tier];
  const mult = tier === 'uber' ? misc.uberBossDPSMult : misc.pinnacleBossDPSMult;
  const pen = tier === 'uber' ? misc.uberBossPen : misc.pinnacleBossPen;
  const each = Math.round(damageTable[t.enemy_level - 1] * 1.5 * mult);
  return { skill: `Generic ${tier}`, tier, kind: 'hit', damage_type: 'Average',
    damage: { Physical: each, Lightning: each, Cold: each, Fire: each, Chaos: Math.round(each / 2.5) },
    penetration: { LightningPen: pen, ColdPen: pen, FirePen: pen }, conversion: {}, flags: [], enemy_increased_damage_percent: 0,
    crit_chance_percent: null, attack_time_ms: 700, roll_range_percent: null,
    caveats: ['PoB generic expected boss hit: the engine counts all typed parts as one configured hit. Not a real boss skill.'],
    config: { enemyIsBoss: t.enemyIsBoss, presetBossSkills: 'None' } };
}

export function buildBossScenarios({ cacheRoot = path.join(dbRoot, 'cache/knowledge/pob'), pobRoot = path.join(dbRoot, 'vendor/pob/src') } = {}) {
  const skillsFile = path.join(cacheRoot, 'BossSkills.json'), bossesFile = path.join(cacheRoot, 'Bosses.json');
  const miscFile = path.join(pobRoot, 'Data/Misc.lua'), dataFile = path.join(pobRoot, 'Modules/Data.lua');
  const { bossSkills } = readJson(skillsFile);
  const bosses = readJson(bossesFile);
  const damageTable = parseLuaNumberTable(fs.readFileSync(miscFile, 'utf8'), 'data.monsterDamageTable');
  const dataText = fs.readFileSync(dataFile, 'utf8');
  const misc = Object.fromEntries(['pinnacleBossDPSMult', 'pinnacleBossPen', 'uberBossDPSMult', 'uberBossPen', 'MaxEnemyLevel'].map(k => [k, parseMisc(dataText, k)]));
  for (const skills of Object.values(bossSkillOwners)) for (const s of skills) if (!bossSkills[s]) throw new Error(`Boss skill missing from PoB data: ${s}`);
  const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
  const profiles = {};
  for (const [id, stats] of Object.entries(bosses)) {
    const skills = bossSkillOwners[id] ?? [];
    profiles[id] = {
      id, name: displayNames[id] ?? id, pob_is_uber_capable: stats.isUber === true,
      enemy_defence: { armour_mult_percent: stats.armourMult ?? null, evasion_mult_percent: stats.evasionMult ?? null },
      skill_coverage: skills.length ? 'pob_boss_skill_presets' : 'generic_only',
      tiers: Object.fromEntries(Object.keys(tiers).map(tier => [tier, {
        skills: skills.map(s => skillProfile(s, bossSkills[s], tier, { damageTable })),
        generic: genericProfile(tier, { damageTable, misc })
      }]))
    };
  }
  return {
    game: 'poe1', patch: '3.30', kind: 'boss_survival_scenarios',
    provenance: { pob_version: lock.versions?.pob ?? null, pob_commit: lock.versions?.pob_commit ?? null,
      sources: [skillsFile, bossesFile, miscFile, dataFile].map(f => ({ file: path.relative(dbRoot, f).replaceAll('\\', '/'), sha256: hashFile(f) })) },
    method: 'Damage reproduces PoB ConfigOptions presetBossSkills placeholders (monsterDamageTable[level] * (flat + roll * perRoll) * uber multiplier). Defaults: enemy level 84 pinnacle / 85 uber, roll range 70%.',
    disclaimer: 'Numeric engine-based estimate; not a game test. Boss mechanics beyond one PoB preset hit (degens, overlapping hits, map mods, atlas nodes) are not covered unless stated.',
    misc, bosses: profiles
  };
}

export function writeBossScenarios(file = scenarioFile) { const data = buildBossScenarios(); atomicJson(file, data); return { file, bosses: Object.keys(data.bosses).length, provenance: data.provenance }; }
export function loadBossScenarios(file = scenarioFile) {
  if (!fs.existsSync(file)) throw new Error('scenarios/bosses.json missing; run: agent.mjs analyze bosses build');
  return readJson(file);
}

export function resolveBoss(data, query) {
  if (!query) throw new Error('--boss required');
  const key = String(query).trim(), lower = key.toLowerCase();
  const id = data.bosses[key] ? key : aliases[lower] ?? Object.keys(data.bosses).find(k => k.toLowerCase() === lower || data.bosses[k].name.toLowerCase() === lower || data.bosses[k].name.toLowerCase().replace(/^the /, '') === lower);
  if (!id) throw new Error(`Unknown boss: ${query}. Known: ${Object.keys(data.bosses).join(', ')}`);
  return data.bosses[id];
}

export function bossChanges(profile, tier, base = {}) {
  if (!tiers[tier]) throw new Error(`Unknown tier: ${tier}; use ${Object.keys(tiers).join('/')}`);
  const entry = profile.tiers[tier];
  const list = entry.skills.length ? entry.skills : [entry.generic];
  return list.map(skill => ({ skill: skill.skill, changes: { ...base, config: { ...(base.config ?? {}), ...skill.config } } }));
}

const configOf = result => ({ ...(result.config && typeof result.config === 'object' ? result.config : {}), ...(result.changes?.config ?? {}) });
export function matchResult(results, skill) {
  return results.find(r => { const c = configOf(r); return c.presetBossSkills === skill.config.presetBossSkills && c.enemyIsBoss === skill.config.enemyIsBoss; });
}

export function assertSameBaseline(results) {
  const [first] = results;
  for (const r of results) {
    for (const key of ['input_sha256', 'calculation_contract_sha256', 'scenario']) if (r[key] !== first[key]) throw new Error(`Results differ in ${key}; survival comparison requires one baseline/contract/scenario`);
    if (r.engine?.commit !== first.engine?.commit) throw new Error('Results differ in engine commit');
  }
}

export function hitAssessment(skill, output) {
  const rows = [];
  for (const [type, damage] of Object.entries(skill.damage)) {
    if (!damage) continue;
    const maxHit = output?.[`${type}MaximumHitTaken`];
    if (typeof maxHit !== 'number' || !(maxHit > 0)) { rows.push({ type, damage, max_hit: maxHit ?? null, ratio: null, status: 'missing_max_hit' }); continue; }
    rows.push({ type, damage, max_hit: maxHit, ratio: damage / maxHit });
  }
  const known = rows.filter(r => r.ratio != null);
  // Generic profile: types are alternative hits; real skills: the typed parts arrive together (linear approximation).
  const combined = skill.damage_type === 'Average' ? Math.max(0, ...known.map(r => r.ratio)) : known.reduce((s, r) => s + r.ratio, 0);
  const dominant = known.slice().sort((a, b) => b.ratio - a.ratio)[0] ?? null;
  const verdict = rows.some(r => r.ratio == null) ? 'unknown' : combined >= 1 ? 'one_shot' : combined >= 0.7 ? 'dangerous' : 'survives_hit';
  return { rows, damage_fraction_of_max_hit: known.length ? combined : null, hits_to_die: combined > 0 ? Math.max(1, Math.ceil(1 / combined - 1e-9)) : null,
    margin_multiplier: combined > 0 ? 1 / combined : null, dominant_type: dominant?.type ?? null, verdict,
    method: 'pure-type max-hit estimate: sum (max for the generic profile) of raw damage / <Type>MaximumHitTaken; ignores skill conversion and the monster conversion multiplier' };
}

// Primary verdict: the engine's own count of configured boss hits to die (conversion, penetration and expected
// enemy crit included). Requires full output (pob run --full). Falls back to the pure-type max-hit estimate.
export function engineHitAssessment(skill, output) {
  const estimate = hitAssessment(skill, output);
  const hits = output?.NumberOfDamagingHits;
  const expected = Object.values(skill.damage).reduce((a, v) => a + (v ?? 0), 0);
  const applied = output?.totalEnemyDamageIn;
  const preset_check = typeof applied === 'number' ? { expected_raw_damage: expected, engine_raw_damage: applied,
    status: Math.abs(applied - expected) <= Math.max(2, expected * 0.02) ? 'matches' : 'mismatch' } : { status: 'unavailable' };
  if (typeof hits !== 'number' || !Number.isFinite(hits)) return { ...estimate, source: 'pure_type_max_hit_estimate', preset_check,
    note: 'NumberOfDamagingHits missing (run pob with --full); verdict uses per-type max hit, which ignores skill conversion.' };
  const taken = Object.fromEntries(damageTypes.map(t => [t, output[`${t}TakenHit`]]).filter(([, v]) => typeof v === 'number' && v > 0));
  const dominant = Object.entries(taken).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const fraction = hits > 0 ? 1 / hits : Infinity;
  const verdict = preset_check.status === 'mismatch' ? 'unknown' : hits < 1 ? 'one_shot' : fraction >= 0.7 ? 'dangerous' : 'survives_hit';
  return { source: 'engine_configured_hit', engine_hits_to_die: hits, damage_fraction_of_max_hit: fraction, hits_to_die: hits >= 1 ? Math.floor(hits) : 0,
    margin_multiplier: hits, dominant_type: dominant, taken_after_mitigation: taken, total_taken: output.totalTakenHit ?? null, verdict, preset_check,
    cross_check: { method: estimate.method, damage_fraction_of_max_hit: estimate.damage_fraction_of_max_hit, rows: estimate.rows },
    method: 'PoB NumberOfDamagingHits for the configured preset hit; fraction = 1 / hits' };
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// Degen (boss DoT skills): taken per second = raw * pool / <Type>DotEHP; compared with sustained recovery.
export function dotOf(o, raw) {
  const pool = (num(o.Life) ?? 0) + (num(o.EnergyShield) ?? 0);
  const rows = Object.entries(raw ?? {}).filter(([, v]) => v > 0).map(([t, v]) => {
    const ehp = num(o[`${t}DotEHP`]);
    return { type: t, raw_dps: v, dot_ehp: round(ehp), taken_dps: ehp > 0 && pool > 0 ? round(v * pool / ehp) : null };
  });
  const recovery = (num(o.LifeRegenRecovery) ?? 0) + (num(o.LifeLeechGainRate) ?? 0) + (num(o.EnergyShieldRegenRecovery) ?? 0);
  if (!rows.length || rows.some(r => r.taken_dps == null)) return { verdict: 'unknown', rows, note: 'DoT EHP missing; run with --full' };
  const taken = rows.reduce((a, r) => a + r.taken_dps, 0), net = taken - recovery;
  const time = net > 0 ? pool / net : null;
  return { verdict: net <= 0 ? 'sustains_degen' : time < 4 ? 'degen_dangerous' : 'degen_survivable', rows, taken_dps: round(taken), recovery_per_s: round(recovery, 1),
    net_loss_per_s: round(net), time_to_die_s: round(time, 2), method: 'pool (life + ES) / DoT EHP per type; regen, leech and ES regen as sustained recovery; MoM, recoup and flasks ignored' };
}

export function dotAssessment(skill, output) {
  const incoming = Object.values(skill.damage).reduce((s, v) => s + (v ?? 0), 0);
  return { incoming_raw_dps: incoming, by_type: skill.damage, ...dotOf(output ?? {}, skill.damage) };
}

export function evaluateSurvival(profile, tier, results) {
  if (!Array.isArray(results) || !results.length) throw new Error('At least one calculation result is required');
  assertSameBaseline(results);
  const entry = profile.tiers[tier];
  if (!entry) throw new Error(`Unknown tier: ${tier}`);
  const list = entry.skills.length ? entry.skills : [entry.generic];
  const skills = list.map(skill => {
    const result = matchResult(results, skill);
    if (!result) return { skill: skill.skill, status: 'not_calculated', required_config: skill.config };
    const assessment = skill.kind === 'damage_over_time' ? dotAssessment(skill, result.output) : engineHitAssessment(skill, result.output);
    return { skill: skill.skill, kind: skill.kind, damage_type: skill.damage_type, penetration: skill.penetration, flags: skill.flags, conversion: skill.conversion,
      calculation_id: result.calculation_id, ...assessment, caveats: skill.caveats };
  });
  const hits = skills.filter(s => s.kind === 'hit' && typeof s.damage_fraction_of_max_hit === 'number');
  const first = hits.slice().sort((a, b) => b.damage_fraction_of_max_hit - a.damage_fraction_of_max_hit)[0] ?? null;
  const first_result = results[0];
  return {
    game: 'poe1', patch: '3.30', boss: profile.id, name: profile.name, tier, skill_coverage: profile.skill_coverage,
    baseline: { input_sha256: first_result.input_sha256, scenario: first_result.scenario, calculation_contract_sha256: first_result.calculation_contract_sha256, engine_commit: first_result.engine?.commit ?? null },
    kills_first: first ? { skill: first.skill, damage_type: first.dominant_type, damage_fraction_of_max_hit: first.damage_fraction_of_max_hit, verdict: first.verdict } : null,
    skills,
    missing: skills.filter(s => s.status === 'not_calculated').map(s => s.skill),
    disclaimer: 'Numeric experiment from PoB configured boss hits; not a game test. Avoidance (block, suppression, evasion) and recovery between hits are not included; flags list layers that do not apply.'
  };
}
