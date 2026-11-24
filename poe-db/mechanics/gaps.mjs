// WP9: registry of mechanics that the pinned PoB (2.68.1) does not calculate or calculates only partially.
// Data, not a calculation. Every danger axis of scenarios/enemies.json must belong to exactly one entry (tested).
// pob_status:
//   not_modelled   - PoB has no calculation for it
//   partial        - PoB calculates a part (see pob_does), the rest is outside the numbers
//   config_assumed - PoB applies the effect only when a Config flag says so; source and uptime are not checked
// model: id of an approximate model in scripts/mechanic-models.mjs (output kept apart from PoB numbers), or null.
// checks: rule ids of scripts/mechanic-validate.mjs that test preconditions/conflicts of the mechanic.
// sources: ids from mechanics/sources.json (pinned PoB files) or entries of externalReferences below.

export const externalReferences = {
  'wiki.recoup': { kind: 'community_wiki', url: 'https://www.poewiki.net/wiki/Recoup', note: 'Reference link, not fetched into the project; claims taken from PoB code where possible.' },
  'wiki.explode': { kind: 'community_wiki', url: 'https://www.poewiki.net/wiki/Explode', note: 'Reference link, not fetched; on-kill explosion interaction with player modifiers and resistances is unverified here.' },
  'wiki.thorns': { kind: 'community_wiki', url: 'https://www.poewiki.net/wiki/Thorns', note: 'Reference link, not fetched; which player hits trigger monster thorns is unverified here.' },
  'wiki.ground': { kind: 'community_wiki', url: 'https://www.poewiki.net/wiki/Ground_effect', note: 'Reference link, not fetched.' },
  'project.enemy-db': { kind: 'local_data', url: 'local:poe-db/scenarios/enemies.json', note: 'Map mod texts, danger axes and engine method per tier (RePoE 3.30.0.4 + PoB map affixes).' }
};

const g = (id, title, pob_status, axes, pob_does, gap, { model = null, checks = [], cards = [], sources = [], observe = null } = {}) =>
  ({ id, title, pob_status, axes, pob_does, gap, model, checks, cards, sources, observe });

