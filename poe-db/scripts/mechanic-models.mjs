// WP9: approximate models for mechanics PoB does not calculate or calculates partially (registry: mechanics/gaps.mjs).
// Pure arithmetic over one PoB result (output + explode_mods) and the encounter; never runs the engine and never
// changes PoB numbers. Every model returns confidence, method, inputs, assumptions and sources so that the result can
// be shown next to PoB values, never inside DPS, EHP or hits-to-die.
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 0) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const elements = ['Fire', 'Cold', 'Lightning'];
const types = ['Physical', ...elements, 'Chaos'];

export const disclaimer = 'Approximate models outside PoB (WP9): explicit formulas with stated assumptions and confidence. Not part of PoB DPS/EHP/hits-to-die and not a game test; confirm with observe.';

// PoB Config placeholders for enemy resistances by enemyIsBoss (ConfigOptions.lua): None 0, Boss 40/25, Pinnacle and Uber 50/30.
export const defaultEnemyResists = {
  None: { Fire: 0, Cold: 0, Lightning: 0, Chaos: 0, Physical: 0 },
  Boss: { Fire: 40, Cold: 40, Lightning: 40, Chaos: 25, Physical: 0 },
  Pinnacle: { Fire: 50, Cold: 50, Lightning: 50, Chaos: 30, Physical: 0 },
  Uber: { Fire: 50, Cold: 50, Lightning: 50, Chaos: 30, Physical: 0 }
};

const recoveryOf = o => {
  const regen = num(o.LifeRegenRecovery) ?? 0, leech = num(o.LifeLeechGainRate) ?? 0, es = num(o.EnergyShieldRegenRecovery) ?? 0;
  return { life_regen: regen, life_leech: leech, es_regen: es, total: regen + leech + es };
};
const poolOf = o => (num(o.Life) ?? 0) + (num(o.EnergyShield) ?? 0);

// ---------- Recoup: steady-state recovery under a stream of enemy hits ----------
// PoB computes LifeRecoup % (already multiplied by recovery rate) and uses recoup only inside the EHP simulation.
// Steady state: every hit is recouped over 3-4 s, so the recoup rate equals recoup% x damage taken per second.
export function recoupSustain(o, { kind = 'hit' } = {}) {
  const base = { id: 'recoup_sustain', gap: 'recoup', confidence: 'medium', method: 'steady_state_recoup_per_second',
    sources: ['pob.calc-defence', 'wiki.recoup'] };
  const lifePct = num(o.LifeRecoup) ?? 0, esPct = num(o.EnergyShieldRecoup) ?? 0, manaPct = num(o.ManaRecoup) ?? 0;
  const perType = Object.fromEntries(types.map(t => [t, num(o[`${t}LifeRecoup`]) ?? 0]).filter(([, v]) => v > 0));
  if (!(lifePct > 0 || esPct > 0 || manaPct > 0 || Object.keys(perType).length)) return { ...base, applicable: false, reason: 'No recoup in the PoB output (LifeRecoup/EnergyShieldRecoup/ManaRecoup = 0).' };
  if (kind === 'damage_over_time') return { ...base, applicable: false, reason: 'Degen encounter: PoB applies recoup to hits only (DamageOverTime category excluded).' };
  const takenHit = num(o.totalTakenHit), skillTime = num(o.enemySkillTime);
  if (!(takenHit > 0) || !(skillTime > 0)) return { ...base, applicable: false, reason: 'No enemy hit or enemy attack time in the output.' };
  const total = num(o.TotalLifeRecoupRecovery), max = num(o.LifeRecoupRecoveryMax), pseudo = num(o.TotalLifePseudoRecoup) ?? 0;
  const duration = total > 0 && max > 0 && !pseudo ? (Math.abs(total / max - 3) < 0.25 ? 3 : 4) : 4;
  const takenPerS = takenHit / skillTime;
  const typed = Object.entries(perType).reduce((s, [t, p]) => s + (num(o[`${t}TakenHit`]) ?? 0) / skillTime * p / 100, 0);
  const life = takenPerS * lifePct / 100 + typed, es = takenPerS * esPct / 100, mana = takenPerS * manaPct / 100;
  const rec = recoveryOf(o), withRecoup = rec.total + life + es;
  return { ...base, applicable: true,
    inputs: { life_recoup_pct: round(lifePct, 1), energy_shield_recoup_pct: round(esPct, 1), mana_recoup_pct: round(manaPct, 1), typed_life_recoup_pct: perType,
      taken_per_hit: round(takenHit), enemy_attack_time_s: round(skillTime, 3), recoup_duration_s: duration },
    result: { taken_per_s: round(takenPerS), life_recoup_per_s: round(life), energy_shield_recoup_per_s: round(es), mana_recoup_per_s: round(mana),
      recovery_without_recoup_per_s: round(rec.total), recovery_with_recoup_per_s: round(withRecoup),
      sustain_ratio_without: round(rec.total / takenPerS, 2), sustain_ratio_with: round(withRecoup / takenPerS, 2),
      first_window_unrecovered: round(takenPerS * duration * (1 - Math.min(1, rec.total / takenPerS))),
      pob_partial: { LifeRecoupRecoveryAvg: round(num(o.LifeRecoupRecoveryAvg)), LifeRecoupRecoveryMax: round(num(o.LifeRecoupRecoveryMax)) } },
    assumptions: ['The configured enemy hits every enemySkillTime without pause (worst-case pressure, PoB generic hit after mitigation).',
      'Every hit is fully recouped; overhealing and full-life waste are ignored.',
      `Recoup arrives over ${duration} s: the first window (first_window_unrecovered) must be survived without it.`,
      'Life/ES/mana recoup of damage that MoM sends to mana uses the total taken per hit.'] };
}

