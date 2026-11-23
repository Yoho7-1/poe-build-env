// Encounter = one enemy (archetype or boss skill) + map tier + map modifiers, turned into a `pob run --changes`
// object. Pure: reads the enemy database and boss scenarios, never the engine. Every modifier records how it is
// modelled (PoB map affix, translated PoB mods, or not modelled with a danger axis).
import { bandOfTier, areaLevelOfTier, mapTierBands, resolveMapMod, enemyLife, bossLifeEstimate } from './enemy-db.mjs';
import { resolveBoss, tiers as bossTiers } from './analysis-bosses.mjs';
import { atlasEffects } from './atlas-combat.mjs';

const elements = ['Fire', 'Cold', 'Lightning'];
const deliriumValues = { 0: 0, 20: '20Percent', 40: '40Percent', 60: '60Percent', 80: '80Percent', 100: '100Percent' };
const scale = (value, effect) => Math.round(value * (1 + effect / 100) * 100) / 100;
// Generic monster hit split by damage type; the total stays PoB's generic hit (monsterDamageTable * 1.5).
// "mixed" uses PoB's boss proportions (four types equal, chaos 0.4 of one type).
export const damageProfiles = {
  physical: { Physical: 1 }, elemental: { Fire: 1 / 3, Cold: 1 / 3, Lightning: 1 / 3 }, fire: { Fire: 1 }, cold: { Cold: 1 }, lightning: { Lightning: 1 }, chaos: { Chaos: 1 },
  mixed: { Physical: 1 / 4.4, Fire: 1 / 4.4, Cold: 1 / 4.4, Lightning: 1 / 4.4, Chaos: 0.4 / 4.4 }
};
export const pantheonGods = { major: ['None', 'TheBrineKing', 'Lunaris', 'Solaris', 'Arakaali'], minor: ['None', 'Gruthkul', 'Yugul', 'Abberath', 'Tukohama', 'Garukhan', 'Ralakesh', 'Ryslatha', 'Shakari'] };

// Enemy spec: normal | magic | rare | unique | map_boss | pinnacle | uber | boss:<name>[:<skill>]
export function parseEnemy(text) {
  const raw = String(text ?? 'rare').trim();
  const m = raw.match(/^boss:([^:]+)(?::(.+))?$/i);
  if (m) return { kind: 'boss', boss: m[1].trim(), skill: m[2]?.trim() ?? null };
  return { kind: 'archetype', archetype: raw.toLowerCase().replace(/[- ]/g, '_') };
}

function pobTierOf(band) { return mapTierBands[band].pob_tier; }
const round2 = v => Math.round(v * 100) / 100;
export const isBossOnly = tier => tier.stats.length > 0 && tier.stats.every(s => s.id.startsWith('map_boss_'));

