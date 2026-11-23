// Enemy database for survival/damage analysis: monster baselines per level, enemy archetypes, map tiers and the
// map modifier catalogue (RePoE 3.30 area mods merged with what pinned PoB can apply), plus named bosses from
// scenarios/bosses.json. Built offline from local caches; no engine call. Values are data with provenance, and
// each map modifier states how (or whether) the engine models it.
import fs from 'node:fs';
import path from 'node:path';
import { dbRoot, readJson, atomicJson, hashFile } from './workspace.mjs';

export const enemyFile = path.join(dbRoot, 'scenarios/enemies.json');
const rel = f => path.relative(dbRoot, f).replaceAll('\\', '/');

// ---------- PoB data parsing (data-only tables; no Lua execution) ----------
export function luaNumberTable(text, name) {
  const start = text.indexOf(`${name} = {`);
  if (start < 0) throw new Error(`PoB table not found: ${name}`);
  const body = text.slice(text.indexOf('{', start) + 1, text.indexOf('}', start));
  const out = {};
  let index = 1;
  for (const part of body.split(',').map(s => s.trim()).filter(Boolean)) {
    const keyed = part.match(/^\[(\d+)\]\s*=\s*([-0-9.]+)$/);
    if (keyed) out[Number(keyed[1])] = Number(keyed[2]);
    else out[index++] = Number(part);
  }
  return out;
}