// ---------- On-kill explosions: damage to the surrounding pack ----------
// Base = enemy life x amount%; reduced by the target's resistance (pack monsters: Config placeholder 0 unless the
// encounter sets enemy<Type>Resist). Compared with the life of normal/magic monsters of the same level.
export function onKillExplosions(explodeMods, { life = null, targets = {}, enemyResists = defaultEnemyResists.None } = {}) {
  const base = { id: 'on_kill_explosions', gap: 'on_kill_explosions', confidence: 'low', method: 'explosion_vs_pack_life',
    sources: ['pob.calc-setup', 'wiki.explode', 'project.enemy-db'] };
  if (!Array.isArray(explodeMods) || !explodeMods.length) return { ...base, applicable: false, reason: 'No ExplodeMod sources in the build (PoB explode_mods empty).' };
  const lives = life?.value ? [life.value] : life?.range ?? null;
  const resistOf = type => (type === 'RandomElement' ? elements.reduce((s, e) => s + (enemyResists[e] ?? 0), 0) / 3 : enemyResists[type] ?? 0);
  const rows = explodeMods.map(m => {
    const pct = num(m.amount), chance = num(m.chance) ?? 1, res = resistOf(m.type);
    const mult = 1 - Math.min(res, 100) / 100;
    const per = lives && pct != null ? lives.map(l => l * pct / 100 * mult) : null;
    const vs = Object.fromEntries(Object.entries(targets).filter(([, v]) => v > 0).map(([k, v]) => [k, per ? round(per[0] / v, 2) : null]));
    // A normal monster killed by explosions explodes too: overlapping explosions from normals needed to kill one normal.
    const selfChain = pct ? Math.ceil(1 / (pct / 100 * mult)) : null;
    return { source: m.source ?? null, source_name: m.source_name ?? null, damage_type: m.type, chance_pct: round(chance * 100, 1), percent_of_enemy_life: pct,
      requires: (m.conditions ?? []).map(c => (c === 'enemy:Cursed' ? 'enemy cursed' : c)), target_resist_pct: round(res, 1),
      damage_per_explosion: per?.length === 1 ? round(per[0]) : null, damage_per_explosion_range: per?.length > 1 ? per.map(v => round(v)) : null,
      expected_damage_per_kill: per?.length === 1 ? round(per[0] * chance) : null,
      fraction_of_target_life: vs, kills_normal_outright: vs.normal != null ? vs.normal >= 1 : null,
      normal_explosions_to_kill_normal: selfChain };
  });
  return { ...base, applicable: true, inputs: { enemy_life: life?.value ?? null, enemy_life_range: life?.range ?? null, enemy_life_basis: life?.basis ?? null, target_life: targets, target_resists: enemyResists },
    result: { rows, chain_possible: rows.some(r => r.kills_normal_outright) ? 'rare/boss kills one-shot normal monsters around them' : rows.some(r => r.normal_explosions_to_kill_normal != null && r.normal_explosions_to_kill_normal <= 3) ? 'chains only where several explosions overlap' : 'no chain from explosions alone' },
    assumptions: ['Player damage modifiers, penetration, crit and damage-taken debuffs on targets are not applied (unverified in-game).',
      'Targets have the pack resistance shown (Config placeholder 0 for non-boss monsters unless the encounter sets it).',
      'Conditions such as "enemy cursed" are assumed met; geometry and pack density are not modelled.',
      'Monster variety life multiplier = 1 (gap monster_variety_life).'] };
}

