// WP9: executable preconditions/conflicts from mechanic cards, for build prototypes (WP5 generator) and saved builds.
// Pure and offline: works on a small prototype spec, or on `pob inspect` output (+ optional `pob run` result).
//
// Prototype spec (all fields optional; a missing field makes dependent rules return "unknown", never "pass"):
// { ascendancy: 'Occultist', ascendancy_nodes: ['Profane Bloom', ...], keystones: ['Mind Over Matter', ...],
//   skills: [{ label, enabled: true, gems: ['Blasphemy', 'Frostbite'] }], items: ['Viscera ...'],
//   recovery: ['life_recoup', 'life_leech', ...], config: { usePowerCharges: true }, curse_limit: 1,
//   explode_sources: ['Profane Bloom'], charge_sources: ['Cold Snap of Power'] }
//
// Statuses: pass | fail (mechanically impossible or the effect never happens) | warn (likely wrong, needs a source)
// | unknown (not enough data) | not_applicable.

// Curse gems of 3.30 (hexes and marks). Marks are curses but cannot be supported by Blasphemy (hex-only aura curse).
export const hexes = ['Frostbite', 'Flammability', 'Conductivity', 'Vulnerability', 'Despair', 'Elemental Weakness', 'Enfeeble', 'Temporal Chains', 'Punishment'];
export const marks = ["Assassin's Mark", "Poacher's Mark", "Warlord's Mark", "Sniper's Mark"];
const curseAppliers = ['Blasphemy', 'Hextouch', 'Curse On Hit', 'Bane', 'Impending Doom'];
const corpseSkills = ['Detonate Dead', 'Volatile Dead', 'Corpse Pact', 'Cremation', 'Unearth', 'Desecrate', 'Dark Pact', 'Bodyswap'];
const corpseMakers = ['Desecrate', 'Unearth', 'Cremation'];
// Gems/supports that generate power charges in a common way; tree and item sources are not listed (rule says unknown).
const powerChargeGems = /of Power|Assassin's Mark|Power Charge On Critical|Charged Traps|Kinetic Instability|Inspiration/i;
const frenzyChargeGems = /Frenzy|Poacher's Mark|Blood Rage|Chain Hook/i;
const enduranceChargeGems = /Enduring Cry|Endurance Charge on Melee Stun|Warlord's Mark|Ancestral Warchief|Infernal Cry|Seismic Cry/i;

const baseName = n => String(n ?? '').replace(/ of (Power|Ruin|Siphoning|Ire|Conflux|Fission|Expulsion|Instability|Dirt|Penetration|Storms|Transference|Weaponry)$/i, '').trim();
const isCurse = n => hexes.includes(baseName(n)) || marks.includes(baseName(n));
const enabledGroups = spec => (spec.skills ?? []).filter(s => s.enabled !== false && s.enabled !== 'false');
const lower = list => (list ?? []).map(x => String(x).toLowerCase());

const result = (id, card, gap, status, evidence) => ({ id, card, gap, status, evidence });