function luaStringTable(text, name) {
  const start = text.indexOf(`${name} = {`);
  if (start < 0) throw new Error(`PoB table not found: ${name}`);
  const end = text.indexOf('\n}', start);
  const out = {};
  for (const m of text.slice(start, end).matchAll(/\["([^"]+)"\]\s*=\s*([-0-9.]+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

// PoB map affixes (Data/ModMap.lua): key, kind and the per-tier values PoB applies (LOW/MED/HIGH).
export function parsePobMapAffixes(text) {
  const affixes = {};
  const re = /\t\t\["([^"]+)"\] = \{\s*\n\t\t\ttype = "(\w+)",([\s\S]*?)\n\t\t\},?\n/g;
  let m;
  while ((m = re.exec(text))) {
    const [, key, type, body] = m;
    const values = body.match(/values = (\{[^\n]*\}),?\n/)?.[1] ?? null;
    const mods = [...body.matchAll(/^(?!\s*--).*?(enemyModList|modList):NewMod\("([\w:]+)", "(\w+)"/gm)].map(x => ({ side: x[1] === 'modList' ? 'player' : 'enemy', name: x[2], type: x[3] }));
    affixes[key] = { key, type, values_lua: values, pob_mods: mods, has_effect: mods.length > 0 };
  }
  const list = section => [...(text.match(new RegExp(`\\t${section} = \\{([\\s\\S]*?)\\n\\t\\},`))?.[1] ?? '').matchAll(/val = "([^"]+)"/g)].map(x => x[1]).filter(v => v !== 'NONE');
  return { affixes, prefixes: list('Prefix'), suffixes: list('Suffix') };
}

// ---------- Map tiers ----------
export const mapTierBands = {
  white: { tiers: [1, 5], pob_tier: 'LOW', repoe_tag: 'low_tier_map' },
  yellow: { tiers: [6, 10], pob_tier: 'MED', repoe_tag: 'mid_tier_map' },
  red: { tiers: [11, 16], pob_tier: 'HIGH', repoe_tag: 'top_tier_map' },
  t17: { tiers: [17, 17], pob_tier: null, repoe_tag: 'uber_tier_map' }
};
export function bandOfTier(tier) {
  if (!Number.isInteger(tier) || tier < 1 || tier > 17) throw new Error('Map tier must be an integer 1-17');
  return Object.entries(mapTierBands).find(([, b]) => tier >= b.tiers[0] && tier <= b.tiers[1])[0];
}
// Area level = 67 + tier (T1 = 68, T16 = 83, T17 = 84); T17 matches world_areas (Citadel, Fortress, Sanctuary...).
export const areaLevelOfTier = tier => 67 + tier;

// ---------- Map modifier translation (stats PoB has no map affix for, and all T17 mods) ----------
const ignoredStat = /drop|pack_size|item_found|rarity|quantity|currency|maps_found|threads|experience|dummy_stat|extra_content_weighting|atlas|scarab/;
const pick = s => (Math.abs(s.min) >= Math.abs(s.max) ? s.min : s.max); // worst case = largest magnitude (PoB also uses the max roll)
const en = (name, type, value, extra = {}) => ({ name, type, value, ...extra });
const curse = gem => v => ({ custom_mods: [`You are cursed with Level ${v} ${gem}`], notes: [`Map curse at level ${v} (RePoE value); PoB applies its self-curse rules.`] });
// Handler: value -> { enemy_mods, custom_mods, pen, notes } ; or a string axis = not modelled (danger axis for build checks).
export const statHandlers = {
  'map_monsters_damage_+%': v => ({ enemy_mods: [en('Damage', 'INC', v)] }),
  'map_boss_damage_+%': v => ({ enemy_mods: [en('Damage', 'INC', v, { condition: 'RareOrUnique' })], notes: ['PoB convention: Unique Boss mods apply to Rare/Unique enemies.'] }),
  'map_monsters_%_physical_damage_to_add_as_fire': v => ({ enemy_mods: [en('PhysicalDamageGainAsFire', 'BASE', v)] }),
  'map_monsters_%_physical_damage_to_add_as_cold': v => ({ enemy_mods: [en('PhysicalDamageGainAsCold', 'BASE', v)] }),
  'map_monsters_%_physical_damage_to_add_as_lightning': v => ({ enemy_mods: [en('PhysicalDamageGainAsLightning', 'BASE', v)] }),
  'map_monsters_%_physical_damage_to_add_as_chaos': v => ({ enemy_mods: [en('PhysicalDamageGainAsChaos', 'BASE', v)] }),
  'map_monsters_physical_damage_%_to_add_as_random_element': v => ({ approximate: true,
    enemy_mods: ['Fire', 'Cold', 'Lightning'].map(e => en(`PhysicalDamageGainAs${e}`, 'BASE', Math.round(v / 3 * 100) / 100)),
    notes: [`Random element per monster: modelled as the expected split ${Math.round(v / 3)}% to each element. A single monster deals all ${v}% as one element, so the worst element is heavier than shown.`] }),
  'map_monsters_critical_strike_chance_+%': v => ({ enemy_mods: [en('CritChance', 'INC', v)] }),
  'map_monsters_critical_strike_multiplier_+': v => ({ enemy_mods: [en('CritMultiplier', 'BASE', v)] }),
  'map_monsters_penetrate_elemental_resistances_%': v => ({ pen: { Fire: v, Cold: v, Lightning: v } }),
  'map_monsters_attack_speed_+%': v => ({ enemy_mods: [en('Speed', 'INC', v)], speed: v }),
  'map_monsters_cast_speed_+%': v => ({ speed: v }),
  'map_boss_attack_and_cast_speed_+%': v => ({ enemy_mods: [en('Speed', 'INC', v, { condition: 'RareOrUnique' })] }),
  'map_monsters_additional_physical_damage_reduction': v => ({ enemy_mods: [en('PhysicalDamageReduction', 'BASE', v)] }),
  'map_monsters_additional_elemental_resistance': v => ({ enemy_mods: [en('ElementalResist', 'BASE', v)] }),
  'map_monsters_additional_chaos_resistance': v => ({ enemy_mods: [en('ChaosResist', 'BASE', v)] }),
  'map_monsters_life_+%': v => ({ enemy_mods: [en('Life', 'MORE', v)], notes: ['PoB models monster life map mods as MORE.'] }),
  'map_boss_maximum_life_+%': v => ({ enemy_mods: [en('Life', 'MORE', v, { condition: 'RareOrUnique' })] }),
  'map_monsters_maximum_life_%_to_add_to_maximum_energy_shield': v => ({ enemy_mods: [en('LifeGainAsEnergyShield', 'BASE', v)] }),
  'map_monsters_spell_suppression_chance_%': v => ({ enemy_mods: [en('SpellSuppressionChance', 'BASE', v)] }),
  'map_monsters_base_block_%': v => ({ enemy_mods: [en('BlockChance', 'BASE', v)] }),
  'map_monsters_base_self_critical_strike_multiplier_-%': v => ({ enemy_mods: [en('SelfCritMultiplier', 'INC', -v)] }),
  'map_monsters_curse_effect_on_self_+%_final': v => ({ enemy_mods: [en('CurseEffectOnSelf', 'MORE', v)] }),
  map_monsters_are_hexproof: () => ({ enemy_mods: [en('Hexproof', 'FLAG', true)] }),
  map_monsters_cannot_be_leeched_from: () => ({ enemy_mods: ['Life', 'Mana', 'EnergyShield'].map(r => en(`CannotLeech${r}FromSelf`, 'FLAG', true)) }),
  'map_monsters_avoid_elemental_ailments_%': v => ({ enemy_mods: [en('AvoidElementalAilments', 'BASE', v)] }),
  'map_monsters_avoid_poison_bleed_impale_%': v => ({ enemy_mods: ['AvoidPoison', 'AvoidImpale', 'AvoidBleed'].map(n => en(n, 'BASE', v)) }),
  map_monsters_cannot_be_stunned: () => ({ enemy_mods: [en('AvoidStun', 'BASE', 100)] }),
  'map_monsters_accuracy_rating_+%': v => ({ enemy_mods: [en('Accuracy', 'INC', v)] }),
  'map_additional_player_maximum_resistances_%': v => ({ custom_mods: [`${v}% to all maximum Resistances`] }),
  'map_player_global_defences_+%': v => ({ custom_mods: [`${Math.abs(v)}% less Defences`] }),
  'map_players_skill_area_of_effect_+%_final': v => ({ custom_mods: [`${Math.abs(v)}% less Area of Effect`] }),
  'map_player_life_and_es_recovery_speed_+%_final': v => ({ custom_mods: [`${Math.abs(v)}% less Recovery Rate of Life and Energy Shield`] }),
  'map_player_maximum_leech_rate_+%': v => ({ custom_mods: [`${Math.abs(v)}% reduced Maximum total Life, Mana and Energy Shield Recovery per second from Leech`] }),
  'map_player_cooldown_speed_+%_final': v => ({ custom_mods: [`${Math.abs(v)}% less Cooldown Recovery Rate`] }),
  'map_player_accuracy_rating_+%_final': v => ({ custom_mods: [`${Math.abs(v)}% less Accuracy Rating`] }),
  'map_player_non_curse_aura_effect_+%': v => ({ custom_mods: [`${Math.abs(v)}% reduced effect of Non-Curse Auras from your Skills`] }),
  'map_players_spell_damage_%_suppressed': v => ({ custom_mods: [`${v}% to amount of Suppressed Spell Damage Prevented`] }),
  map_player_has_level_X_elemental_weakness: curse('Elemental Weakness'),
  map_player_has_level_X_vulnerability: curse('Vulnerability'),
  map_player_has_level_X_enfeeble: curse('Enfeeble'),
  map_player_has_level_X_temporal_chains: curse('Temporal Chains'),
  // Not modelled by the engine; the string is the danger axis used for build checks.
  map_rare_monsters_physical_thorns_for_x_damage: 'reflect_physical',
  map_rare_monsters_elemental_thorns_for_x_damage: 'reflect_elemental',
  map_players_no_regeneration_including_es: 'no_regeneration',
  'map_player_flask_effect_+%_final': 'flask_effect',
  'map_player_charges_gained_+%': 'flask_charges',
  'map_player_create_enemy_meteor_daemon_on_flask_use_%_chance': 'flask_use_punished',
  'map_player_buff_time_passed_+%_only_buff_category': 'buff_duration',
  'map_monster_debuff_time_passed_+%': 'debuff_duration_on_enemies',
  map_player_base_aura_skills_affecting_allies_also_affect_enemies: 'auras_help_enemies',
  map_player_cannot_expose: 'no_exposure',
  map_player_periodically_affected_by_random_marks: 'marks_on_player',
  map_monster_skills_chain_X_additional_times: 'extra_projectiles',
  map_monsters_additional_number_of_projecitles: 'extra_projectiles',
  'map_monster_projectile_chain_from_terrain_chance_%': 'extra_projectiles',
  'map_monsters_area_of_effect_+%': 'enemy_area',
  'map_boss_area_of_effect_+%': 'enemy_area',
  'map_monsters_movement_speed_+%': 'enemy_movement',
  map_monsters_movement_speed_cannot_be_reduced_below_base: 'enemy_unslowable',
  map_monster_movement_speed_cannot_be_reduced_below_base: 'enemy_unslowable',
  map_monster_action_speed_cannot_be_reduced_below_base: 'enemy_unslowable',
  map_monsters_cannot_be_taunted: 'enemy_unslowable',
  map_monsters_poison_on_hit: 'poison_on_player',
  'map_monsters_base_poison_duration_+%': 'poison_on_player',
  map_monsters_all_damage_can_poison: 'poison_on_player',
  map_monsters_always_ignite: 'ailments_on_player',
  'map_monsters_%_chance_to_inflict_status_ailments': 'ailments_on_player',
  map_monster_all_damage_can_ignite_freeze_shock: 'ailments_on_player',
  'map_monsters_chance_to_impale_%': 'impale_on_player',
  'map_monsters_withered_on_hit_for_2_seconds_%_chance': 'wither_on_player',
  'map_monsters_chance_to_blind_on_hit_%': 'blind_on_player',
  'map_monsters_maim_on_hit_%_chance': 'maim_on_player',
  'map_monsters_spells_chance_to_hinder_on_hit_%_chance': 'hinder_on_player',
  map_monsters_steal_charges: 'charges_stolen',
  'map_monsters_add_frenzy_charge_on_hit_%': 'enemy_charges',
  'map_monsters_add_endurance_charge_on_hit_%': 'enemy_charges',
  'map_monsters_add_power_charge_on_hit_%': 'enemy_charges',
  map_monster_maximum_power_charges: 'enemy_charges',
  map_monster_maximum_frenzy_charges: 'enemy_charges',
  map_monster_maximum_endurance_charges: 'enemy_charges',
  'map_monster_chance_to_gain_endurance_charge_when_hit_%': 'enemy_charges',
  map_monster_add_x_grasping_vines_on_hit: 'grasping_vines',
  map_base_ground_fire_damage_to_deal_per_10_seconds: 'ground_degen',
  map_base_ground_desecration_damage_to_deal_per_minute: 'ground_degen',
  map_ground_effect_patches_per_100_tiles: 'ground_effect',
  map_ground_effect_radius: 'ground_effect',
  map_ground_ice_base_magnitude: 'ground_effect',
  map_ground_lightning_base_magnitude: 'ground_shock',
  'map_ground_consecrated_life_regeneration_rate_per_minute_%': 'enemy_regeneration',
  map_boss_is_possessed: 'boss_possessed',
  map_unique_monsters_have_X_shrine_effects: 'boss_shrine',
  map_rare_monster_num_additional_modifiers: 'rare_modifiers',
  'map_number_of_rare_packs_+%': 'more_rares',
  map_rare_monsters_have_nemesis_mod: 'rare_modifiers',
  'map_rare_monster_volatile_on_death_%': 'on_death_effects',
  'map_rare_monster_fracture_on_death_chance_%': 'on_death_effects',
  map_rare_monsters_have_final_gasp: 'on_death_effects',
  'map_monster_elder_nova_on_death_%_chance': 'on_death_effects',
  map_uber_sawblades_ambush: 'hazards',
  map_uber_drowning_orb_ambush: 'hazards',
  map_contains_x_labyrinth_hazards: 'hazards',
  map_exarch_traps: 'hazards',
  map_supporter_maven_follower: 'hazards',
  map_packs_have_uber_tentacle_fiends: 'extra_enemies',
  map_rare_monsters_shaper_touched: 'extra_enemies',
  map_uber_map_additional_synthesis_boss: 'extra_enemies',
  map_spawn_two_bosses: 'extra_enemies'
};

// Stats that change monster pack composition or add league content: informational only.
const contentStat = /^map_(packs_|is_overrun|beyond_|contains_|spawn_affliction|azmeri|number_of_magic_packs|magic_pack_mod_rules|additional_number_of_packs)/;

export function translateStats(stats) {
  const out = { enemy_mods: [], custom_mods: [], pen: {}, notes: [], axes: [], content: [], unknown: [], approximate: false, speed: null };
  for (const s of stats) {
    if (ignoredStat.test(s.id)) continue;
    if (contentStat.test(s.id)) { out.content.push(s.id); continue; }
    const h = statHandlers[s.id];
    if (h === undefined) { out.unknown.push(s.id); continue; }
    if (typeof h === 'string') { if (!out.axes.includes(h)) out.axes.push(h); continue; }
    const r = h(pick(s));
    out.enemy_mods.push(...(r.enemy_mods ?? []));
    out.custom_mods.push(...(r.custom_mods ?? []));
    for (const [k, v] of Object.entries(r.pen ?? {})) out.pen[k] = (out.pen[k] ?? 0) + v;
    out.notes.push(...(r.notes ?? []));
    if (r.approximate) out.approximate = true;
    if (r.speed != null) out.speed = Math.max(out.speed ?? 0, r.speed);
  }
  // Fleet: PoB folds attack and cast speed into one Speed INC; keep the larger value once.
  const speedMods = out.enemy_mods.filter(m => m.name === 'Speed' && !m.condition);
  if (speedMods.length > 1) out.enemy_mods = out.enemy_mods.filter(m => !(m.name === 'Speed' && !m.condition)).concat([speedMods.sort((a, b) => b.value - a.value)[0]]);
  if (out.speed != null && !speedMods.length) out.enemy_mods.push(en('Speed', 'INC', out.speed));
  delete out.speed;
  return out;
}

const cleanText = text => text.split('\n').map(l => l.replace(/\[[^|\]]*\|([^\]]*)\]/g, '$1').replace(/\[([^\]]*)\]/g, '$1'))
  .filter(l => !/Atlas Drops|Rarity of Items found|Quantity of Items|Pack size|more Maps found|more Currency found|more Threads found|more Scarabs|Experience gain/i.test(l)).join('\n');