// ---------- Monster thorns: damage per trigger and how many triggers the build survives ----------
export function parseThorns(texts) {
  const out = { Physical: 0, Elemental: 0 };
  for (const t of texts ?? []) for (const m of String(t).matchAll(/(Physical|Elemental) Thorns reflecting (\d+)/g)) out[m[1]] = Math.max(out[m[1]], Number(m[2]));
  return out;
}
export function thornsRetaliation(o, thorns) {
  const base = { id: 'thorns_retaliation', gap: 'monster_thorns', confidence: 'low', method: 'flat_thorns_x_reflect_taken', sources: ['pob.calc-defence', 'wiki.thorns', 'project.enemy-db'] };
  if (!thorns || !(thorns.Physical > 0 || thorns.Elemental > 0)) return { ...base, applicable: false, reason: 'No thorns map mod in this encounter.' };
  const physMult = num(o.PhysicalTakenReflect) ?? 1;
  const eleMult = Math.max(...elements.map(e => num(o[`${e}TakenReflect`]) ?? 1));
  const perTrigger = thorns.Physical * physMult + thorns.Elemental * eleMult;
  const pool = poolOf(o), rec = recoveryOf(o).total;
  const hasHits = types.some(t => (num(o[`${t}HitAverage`]) ?? 0) > 0);
  return { ...base, applicable: true,
    inputs: { thorns_physical: thorns.Physical, thorns_elemental: thorns.Elemental, physical_taken_reflect: round(physMult, 3), elemental_taken_reflect_worst: round(eleMult, 3), pool_life_es: round(pool), recovery_per_s: round(rec, 1) },
    result: { damage_per_trigger: round(perTrigger), triggers_to_empty_pool: perTrigger > 0 ? round(pool / perTrigger, 1) : null,
      sustainable_triggers_per_s: perTrigger > 0 ? round(rec / perTrigger, 2) : null,
      main_skill_hits: hasHits, verdict: !hasHits ? 'likely_not_triggered' : perTrigger >= pool ? 'one_trigger_kills' : pool / perTrigger < 5 ? 'dangerous' : 'manageable' },
    assumptions: ['Each trigger deals the full flat thorns value, elemental part at the worst element multiplier.',
      'Which player hits trigger monster thorns (melee only or all hits) and any trigger cooldown are unverified; DoT does not hit.',
      'Recovery is regen + leech + ES regen from PoB, recoup excluded.'] };
}

// ---------- Degen tolerance: largest sustained degen per type that recovery outheals ----------
export function degenTolerance(o) {
  const base = { id: 'degen_tolerance', gap: 'ground_degen', confidence: 'low', method: 'recovery_over_dot_taken_multiplier', sources: ['pob.calc-defence', 'wiki.ground'] };
  const rec = recoveryOf(o), pool = poolOf(o);
  if (!(pool > 0)) return { ...base, applicable: false, reason: 'No life/ES pool in the output.' };
  const rows = types.map(t => {
    const res = t === 'Physical' ? 0 : num(o[`${t}Resist`]) ?? 0;
    const mult = Math.max(0.0001, 1 - res / 100);
    const dotEhp = num(o[`${t}DotEHP`]);
    return { type: t, resist_pct: res, taken_multiplier: round(mult, 3), tolerance_dps: round(rec.total / mult),
      pob_dot_ehp: round(dotEhp), pob_implied_multiplier: dotEhp > 0 ? round(pool / dotEhp, 3) : null };
  });
  return { ...base, applicable: true, inputs: { recovery: Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, round(v, 1)])), pool_life_es: round(pool) },
    result: { rows, weakest_type: rows.slice().sort((a, b) => a.tolerance_dps - b.tolerance_dps)[0].type,
      seconds_at_double_tolerance: rec.total > 0 ? round(pool / rec.total, 1) : null },
    assumptions: ['Taken multiplier = 1 - resistance (physical DoT: armour does not apply); other less/reduced damage taken ignored, PoB DotEHP shown for comparison.',
      'Recoup is excluded (hits only); flasks and Guard skills excluded.',
      'seconds_at_double_tolerance: time to lose the whole pool when the degen is twice the tolerance (net loss = recovery).'] };
}

// ---------- One block for an encounter row ----------
export function approximateModels({ output, explodeMods = [], kind = 'hit', life = null, targets = {}, enemyResists, thorns = null }) {
  const o = output ?? {};
  const models = [recoupSustain(o, { kind }), onKillExplosions(explodeMods, { life, targets, enemyResists }), thornsRetaliation(o, thorns), degenTolerance(o)];
  return { disclaimer, applicable: models.filter(m => m.applicable).map(m => m.id), models };
}

// Enemy resistances an encounter imposes: explicit Config values win over the enemyIsBoss placeholder.
export function enemyResistsOf(config = {}, bossKind = 'None') {
  const d = { ...(defaultEnemyResists[bossKind] ?? defaultEnemyResists.None) };
  for (const t of ['Fire', 'Cold', 'Lightning', 'Chaos']) if (num(config[`enemy${t}Resist`]) != null) d[t] = config[`enemy${t}Resist`];
  return d;
}