export const gaps = [
  g('recoup', 'Recoup (life/ES/mana returned over 3-4 s)', 'partial', [],
    'CalcDefence: LifeRecoup/EnergyShieldRecoup/ManaRecoup % (with recovery rate), recoup inside the multi-hit EHP simulation (LifeRecoupRecoveryAvg/Max). Hits only: DamageOverTime category is excluded.',
    'Not part of sustained recovery (regen/leech) used for degen and the sustain verdict; no steady-state recovery under a stream of hits; the 3-4 s delay versus burst is not shown.',
    { model: 'recoup_sustain', checks: ['ci_life_recovery'], cards: ['recoup-delay', 'recovery'], sources: ['pob.calc-defence', 'wiki.recoup'], observe: 'Life graph under steady map damage with and without the recoup source.' }),
  g('on_kill_explosions', 'On-kill monster explosions (Profane Bloom, item mods)', 'partial', [],
    'CalcSetup adds an "On Kill Monster Explosion" group from ExplodeMod; its damage uses monsterLifeTable[enemy level] (generic monster life).',
    'Per kill, not per second: no chain reaction, no pack density, no comparison with the life of the surrounding monsters; the condition (enemy cursed) is assumed met.',
    { model: 'on_kill_explosions', checks: ['profane_bloom_curse'], cards: ['curse-limit', 'uptime'], sources: ['pob.calc-setup', 'pob.calc-offence', 'wiki.explode', 'project.enemy-db'], observe: 'Share of white packs cleared by chain explosions in a T17 map.' }),
  g('monster_thorns', 'Monster thorns (Punishing / Mirrored map mods)', 'not_modelled', ['reflect_physical', 'reflect_elemental'],
    'Outputs <Type>TakenReflect multipliers (player reflect damage taken).',
    'No thorns damage per trigger, no trigger rule (which hits), no death check against the pool.',
    { model: 'thorns_retaliation', checks: [], cards: ['damage-taken-as'], sources: ['pob.calc-defence', 'wiki.thorns', 'project.enemy-db'], observe: 'Hit a rare with the thorns mod and record the damage taken per hit.' }),
  g('ground_degen', 'Ground effects and hazards (burning/caustic/desecrated ground, map hazards)', 'not_modelled', ['ground_degen', 'ground_effect', 'hazards'],
    'DoT EHP per type (<Type>DotEHP) and recovery are calculated; no ground damage source exists.',
    'Ground degen per second, standing time and avoidance by movement are unknown.',
    { model: 'degen_tolerance', checks: [], cards: ['recovery', 'defense-metrics'], sources: ['pob.calc-defence', 'wiki.ground', 'project.enemy-db'], observe: 'Seconds standing in T17 burning ground before life drops below 50%.' }),
  g('shocked_ground', 'Shocked ground (more damage taken)', 'config_assumed', ['ground_shock'],
    'Player shock can be forced in Config; the encounter does not set it.',
    'Uptime of standing on shocked ground and the shock magnitude are not modelled.',
    { cards: ['ailments', 'enemy-config'], sources: ['pob.config', 'project.enemy-db'] }),
  g('ailments_on_player', 'Ailments and debuffs on the player (freeze, chill, shock, impale, blind, maim, hinder, marks)', 'partial', ['ailments_on_player', 'impale_on_player', 'blind_on_player', 'maim_on_player', 'hinder_on_player', 'marks_on_player'],
    'Avoid chances and immunities (IgniteAvoidChance, FreezeAvoidChance, ...) are calculated.',
    'Application rate, duration on the player and the resulting damage/speed loss are not in hits-to-die or EHP.',
    { cards: ['ailments', 'enemy-debuffs'], sources: ['pob.calc-defence', 'project.enemy-db'] }),
  g('poison_wither_on_player', 'Poison stacks and wither on the player', 'not_modelled', ['poison_on_player', 'wither_on_player'],
    'Poison avoid chance; chaos resist and chaos DoT EHP.',
    'Stack count, duration and stacked chaos DoT per second are not calculated.',
    { cards: ['ailments', 'enemy-debuffs'], sources: ['pob.calc-defence', 'project.enemy-db'] }),
  g('regeneration_restrictions', 'Regeneration restrictions (no regeneration map mods)', 'partial', ['no_regeneration'],
    'Recovery outputs per source; the map mod is translated only where PoB has a matching mod.',
    'Effect on sustain is judged by the share of regeneration in total recovery (build_checks), not recalculated.',
    { model: 'degen_tolerance', cards: ['recovery'], sources: ['pob.calc-defence', 'project.enemy-db'] }),
  g('flask_effects', 'Flask uptime and flask-punishing mods', 'config_assumed', ['flask_charges', 'flask_use_punished', 'flask_effect'],
    'Flask effects apply when the flask is active in Config.',
    'Charge balance, manual pressing and uptime in a real fight are not checked.',
    { checks: ['config_charge_sources'], cards: ['flask-charge-sustain', 'uptime'], sources: ['pob.config'] }),
  g('charges_and_buffs', 'Charges, buffs and their theft or duration loss', 'config_assumed', ['charges_stolen', 'buff_duration', 'no_exposure'],
    'Charges at maximum or override when use*Charges is set; buff effects from Config flags.',
    'Generation and uptime of charges/buffs are not checked; theft and reduced duration are not simulated.',
    { checks: ['config_charge_sources'], cards: ['charges', 'uptime', 'exposure-selection'], sources: ['pob.calc-perform', 'pob.config'] }),
  g('enemy_density_and_clear', 'Pack density, extra enemies, enemy area/projectiles, clear speed', 'not_modelled', ['more_rares', 'extra_enemies', 'rare_modifiers', 'enemy_area', 'extra_projectiles', 'enemy_movement'],
    'Single-target numbers against one configured enemy.',
    'Number of monsters, overlap of damage, overkill, movement and clear speed are outside the model.',
    { cards: ['projectile-behaviour', 'enemy-config'], sources: ['project.enemy-db'] }),
  g('enemy_buffs_and_regen', 'Enemy charges, regeneration, unslowable, auras, debuff duration on enemies', 'partial', ['enemy_charges', 'enemy_regeneration', 'enemy_unslowable', 'auras_help_enemies', 'debuff_duration_on_enemies'],
    'Numeric enemy mods are translated where PoB has a matching mod (see analyze mapmods --method).',
    'Charge uptime on monsters, regeneration against DoT ramp and shortened debuffs are not simulated.',
    { cards: ['enemy-config', 'damage-ramp-duration'], sources: ['project.enemy-db'] }),
  g('on_death_effects', 'Monster on-death effects (volatile, on-death explosions, degen clouds)', 'not_modelled', ['on_death_effects'],
    'Nothing.',
    'Damage from dying monsters around the player is not calculated.',
    { cards: ['defense-metrics'], sources: ['project.enemy-db'] }),
  g('boss_special_mechanics', 'Possessed bosses, shrines, grasping vines and other special map mechanics', 'not_modelled', ['boss_possessed', 'boss_shrine', 'grasping_vines'],
    'Nothing beyond the generic boss configuration.',
    'Mechanic-specific damage or movement restriction is not modelled.',
    { cards: ['enemy-config'], sources: ['project.enemy-db'] }),
  g('dot_ramp_uptime', 'DoT ramp, stacking and placement uptime (Vortex, ignite stacks, ground DoT)', 'partial', [],
    'Sustained DPS at full stacks/uptime as configured.',
    'Time to reach full stacks and losses from enemy movement/phases are not in DPS.',
    { cards: ['damage-ramp-duration', 'uptime'], sources: ['pob.calc-offence'] }),
  g('curse_application', 'Curse application and the curse limit', 'partial', [],
    'Applies curses from enabled skills up to the curse limit (EnemyCurseLimit).',
    'Application in a real fight (aura radius, hit to apply, re-application on bosses) is assumed.',
    { checks: ['curse_limit', 'blasphemy_hex'], cards: ['curse-limit'], sources: ['pob.calc-perform'] }),
  g('trigger_rates', 'Trigger rates (cast when damage taken, cast on crit, guard skills, on-kill triggers)', 'partial', [],
    'CalcTriggers computes trigger rates from configured rates and cooldowns.',
    'Real incoming damage frequency and kill rate are assumptions.',
    { cards: ['uptime', 'guard-uptime'], sources: ['pob.calc-triggers'] }),
  g('minion_behaviour', 'Minion AI, pathing and survival', 'not_modelled', [],
    'Minion damage and defences as if always attacking the target.',
    'Time spent travelling, deaths and resummons are outside DPS.',
    { cards: ['minions-totems-traps', 'minion-count-sustain'], sources: ['pob.calc-offence'] }),
  g('corpse_availability', 'Corpse availability for corpse skills', 'not_modelled', [],
    'Corpse explosion damage from configured corpse life.',
    'Whether corpses exist (boss fights, first pack) is not checked.',
    { checks: ['corpse_source'], cards: ['uptime'], sources: ['pob.calc-offence'] }),
  g('mana_sustain_cadence', 'Mana sustain with recast cadence and burst costs', 'partial', [],
    'Mana cost per use, regeneration and leech per second.',
    'Recast cadence of several skills and spending bursts are not combined into one sustain check.',
    { cards: ['resource-sustain'], sources: ['pob.calc-offence', 'pob.calc-defence'] }),
  g('monster_variety_life', 'Monster variety life multiplier', 'partial', [],
    'Generic monster life per level (monsterLifeTable) and rarity multiplier.',
    'Variety multiplier (some monsters have much more life) is assumed 1; time to kill and explosion damage scale with it.',
    { cards: ['enemy-config'], sources: ['pob.data-misc', 'project.enemy-db'] }),
  g('movement_avoidance', 'Avoiding telegraphed skills by movement', 'not_modelled', [],
    'Every configured enemy hit lands.',
    'Dodging, positioning and boss telegraphs are outside the numbers (survival is pessimistic for avoidable skills).',
    { cards: ['defense-metrics'], sources: ['pob.calc-defence'] })
];

export function gapById(id) { return gaps.find(x => x.id === id) ?? null; }