const slug = name => name.toLowerCase().replace(/^of (the )?/, '').replace(/'s\b/g, 's').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function engineFor({ band, pobAffix, stats }) {
  const translated = translateStats(stats);
  // Only affixes offered in PoB's Prefix/Suffix drop-downs can be selected; others are translated like T17 mods.
  const usePob = pobAffix?.selectable && band !== 't17';
  if (usePob) {
    if (!pobAffix.has_effect) return { method: 'not_modelled', reason: 'PoB lists this map mod but applies no calculation for it.', axes: translated.axes, content: translated.content };
    // PoB applies the affix itself; translated axes remain as build checks (PoB affix covers the numeric part only).
    return { method: 'pob_map_affix', pob_affix: pobAffix.key, pob_tier: mapTierBands[band].pob_tier, pob_roll: 'max of range (PoB passes rollRange 100)', axes: translated.axes, content: translated.content };
  }
  const modelled = translated.enemy_mods.length + translated.custom_mods.length + Object.keys(translated.pen).length;
  const method = !modelled ? (translated.axes.length || translated.unknown.length ? 'not_modelled' : 'no_combat_effect')
    : translated.axes.length || translated.unknown.length || translated.approximate ? 'partial' : 'translated';
  return { method, roll: 'largest magnitude of the range', enemy_mods: translated.enemy_mods, custom_mods: translated.custom_mods, pen: translated.pen,
    notes: translated.notes, axes: translated.axes, content: translated.content, unknown_stats: translated.unknown };
}