export const rules = {
  // Profane Bloom: cursed enemies killed explode. No curse source = no explosions (PoB keeps the explosion group anyway).
  profane_bloom_curse(spec) {
    const nodes = lower(spec.ascendancy_nodes), explode = lower(spec.explode_sources);
    const has = nodes.includes('profane bloom') || explode.includes('profane bloom');
    if (!has) return result('profane_bloom_curse', 'curse-limit', 'on_kill_explosions', spec.ascendancy_nodes || spec.explode_sources ? 'not_applicable' : 'unknown', 'Profane Bloom not in ascendancy_nodes/explode_sources.');
    if (!spec.skills) return result('profane_bloom_curse', 'curse-limit', 'on_kill_explosions', 'unknown', 'No skills in the prototype.');
    const curses = enabledGroups(spec).flatMap(g => g.gems ?? []).filter(isCurse);
    const fromItems = lower(spec.items).some(i => /curse enemies|hextouch|curse on hit/.test(i));
    if (curses.length) return result('profane_bloom_curse', 'curse-limit', 'on_kill_explosions', 'pass', `Curse source: ${[...new Set(curses)].join(', ')}.`);
    return result('profane_bloom_curse', 'curse-limit', 'on_kill_explosions', fromItems ? 'warn' : 'fail', fromItems ? 'No curse gem; an item may curse - verify.' : 'Profane Bloom without any curse: explosions never happen (PoB still lists the group).');
  },
  // More distinct curses than the curse limit: only `limit` apply at once.
  curse_limit(spec) {
    if (!spec.skills) return result('curse_limit', 'curse-limit', 'curse_application', 'unknown', 'No skills in the prototype.');
    const curses = [...new Set(enabledGroups(spec).flatMap(g => g.gems ?? []).filter(isCurse).map(baseName))];
    const limit = Number.isInteger(spec.curse_limit) ? spec.curse_limit : 1;
    if (!curses.length) return result('curse_limit', 'curse-limit', 'curse_application', 'not_applicable', 'No curse gems.');
    if (curses.length <= limit) return result('curse_limit', 'curse-limit', 'curse_application', 'pass', `${curses.length} curse(s) within limit ${limit}${spec.curse_limit == null ? ' (default 1; tree/items may raise it)' : ''}.`);
    return result('curse_limit', 'curse-limit', 'curse_application', spec.curse_limit == null ? 'warn' : 'fail', `${curses.length} curses (${curses.join(', ')}) over limit ${limit}${spec.curse_limit == null ? ' (default; pass curse_limit or PoB EnemyCurseLimit)' : ''}.`);
  },
  // Blasphemy needs a hex in its group and cannot support marks.
  blasphemy_hex(spec) {
    if (!spec.skills) return result('blasphemy_hex', 'curse-limit', 'curse_application', 'unknown', 'No skills in the prototype.');
    const groups = enabledGroups(spec).filter(g => (g.gems ?? []).some(n => baseName(n) === 'Blasphemy'));
    if (!groups.length) return result('blasphemy_hex', 'curse-limit', 'curse_application', 'not_applicable', 'No Blasphemy.');
    const bad = groups.filter(g => !(g.gems ?? []).some(n => hexes.includes(baseName(n))));
    const markGroups = groups.filter(g => (g.gems ?? []).some(n => marks.includes(baseName(n))));
    if (bad.length) return result('blasphemy_hex', 'curse-limit', 'curse_application', 'fail', `Blasphemy without a hex in group(s): ${bad.map(g => g.label ?? '?').join(', ')}${markGroups.length ? ' (marks cannot be supported by Blasphemy)' : ''}.`);
    return result('blasphemy_hex', 'curse-limit', 'curse_application', markGroups.length ? 'warn' : 'pass', markGroups.length ? 'Mark linked to Blasphemy is not supported by it.' : 'Blasphemy links a hex.');
  },
  // Chaos Inoculation sets life to 1: life recoup/leech/regeneration plans give nothing.
  ci_life_recovery(spec) {
    const ks = lower(spec.keystones);
    if (!spec.keystones) return result('ci_life_recovery', 'low-life-ci-hybrid', 'recoup', 'unknown', 'No keystones in the prototype.');
    if (!ks.includes('chaos inoculation')) return result('ci_life_recovery', 'low-life-ci-hybrid', 'recoup', 'not_applicable', 'No Chaos Inoculation.');
    const life = lower(spec.recovery).filter(r => r.startsWith('life_'));
    return life.length ? result('ci_life_recovery', 'low-life-ci-hybrid', 'recoup', 'fail', `Chaos Inoculation (Life = 1) with life recovery: ${life.join(', ')}.`)
      : result('ci_life_recovery', 'low-life-ci-hybrid', 'recoup', 'pass', 'No life-based recovery with CI.');
  },
  // Eldritch Battery + Mind Over Matter: ES protects mana, and mana both pays skills and takes MoM damage.
  eb_mom_shared_pool(spec) {
    const ks = lower(spec.keystones);
    if (!spec.keystones) return result('eb_mom_shared_pool', 'eldritch-battery-mom', null, 'unknown', 'No keystones in the prototype.');
    if (!(ks.includes('eldritch battery') && ks.includes('mind over matter'))) return result('eb_mom_shared_pool', 'eldritch-battery-mom', null, 'not_applicable', 'Not both Eldritch Battery and Mind Over Matter.');
    return result('eb_mom_shared_pool', 'eldritch-battery-mom', null, 'warn', 'Eldritch Battery + Mind Over Matter: one ES/mana pool pays skills and absorbs damage; check sustain under continuous casting and hits.');
  },
  // Corpse skills need corpses: boss fights and the first pack have none without a corpse maker.
  corpse_source(spec) {
    if (!spec.skills) return result('corpse_source', 'uptime', 'corpse_availability', 'unknown', 'No skills in the prototype.');
    const gems = enabledGroups(spec).flatMap(g => g.gems ?? []).map(baseName);
    const users = gems.filter(n => corpseSkills.includes(n) && !corpseMakers.includes(n));
    if (!users.length) return result('corpse_source', 'uptime', 'corpse_availability', 'not_applicable', 'No corpse-consuming skill.');
    const makers = gems.filter(n => corpseMakers.includes(n));
    return makers.length ? result('corpse_source', 'uptime', 'corpse_availability', 'pass', `Corpse maker: ${makers.join(', ')}.`)
      : result('corpse_source', 'uptime', 'corpse_availability', 'warn', `${[...new Set(users)].join(', ')} without Desecrate/Unearth: no corpses at bosses or the first pack.`);
  },
  // Ascendancy points: 8 in total, a Bloodline spends the same budget.
  ascendancy_budget(spec) {
    if (!spec.ascendancy_nodes && spec.ascendancy_points == null) return result('ascendancy_budget', 'ascendancy-budget', null, 'unknown', 'No ascendancy_nodes in the prototype.');
    const n = spec.ascendancy_points ?? spec.ascendancy_nodes.length;
    return n <= 8 ? result('ascendancy_budget', 'ascendancy-budget', null, 'pass', `${n} of 8 ascendancy points${spec.ascendancy_points == null ? ' (counted as nodes; small nodes and paths may cost more)' : ''}.`)
      : result('ascendancy_budget', 'ascendancy-budget', null, 'fail', `${n} ascendancy points exceed 8 (Bloodline included in the same budget).`);
  },
  // Config charges at maximum need a generator (card charges/uptime).
  config_charge_sources(spec) {
    const c = spec.config ?? null;
    if (!c) return result('config_charge_sources', 'charges', 'charges_and_buffs', 'unknown', 'No config in the prototype.');
    const gems = enabledGroups(spec).flatMap(g => g.gems ?? []).concat(spec.charge_sources ?? []);
    const missing = [['usePowerCharges', powerChargeGems, 'power'], ['useFrenzyCharges', frenzyChargeGems, 'frenzy'], ['useEnduranceCharges', enduranceChargeGems, 'endurance']]
      .filter(([flag, re]) => c[flag] && !gems.some(n => re.test(n))).map(([, , k]) => k);
    const used = ['usePowerCharges', 'useFrenzyCharges', 'useEnduranceCharges'].filter(f => c[f]);
    if (!used.length) return result('config_charge_sources', 'charges', 'charges_and_buffs', 'not_applicable', 'No charges enabled in config.');
    return missing.length ? result('config_charge_sources', 'charges', 'charges_and_buffs', 'warn', `Config uses ${missing.join(', ')} charges without a gem source; tree/items may provide one (pass charge_sources).`)
      : result('config_charge_sources', 'charges', 'charges_and_buffs', 'pass', 'Every enabled charge type has a gem source.');
  }
};