export function buildEncounter(db, bossData, spec) {
  const enemy = parseEnemy(spec.enemy);
  const tier = spec.tier ?? 16;
  const band = bandOfTier(tier);
  const givenEffect = Number(spec.map_mod_effect ?? 0);
  if (!Number.isFinite(givenEffect) || givenEffect < 0 || givenEffect > 300) throw new Error('--map-mod-effect must be 0-300 (%)');
  // Atlas nodes: explicit map modifier effect adds to --map-mod-effect; generic monster damage/life lines become enemy mods.
  const atlas = (spec.atlas ?? []).length ? atlasEffects(spec.atlas, { explicitModCount: (spec.mods ?? []).length }) : null;
  const effect = givenEffect + (atlas?.map_mod_effect ?? 0);
  const config = {}, enemyMods = [], customMods = [], pen = {};
  const assumptions = [], notModelled = [], modifiers = [];
  let label, life = { value: spec.enemy_life ?? null, basis: spec.enemy_life != null ? 'given by --enemy-life' : null };
  let basePen = {};
  let archetype, dot = null;

  if (enemy.kind === 'boss') {
    const bossTier = spec.boss_tier ?? 'uber';
    if (!bossTiers[bossTier]) throw new Error('--boss-tier pinnacle|uber');
    const profile = resolveBoss(bossData, enemy.boss);
    const entry = profile.tiers[bossTier];
    const list = entry.skills.length ? entry.skills : [entry.generic];
    const skill = enemy.skill ? list.find(s => s.skill.toLowerCase() === enemy.skill.toLowerCase()) : list[0];
    if (!skill) throw new Error(`Unknown skill for ${profile.name}: ${enemy.skill}. Known: ${list.map(s => s.skill).join(', ')}`);
    Object.assign(config, skill.config);
    basePen = Object.fromEntries(Object.entries(skill.penetration ?? {}).map(([k, v]) => [k.replace(/Pen$/, ''), v]));
    archetype = bossTier;
    label = `${profile.name} / ${skill.skill} (${bossTier})`;
    if (skill.kind === 'damage_over_time') { dot = { ...skill.damage }; assumptions.push('Boss skill is a damage over time: assessed as degen against DoT EHP and recovery, not as a hit.'); }
    assumptions.push(...(skill.caveats ?? []));
    if (spec.level) config.enemyLevel = spec.level;
    // Wiki variety data: real resistances (PoB uses 50/30 for every pinnacle) and a derived life range.
    const variety = db.boss_varieties?.varieties?.[db.boss_varieties?.named?.[profile.id]];
    const r = variety?.resistances_in_maps;
    if (r && [r.fire, r.cold, r.lightning, r.chaos].every(v => typeof v === 'number')) {
      Object.assign(config, { enemyFireResist: r.fire, enemyColdResist: r.cold, enemyLightningResist: r.lightning, enemyChaosResist: r.chaos });
      assumptions.push(`Enemy resistances from the Wiki variety ${variety.id}: ${r.fire}/${r.cold}/${r.lightning}/${r.chaos} (PoB default for this tier is 50/50/50/30).`);
    }
    if (life.value == null) {
      const est = bossLifeEstimate(db, profile.id, 84);
      life = bossTier === 'pinnacle' ? est : { value: null, range: null, basis: `Uber life scaling is not in local data${est.range ? `; pinnacle estimate ${est.range[0]}-${est.range[1]}` : ''}. Pass --enemy-life.` };
    }
  } else {
    archetype = enemy.archetype;
    const a = db.archetypes[archetype];
    if (!a) throw new Error(`Unknown enemy: ${spec.enemy}. Use ${Object.keys(db.archetypes).join('|')} or boss:<name>[:<skill>]`);
    config.enemyIsBoss = a.pob_enemy_is_boss;
    if (a.pob_enemy_is_boss === 'None' && a.rare_or_unique) config.conditionEnemyRareOrUnique = true;
    const level = spec.level ?? (a.level_from === 'map_tier' ? areaLevelOfTier(tier) : a.default_level);
    config.enemyLevel = level;
    enemyMods.push(...a.enemy_mods);
    const profileName = spec.damage_profile ?? 'physical';
    if (!damageProfiles[profileName]) throw new Error(`--damage-profile ${Object.keys(damageProfiles).join('|')}`);
    if (profileName !== 'physical') {
      if (a.pob_enemy_is_boss !== 'None') throw new Error('--damage-profile applies to normal/magic/rare/unique monsters; bosses use PoB boss averages or skill presets');
      const total = Math.round((db.levels[level]?.damage ?? 0) * 1.5);
      for (const t of ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos']) config[`enemy${t}Damage`] = Math.round(total * (damageProfiles[profileName][t] ?? 0));
      assumptions.push(`Damage profile "${profileName}": PoB generic hit ${total} split by type; map mods that add damage "as extra" scale only the physical part.`);
    }
    // PoB generic boss penetration (placeholders); needed only when a map mod adds penetration on top.
    const genericPen = { Pinnacle: bossData.misc?.pinnacleBossPen, Uber: bossData.misc?.uberBossPen }[a.pob_enemy_is_boss];
    if (genericPen != null) basePen = Object.fromEntries(elements.map(e => [e, genericPen]));
    label = (a.pob_enemy_is_boss === 'None' || a.pob_enemy_is_boss === 'Boss' ? `${a.label}, T${tier} (area level ${level})` : `${a.label} (level ${level})`) + (profileName !== 'physical' ? `, ${profileName} hits` : '');
    if (a.rarity_multipliers?.life_more) assumptions.push(`Rarity ${a.rarity}: ${a.rarity_multipliers.life_more}% more life, ${a.rarity_multipliers.damage_more}% more damage, ${a.rarity_multipliers.speed_more_damage_less}% more speed and less damage (RePoE monster mods).`);
    if (a.note) assumptions.push(a.note);
    assumptions.push(a.pob_convention);
  }

  if (atlas) {
    enemyMods.push(...atlas.enemy_mods);
    for (const n of atlas.not_modelled) notModelled.push({ id: `atlas:${n.node}`, name: n.node, text: n.text, axes: ['atlas_not_modelled'], reason: 'Atlas node text without a translation rule' });
    assumptions.push(`Atlas: ${atlas.applied.map(a => `${a.node} (${a.text})`).join('; ') || 'no modelled lines'}.`);
  }

  // Map modifiers.
  const slots = { prefix: 0, suffix: 0 };
  let lifeMore = 0, esPct = 0;
  let usedPobTier = false;
  const isBoss = enemy.kind === 'boss' || ['map_boss', 'pinnacle', 'uber'].includes(archetype);
  for (const query of spec.mods ?? []) {
    const mod = resolveMapMod(db, query);
    const t = mod.tiers[band];
    if (!t) { modifiers.push({ id: mod.id, name: mod.name, band, status: 'not_on_this_tier', available: Object.keys(mod.tiers) }); continue; }
    const e = t.engine;
    const row = { id: mod.id, name: mod.name, band, text: t.text, method: e.method, axes: e.axes ?? [] };
    // "Unique Boss ..." mods: PoB applies them to every Rare/Unique enemy; in game they affect only the map boss.
    if (isBossOnly(t) && !isBoss) { modifiers.push({ ...row, status: 'boss_only_not_applied' }); continue; }
    for (const s of t.stats) if (s.id === 'map_monsters_maximum_life_%_to_add_to_maximum_energy_shield') esPct += Math.max(s.min, s.max) * (1 + effect / 100);
    if (e.method === 'pob_map_affix') {
      const kind = mod.affix === 'prefix' ? 'Prefix' : 'Suffix';
      const n = ++slots[mod.affix];
      if (n > 4) throw new Error(`PoB has 4 ${mod.affix} slots; too many PoB map affixes`);
      config[`Map${kind}${n}`] = e.pob_affix;
      usedPobTier = true;
      row.pob = `${kind} slot ${n}: ${e.pob_affix} (${e.pob_tier})`;
      // Life MORE from PoB affixes is applied by the engine; track it only for the life estimate.
      const lifeStat = t.stats.find(s => s.id === 'map_monsters_life_+%');
      if (lifeStat) lifeMore += Math.max(lifeStat.min, lifeStat.max) * (1 + effect / 100);
    } else if (['translated', 'partial'].includes(e.method)) {
      for (const m of e.enemy_mods) {
        const value = typeof m.value === 'number' ? scale(m.value, effect) : m.value;
        enemyMods.push({ ...m, value, source: `Map mod ${mod.name} (${band})` });
        if (m.name === 'Life' && m.type === 'MORE' && !m.condition) lifeMore += value;
      }
      // Curse lines carry a level, not a magnitude: not scaled by map mod effect.
      for (const line of e.custom_mods) customMods.push(effect && !/^You are cursed/.test(line) ? line.replace(/^(-?)(\d+(?:\.\d+)?)/, (all, sign, num) => `${sign}${scale(Number(num), effect)}`) : line);
      for (const [k, v] of Object.entries(e.pen ?? {})) pen[k] = (pen[k] ?? 0) + scale(v, effect);
      row.translation = { enemy_mods: e.enemy_mods.length, custom_mods: e.custom_mods, pen: e.pen, notes: e.notes };
    }
    if (e.method === 'not_modelled' || e.method === 'partial') notModelled.push({ id: mod.id, name: mod.name, text: t.text, axes: e.axes ?? [], reason: e.reason ?? 'Mechanic outside the calculation model' });
    modifiers.push(row);
  }
  if (usedPobTier) config.multiplierMapModTier = pobTierOf(band);
  if (effect) { config.multiplierMapModEffect = effect; assumptions.push(`Map modifier effect +${effect}% applied to PoB affixes and to translated values (curse levels unchanged).`); }
  for (const e of elements) if (pen[e] != null) config[`enemy${e}Pen`] = (basePen[e] ?? 0) + pen[e];
  if (spec.delirium) {
    if (!(spec.delirium in deliriumValues)) throw new Error('--delirium 0|20|40|60|80|100');
    config.deliriousPercentage = deliriumValues[spec.delirium];
    assumptions.push(`Delirium ${spec.delirium}% (PoB: enemies take less damage and deal more damage).`);
  }
  if (dot && (spec.mods ?? []).length) assumptions.push('Map mods that change enemy damage are not applied to the raw boss degen numbers.');
  if (life.value == null && enemy.kind === 'archetype') {
    life = enemyLife(db, archetype, config.enemyLevel, { lifeMore });
    if (life.value != null && atlas?.life_more) life = { value: Math.round(life.value * (1 + atlas.life_more / 100)), basis: `${life.basis}; x atlas life ${1 + atlas.life_more / 100}` };
    // Buffered: extra energy shield as a share of life; time-to-kill uses life + ES.
    if (life.value != null && esPct) life = { value: Math.round(life.value * (1 + esPct / 100)), basis: `${life.basis}; + energy shield ${round2(esPct)}% of life (map mod)` };
  }
  else if (life.value == null && !life.range) life = { value: null, range: null, basis: life.basis ?? 'Boss life is not in local data; pass --enemy-life for time-to-kill.' };
  for (const [kind, key] of [['major', 'pantheonMajorGod'], ['minor', 'pantheonMinorGod']]) {
    const god = spec[`pantheon_${kind}`];
    if (god == null) continue;
    if (!pantheonGods[kind].includes(god)) throw new Error(`--pantheon-${kind} ${pantheonGods[kind].join('|')}`);
    config[key] = god;
    assumptions.push(`Pantheon ${kind} god ${god} (PoB applies the base and upgraded effects it models).`);
  }

  const changes = { config };
  if (customMods.length) changes.custom_mods = customMods.join('\n');
  if (enemyMods.length) changes.enemy_mods = enemyMods.map(m => ({ name: m.name, type: m.type, value: m.value, ...(m.condition ? { condition: m.condition } : {}), source: m.source ?? 'Encounter' }));
  return { label, enemy: { ...enemy, archetype, level: config.enemyLevel ?? null, pob_enemy_is_boss: config.enemyIsBoss, kind: dot ? 'damage_over_time' : 'hit', dot_raw_dps: dot }, map: { tier, band, area_level: areaLevelOfTier(tier), map_mod_effect: effect },
    modifiers, not_modelled: notModelled, life, assumptions: [...new Set(assumptions)], changes };
}

// Same enemy without map modifiers (the comparison baseline of a modified encounter).
export function cleanSpec(spec) { return { ...spec, mods: [], map_mod_effect: 0, delirium: 0 }; }

export function mergeChanges(base = {}, extra = {}) {
  const out = { ...base, ...extra, config: { ...(base.config ?? {}), ...(extra.config ?? {}) } };
  const mods = [base.custom_mods, extra.custom_mods].filter(Boolean);
  if (mods.length) out.custom_mods = mods.join('\n');
  const enemy = [...(base.enemy_mods ?? []), ...(extra.enemy_mods ?? [])];
  if (enemy.length) out.enemy_mods = enemy;
  return out;
}