export function buildMapModCatalogue(mods, pob) {
  const groups = new Map();
  const tagToBand = Object.fromEntries(Object.entries(mapTierBands).map(([b, v]) => [v.repoe_tag, b]));
  for (const [id, x] of Object.entries(mods)) {
    if (x.domain !== 'area' || !['prefix', 'suffix'].includes(x.generation_type)) continue;
    const weights = x.spawn_weights.filter(w => w.weight > 0);
    const bands = [...new Set(weights.flatMap(w => w.tag === 'default' ? ['white', 'yellow', 'red'] : tagToBand[w.tag.trim()] ? [tagToBand[w.tag.trim()]] : []))];
    if (!bands.length) continue;
    const key = `${x.generation_type}:${x.name}`;
    if (!groups.has(key)) groups.set(key, { name: x.name, affix: x.generation_type, tiers: {} });
    const g = groups.get(key);
    for (const band of bands) {
      const t = g.tiers[band] ??= { repoe_ids: [], text: [], stats: [], required_level: x.required_level };
      t.repoe_ids.push(id);
      t.text.push(cleanText(x.text));
      t.stats.push(...x.stats.filter(s => !ignoredStat.test(s.id)));
    }
  }
  const catalogue = {};
  for (const g of groups.values()) {
    let id = slug(g.name);
    if (catalogue[id]) id = `${id}-${g.affix}`;
    const known = pob.affixes[g.name] ?? null;
    const pobAffix = known ? { ...known, selectable: pob.prefixes.includes(g.name) || pob.suffixes.includes(g.name) } : null;
    const tiers = {};
    for (const band of Object.keys(mapTierBands)) {
      const t = g.tiers[band];
      if (!t) continue;
      tiers[band] = { repoe_ids: t.repoe_ids, text: [...new Set(t.text)].join('\n'), stats: t.stats, engine: engineFor({ band, pobAffix, stats: t.stats }) };
    }
    const axes = [...new Set(Object.values(tiers).flatMap(t => t.engine.axes ?? []))];
    catalogue[id] = { id, name: g.name, affix: g.affix, pob_affix: pobAffix ? { key: pobAffix.key, type: pobAffix.type, values: pobAffix.values_lua, has_effect: pobAffix.has_effect, selectable: pobAffix.selectable, mods: pobAffix.pob_mods } : null,
      danger_axes: axes, tiers };
  }
  return catalogue;
}