export function validatePrototype(spec, { only = null } = {}) {
  const ids = only ?? Object.keys(rules);
  const checks = ids.map(id => { if (!rules[id]) throw new Error(`Unknown validator rule: ${id}. Known: ${Object.keys(rules).join(', ')}`); return rules[id](spec ?? {}); });
  const count = s => checks.filter(c => c.status === s).length;
  return { valid: count('fail') === 0, counts: { fail: count('fail'), warn: count('warn'), unknown: count('unknown'), pass: count('pass'), not_applicable: count('not_applicable') }, checks,
    note: 'Rule checks from mechanic cards (WP9); "unknown" means the prototype lacks the field, not that the mechanic is fine.' };
}

// Spec from `pob inspect` output (+ optional `pob run` result for explode sources and keystones of the calculation).
export function specFromInspect(inspect, run = null) {
  const skills = (inspect.skills ?? []).filter(s => s.label !== 'On Kill Monster Explosion')
    .map(s => ({ label: s.label, enabled: s.enabled !== 'false', gems: (s.gems ?? []).filter(g => g.enabled !== 'false' && g.name).map(g => g.name) }));
  const spec = { ascendancy: inspect.ascendancy ?? null, skills, config: inspect.config ?? {} };
  if (!run) return spec;
  const o = run.output ?? {};
  spec.explode_sources = (run.explode_mods ?? []).map(m => m.source_name).filter(Boolean);
  if (Array.isArray(run.equipped_items)) spec.items = run.equipped_items.map(i => [i.name, i.base].filter(Boolean).join(' '));
  if (Number.isFinite(run.budget?.ascendancy_used)) spec.ascendancy_points = run.budget.ascendancy_used;
  if (Number.isFinite(o.EnemyCurseLimit)) spec.curse_limit = o.EnemyCurseLimit;
  spec.recovery = [['life_recoup', o.LifeRecoup], ['life_leech', o.LifeLeechGainRate], ['life_regen', o.LifeRegenRecovery], ['es_recoup', o.EnergyShieldRecoup]]
    .filter(([, v]) => v > 0).map(([k]) => k);
  return spec;
}