// ---------- Archetypes ----------
// Rarity multipliers come from RePoE monster mods MonsterMagic/Rare/Unique (life_+%_final_from_rarity,
// rarity_damage_+%_final, rarity_attack_cast_speed_+%_and_damage_-%_final). PoB has no rarity scaling of its own.
function rarityFromRepoe(mods) {
  const stat = (id, s) => mods[id]?.stats?.find(x => x.id === s)?.max ?? null;
  const r = (prefix, speedId) => ({ life_more: stat(`${prefix}2`, 'monster_life_+%_final_from_rarity'), damage_more: stat(`${prefix}5`, 'monster_rarity_damage_+%_final'),
    speed_more_damage_less: stat(speedId, 'monster_rarity_attack_cast_speed_+%_and_damage_-%_final'), repoe_ids: [`${prefix}2`, `${prefix}5`, speedId] });
  return { normal: { life_more: 0, damage_more: 0, speed_more_damage_less: 0, repoe_ids: [] }, magic: r('MonsterMagic', 'MonsterMagic9'), rare: r('MonsterRare', 'MonsterRare9'), unique: r('MonsterUnique', 'MonsterUnique8') };
}

const rarityMods = (rarity, r) => {
  const x = r[rarity];
  if (!x || rarity === 'normal') return [];
  const list = [];
  if (x.life_more) list.push(en('Life', 'MORE', x.life_more, { source: `Monster rarity ${rarity}` }));
  if (x.damage_more) list.push(en('Damage', 'MORE', x.damage_more, { source: `Monster rarity ${rarity}` }));
  if (x.speed_more_damage_less) list.push(en('Damage', 'MORE', -x.speed_more_damage_less, { source: `Monster rarity ${rarity}` }), en('Speed', 'MORE', x.speed_more_damage_less, { source: `Monster rarity ${rarity}` }));
  return list;
};

export function buildArchetypes(rarity) {
  const pobBoss = { None: 'PoB "No": generic physical hit = monsterDamageTable[level] * 1.5; no resistances (level comes from the map tier here).',
    Boss: 'PoB "Standard Boss": each of Phys/Light/Cold/Fire = table * 1.5 * stdBossDPSMult, chaos = that / 2.5; 40% elemental / 25% chaos resistance; ailment threshold x488 more.',
    Pinnacle: 'PoB "Guardian/Pinnacle": table[84] * 1.5 * pinnacleBossDPSMult per type, 3% elemental penetration, 50/30 resistances, armour/evasion scaled by the boss mean.',
    Uber: 'PoB "Uber Pinnacle": table[85] * 1.5 * uberBossDPSMult per type, chaos / 4, 8% elemental penetration, 50/30 resistances and 70% less damage taken.' };
  const make = (id, label, enemyIsBoss, rarityKey, extra = {}) => ({ id, label, pob_enemy_is_boss: enemyIsBoss, pob_convention: pobBoss[enemyIsBoss], rarity: rarityKey,
    rare_or_unique: ['rare', 'unique'].includes(rarityKey) || enemyIsBoss !== 'None', rarity_multipliers: rarity[rarityKey] ?? null,
    enemy_mods: enemyIsBoss === 'None' ? rarityMods(rarityKey, rarity) : [], ...extra });
  return {
    normal: make('normal', 'Normal map monster', 'None', 'normal', { level_from: 'map_tier' }),
    magic: make('magic', 'Magic map monster', 'None', 'magic', { level_from: 'map_tier' }),
    rare: make('rare', 'Rare map monster', 'None', 'rare', { level_from: 'map_tier' }),
    unique: make('unique', 'Unique map monster (not the map boss)', 'None', 'unique', { level_from: 'map_tier' }),
    map_boss: make('map_boss', 'Map boss (PoB Standard Boss average)', 'Boss', 'unique', { level_from: 'map_tier',
      note: 'PoB averages boss skills into one hit; rarity multipliers are not stacked on top. Real map bosses vary widely.' }),
    pinnacle: make('pinnacle', 'Pinnacle / Guardian boss, generic hit', 'Pinnacle', 'unique', { level_from: 'pob_default', default_level: 84 }),
    uber: make('uber', 'Uber pinnacle boss, generic hit', 'Uber', 'unique', { level_from: 'pob_default', default_level: 85 })
  };
}

// ---------- Boss varieties (PoE Wiki Cargo, cache/wiki; optional source) ----------
// PoB boss profile id -> Wiki monster metadata id of the pinnacle fight. Uber fights mostly reuse the same variety
// with area modifiers that are not in local data, so uber life stays unknown.
export const bossVarietyIds = {
  Shaper: 'Metadata/Monsters/AtlasBosses/TheShaperBoss', Elder: 'Metadata/Monsters/AtlasBosses/TheElder/TheElder',
  Maven: 'Metadata/Monsters/MavenBoss/TheMaven', Sirus: 'Metadata/Monsters/AtlasExiles/AtlasExile5',
  SearingExarch: 'Metadata/Monsters/AtlasInvaders/CleansingMonsters/CleansingBoss', EaterOfWorlds: 'Metadata/Monsters/AtlasInvaders/ConsumeMonsters/ConsumeBoss',
  Atziri: 'Metadata/Monsters/Atziri/Atziri', Venarius: 'Metadata/Monsters/LeagueSynthesis/SynthesisVenariusBoss',
  BlackStar: 'Metadata/Monsters/AtlasInvaders/BlackStarMonsters/BlackStarBoss', InfiniteHunger: 'Metadata/Monsters/AtlasInvaders/DoomMonsters/DoomBoss_',
  Catarina: 'Metadata/Monsters/LeagueBetrayal/BetrayalCatarina2'
};
const cell = (row, key) => row[key] ?? row[key.replaceAll('_', ' ')] ?? null;
export function buildBossVarieties(wikiRoot) {
  const files = ['monster_bosses', 'monster_types', 'monster_resistances', 'monster_map_multipliers'].map(n => path.join(wikiRoot, `${n}.json`));
  if (!files.every(f => fs.existsSync(f))) return { available: false, files: [], varieties: {}, named: {}, map_multipliers: {} };
  const [bossRows, typeRows, resRows, mapRows] = files.map(f => Object.values(readJson(f)));
  const types = new Map(typeRows.map(t => [t.id, t])), res = new Map(resRows.map(r => [r.id, r]));
  const n = v => (v == null || v === '' ? null : Number(v));
  const varieties = {};
  for (const r of bossRows) {
    const id = cell(r, 'metadata_id');
    if (!id) continue;
    const type = types.get(cell(r, 'monster_type_id'));
    const resist = type ? res.get(cell(type, 'monster_resistance_id')) : null;
    varieties[id] = { id, name: r.name, health_multiplier: n(cell(r, 'health_multiplier')), damage_multiplier: n(cell(r, 'damage_multiplier')),
      monster_type_id: cell(r, 'monster_type_id'), rarity: cell(r, 'rarity_id'), mod_ids: String(cell(r, 'mod_ids') ?? '').split(',').filter(Boolean),
      resistances_in_maps: resist ? { fire: n(cell(resist, 'maps_fire')), cold: n(cell(resist, 'maps_cold')), lightning: n(cell(resist, 'maps_lightning')), chaos: n(cell(resist, 'maps_chaos')) } : null };
  }
  const map_multipliers = Object.fromEntries(mapRows.map(r => [Number(r.level), { life: n(r.life), damage: n(r.damage), boss_life: n(cell(r, 'boss_life')), boss_damage: n(cell(r, 'boss_damage')) }]));
  const named = Object.fromEntries(Object.entries(bossVarietyIds).map(([k, id]) => [k, varieties[id] ? id : null]));
  return { available: true, files, varieties, named, map_multipliers };
}

// Absolute boss life is derived, not recorded anywhere locally. Two formulas from two sources bracket it:
// A (Wiki): table life x health multiplier x unique rarity (RePoE +698% more) x (1 + Wiki map boss_life%);
// B (PoB): table life x health multiplier x PoB mapLevelBossLifeMult (MonsterMapBossDifficulty.dat).
export function bossLifeEstimate(db, bossId, level = 84) {
  const id = db.boss_varieties?.named?.[bossId];
  const v = id ? db.boss_varieties.varieties[id] : null;
  const row = db.levels[level];
  if (!v?.health_multiplier || !row?.life) return { value: null, range: null, basis: v ? 'health multiplier missing' : 'No Wiki variety mapped for this boss; pass --enemy-life.' };
  const unique = 1 + (db.rarity.unique.life_more ?? 0) / 100;
  const wikiBoss = db.boss_varieties.map_multipliers[level]?.boss_life;
  const a = wikiBoss != null ? row.life * v.health_multiplier * unique * (1 + wikiBoss / 100) : null;
  const b = row.map_boss_life_mult ? row.life * v.health_multiplier * row.map_boss_life_mult : null;
  const values = [a, b].filter(x => x != null).map(Math.round).sort((x, y) => x - y);
  return { value: null, range: values.length ? [values[0], values[values.length - 1]] : null, variety: v.id, health_multiplier: v.health_multiplier, level,
    basis: `Derived and not verified in game: A = life[${level}] ${row.life} x health ${v.health_multiplier} x unique ${unique} x (1 + Wiki boss_life ${wikiBoss}%) = ${a == null ? '-' : Math.round(a)}; B = life x health x PoB mapLevelBossLifeMult ${row.map_boss_life_mult} = ${b == null ? '-' : Math.round(b)}. Energy shield, phases and uber scaling not included.` };
}

// ---------- Build ----------
export function buildEnemyDb({ knowledgeRoot = path.join(dbRoot, 'cache/knowledge'), pobRoot = path.join(dbRoot, 'vendor/pob/src'), bossFile = path.join(dbRoot, 'scenarios/bosses.json'), wikiRoot = path.join(dbRoot, 'cache/wiki') } = {}) {
  const files = { mods: path.join(knowledgeRoot, 'mods.json'), monster_stats: path.join(knowledgeRoot, 'default_monster_stats.json'), world_areas: path.join(knowledgeRoot, 'world_areas.json'),
    pob_misc: path.join(pobRoot, 'Data/Misc.lua'), pob_map_mods: path.join(pobRoot, 'Data/ModMap.lua'), pob_config: path.join(pobRoot, 'Modules/ConfigOptions.lua'), bosses: bossFile };
  for (const f of Object.values(files)) if (!fs.existsSync(f)) throw new Error(`Enemy database source missing: ${rel(f)}`);
  const mods = readJson(files.mods), stats = readJson(files.monster_stats), areas = readJson(files.world_areas);
  const misc = fs.readFileSync(files.pob_misc, 'utf8'), mapText = fs.readFileSync(files.pob_map_mods, 'utf8'), config = fs.readFileSync(files.pob_config, 'utf8');
  // Guard against silent drift of the PoB conventions summarised in buildArchetypes.
  for (const needle of ['defaultEleResist = 40', 'defaultEleResist = 50', 'enemyModList:NewMod("DamageTaken", "MORE", -70, "Boss")', "multiplierMapModTier", 'monsterDamageTable[defaultLevel] * 1.5'])
    if (!config.includes(needle)) throw new Error(`PoB ConfigOptions changed (missing "${needle}"); review enemy archetypes before rebuilding`);
  const tables = { damage: luaNumberTable(misc, 'data.monsterDamageTable'), life: luaNumberTable(misc, 'data.monsterLifeTable'), armour: luaNumberTable(misc, 'data.monsterArmourTable'),
    evasion: luaNumberTable(misc, 'data.monsterEvasionTable'), accuracy: luaNumberTable(misc, 'data.monsterAccuracyTable'),
    map_life_mult: luaNumberTable(misc, 'data.mapLevelLifeMult'), map_boss_life_mult: luaNumberTable(misc, 'data.mapLevelBossLifeMult') };
  const levels = {};
  for (let level = 1; level <= 100; level++) levels[level] = { damage: tables.damage[level] ?? null, life: tables.life[level] ?? null, armour: tables.armour[level] ?? null,
    evasion: tables.evasion[level] ?? null, accuracy: tables.accuracy[level] ?? null, map_life_mult: tables.map_life_mult[level] ?? null, map_boss_life_mult: tables.map_boss_life_mult[level] ?? null,
    repoe_life: stats[String(level)]?.life ?? null, repoe_physical_damage: stats[String(level)]?.physical_damage ?? null };
  const pob = parsePobMapAffixes(mapText);
  const map_mods = buildMapModCatalogue(mods, pob);
  const rarity = rarityFromRepoe(mods);
  const bosses = readJson(files.bosses);
  const varieties = buildBossVarieties(wikiRoot);
  const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
  const maps = Object.values(areas).filter(a => /^MapWorlds/.test(a.id) && a.tags?.includes('map')).map(a => ({ id: a.id, name: a.name, base_area_level: a.area_level, bosses: a.bosses ?? [] }));
  const pobUnmatched = Object.keys(pob.affixes).filter(k => !Object.values(map_mods).some(m => m.pob_affix?.key === k));
  return {
    game: 'poe1', patch: '3.30', kind: 'enemy_database',
    provenance: { repoe: lock.versions?.repoe ?? null, pob_version: lock.versions?.pob ?? null, pob_commit: lock.versions?.pob_commit ?? null,
      sources: [...Object.entries(files).map(([k, f]) => ({ id: k, file: rel(f), sha256: hashFile(f) })), ...varieties.files.map(f => ({ id: `wiki_${path.basename(f, '.json')}`, file: rel(f), sha256: hashFile(f) }))] },
    method: 'Map mods: RePoE 3.30 area prefixes/suffixes with positive spawn weight on low/mid/top/uber tier maps (or default). White/yellow/red tiers use PoB map affixes where PoB has one; other mods and all T17 mods are translated into PoB enemy mods, player custom modifiers or enemy penetration. Not modelled mechanics are kept as danger axes.',
    disclaimer: 'Numeric model for PoB calculations, not a game test. Roll = worst case of the range. Layout, density, ground effects, reflect, on-death effects and league content are not calculated.',
    map_tiers: Object.fromEntries(Object.entries(mapTierBands).map(([k, b]) => [k, { ...b, area_levels: [areaLevelOfTier(b.tiers[0]), areaLevelOfTier(b.tiers[1])] }])),
    archetypes: buildArchetypes(rarity),
    rarity,
    levels,
    pob_map_affixes: { prefixes: pob.prefixes, suffixes: pob.suffixes, unmatched_in_repoe: pobUnmatched },
    map_mods,
    bosses: Object.fromEntries(Object.values(bosses.bosses).map(b => [b.id, { id: b.id, name: b.name, coverage: b.skill_coverage, skills: b.tiers.uber.skills.map(s => s.skill), wiki_variety: varieties.named[b.id] ?? null }])),
    boss_varieties: { available: varieties.available, source: 'PoE Wiki Cargo monsters/monster_types/monster_resistances/monster_map_multipliers (cache/wiki, sha256 in cache/wiki/manifest.json)',
      caveat: 'monster_types armour/evasion/energy_shield columns disagree with the rendered Wiki pages (e.g. The Shaper: evasion_multiplier 0.33 vs "33% of life as Energy Shield") and are not used.',
      named: varieties.named, map_multipliers: varieties.map_multipliers, varieties: varieties.varieties },
    maps
  };
}

export function writeEnemyDb(file = enemyFile) {
  const data = buildEnemyDb();
  atomicJson(file, data);
  const methods = {};
  for (const m of Object.values(data.map_mods)) for (const t of Object.values(m.tiers)) methods[t.engine.method] = (methods[t.engine.method] ?? 0) + 1;
  return { file: rel(file), map_mods: Object.keys(data.map_mods).length, tier_entries_by_method: methods, archetypes: Object.keys(data.archetypes), bosses: Object.keys(data.bosses).length, maps: data.maps.length,
    pob_affixes_unmatched: data.pob_map_affixes.unmatched_in_repoe };
}

export function loadEnemyDb(file = enemyFile) {
  if (!fs.existsSync(file)) throw new Error('scenarios/enemies.json missing; run: agent.mjs analyze enemies build');
  return readJson(file);
}

// Life of one enemy at an area level, or null when local data cannot give it (bosses: variety multiplier unknown).
export function enemyLife(db, archetype, level, { lifeMore = 0 } = {}) {
  const row = db.levels[level];
  const a = db.archetypes[archetype];
  if (!row || !a) return { value: null, basis: 'unknown level or archetype' };
  if (a.pob_enemy_is_boss !== 'None') return { value: null, basis: 'Boss life depends on the specific monster variety; not in local data. Pass --enemy-life.' };
  const rarityMore = a.rarity_multipliers?.life_more ?? 0;
  const value = Math.round(row.life * (row.map_life_mult ?? 1) * (1 + rarityMore / 100) * (1 + lifeMore / 100));
  return { value, basis: `PoB monsterLifeTable[${level}] ${row.life} x mapLevelLifeMult ${row.map_life_mult ?? 1} x rarity ${1 + rarityMore / 100} x map mods ${1 + lifeMore / 100}; monster variety multiplier assumed 1` };
}

export function resolveMapMod(db, query) {
  const q = String(query).trim().toLowerCase();
  const list = Object.values(db.map_mods);
  return db.map_mods[q] ?? list.find(m => m.name.toLowerCase() === q) ?? list.find(m => m.name.toLowerCase().replace(/^of /, '') === q)
    ?? (() => { throw new Error(`Unknown map mod: ${query}. Try: analyze mapmods --search <text>`); })();
}

export function listMapMods(db, { band = null, search = null, method = null } = {}) {
  const s = search?.toLowerCase();
  return Object.values(db.map_mods).filter(m => (!band || m.tiers[band]) && (!s || m.name.toLowerCase().includes(s) || Object.values(m.tiers).some(t => t.text.toLowerCase().includes(s)))
    && (!method || Object.entries(m.tiers).some(([b, t]) => (!band || b === band) && t.engine.method === method)))
    .map(m => ({ id: m.id, name: m.name, affix: m.affix, tiers: Object.fromEntries(Object.entries(m.tiers).filter(([b]) => !band || b === band).map(([b, t]) => [b, { text: t.text, engine: t.engine.method }])), danger_axes: m.danger_axes }));
}
