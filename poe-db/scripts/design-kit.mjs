// Generic rare item kit for design prototypes (WP5). Bases by attribute / weapon family; mods are chosen from the
// legal natural pool of each base (item-builder itemPool) by intents = ordered type-name patterns, at tier
// min(KIT_TIER, available), mid rolls, one mod per mod group, at most 3 prefixes + 3 suffixes. Every item is
// re-validated by buildItem. The kit is a common yardstick for comparing architectures, not a gear recommendation.
import { buildItem, itemPool, catalog as itemCatalog } from './item-builder.mjs';
import { nodeValue } from './design-blueprint.mjs';
import { firstWeight } from '../experiments/craft-lab/engine.mjs';

export const KIT_TIER = 3;
export const ARMOUR = {
  int: { Helmet: 'Hubris Circlet', 'Body Armour': 'Vaal Regalia', Gloves: 'Sorcerer Gloves', Boots: 'Sorcerer Boots' },
  str: { Helmet: 'Eternal Burgonet', 'Body Armour': 'Glorious Plate', Gloves: 'Titan Gauntlets', Boots: 'Titan Greaves' },
  dex: { Helmet: 'Lion Pelt', 'Body Armour': "Assassin's Garb", Gloves: 'Slink Gloves', Boots: 'Slink Boots' }
};
export const WEAPON_BASES = {
  Bow: 'Thicket Bow', 'Two Hand Mace': 'Coronal Maul', Staff: 'Eclipse Staff', 'Two Hand Axe': 'Vaal Axe', 'Two Hand Sword': 'Exquisite Blade',
  'One Hand Sword': 'Vaal Blade', 'One Hand Axe': 'Runic Hatchet', 'One Hand Mace': 'Behemoth Mace', Claw: 'Imperial Claw', Dagger: 'Ambusher', Wand: 'Imbued Wand', Sceptre: 'Void Sceptre'
};
const ATTR_TYPE = { str: 'Strength', dex: 'Dexterity', int: 'Intelligence' };
const exact = name => new RegExp('^' + name + '$');
// Intent -> ordered type-name patterns; ctx.T = primary damage type of the skill, ctx.attr = attribute type name.
export const INTENTS = {
  life: [/^IncreasedLife$/], movement: [/^MovementVelocity$/],
  res_fire: [/^FireResistance$/], res_cold: [/^ColdResistance$/], res_lightning: [/^LightningResistance$/], res_chaos: [/^ChaosResistance$/],
  attr: c => [exact(c.attr), /^AllAttributes$/], attr_all: [/^AllAttributes$/],
  attr_str: [/^Strength$/, /^AllAttributes$/], attr_dex: [/^Dexterity$/, /^AllAttributes$/], attr_int: [/^Intelligence$/, /^AllAttributes$/],
  spell_type: c => [exact('(TwoHand)?' + c.T + 'DamageWeaponPrefix'), /^(TwoHand)?WeaponSpellDamage$/],
  spell_gem: c => [exact('GlobalIncrease' + c.T + 'SpellSkillGemLevel'), /^GlobalIncreaseSpellSkillGemLevel$/],
  spell_added: c => [exact('SpellAdded' + c.T + 'Damage(TwoHand)?')], cast_speed: [/^IncreasedCastSpeed$/], spell_crit: [/^SpellCriticalStrikeChance$/], crit_multi: [/^CriticalStrikeMultiplier$/],
  dot_type: c => [exact(c.T + 'DamageOverTimeMultiplier'), /^GlobalDamageOverTimeMultiplier$/], dot_global: [/^GlobalDamageOverTimeMultiplier$/],
  minion_damage: [/^MinionDamageOnWeapon$/], minion_gem: [/^GlobalIncreaseMinionSpellSkillGemLevel$/], minion_speed: [/^MinionAttackSpeedAndCastSpeed$/], minion_crit: [/^MinionCriticalStrikeMultiplier$/], minion_life: [/^MinionLife$/],
  phys_pct: [/^LocalPhysicalDamagePercent$/, /^LocalIncreasedPhysicalDamagePercentAndAccuracyRating$/], phys_added: [/^LocalPhysicalDamage(TwoHand(ed)?)?$/],
  type_added: c => c.T === 'Physical' ? [] : [exact('Local' + c.T + 'Damage(TwoHand(ed)?)?')],
  attack_speed: [/^LocalIncreasedAttackSpeed$/], attack_crit: [/^LocalCriticalStrikeChance$/], mana_regen: [/^ManaRegeneration$/],
  // Mana leech (WP11 mana repair when the corpus norm group sustains mana by leech): local leech on the weapon, global on jewellery.
  mana_leech_local: [/^ManaLeechLocalPermyriad$/, /^ManaLeechLocal$/], mana_leech: [/^ManaLeechPermyriad$/]
};

// Pure: choose one mod per intent from pool types [{type, side, groups, tiers:[{id,text}]}].
export function pickMods(types, intents, ctx, tier = KIT_TIER) {
  const used = { prefix: 0, suffix: 0 }, groups = new Set(), mods = [], missing = [];
  for (const intent of intents) {
    const def = INTENTS[intent];
    if (!def) throw new Error(`Unknown kit intent ${intent}`);
    const pats = typeof def === 'function' ? def(ctx) : def;
    if (!pats.length) continue; // intent does not apply to this context (e.g. type_added for Physical = phys_added)
    let hit = null;
    for (const p of pats) { hit = types.find(t => p.test(t.type) && used[t.side] < 3 && !t.groups.some(g => groups.has(g))); if (hit) break; }
    if (!hit) { missing.push(intent); continue; }
    used[hit.side]++; hit.groups.forEach(g => groups.add(g));
    const chosen = hit.tiers[Math.min(tier, hit.tiers.length) - 1];
    mods.push({ intent, type: hit.type, id: chosen.id, side: hit.side, text: chosen.text });
  }
  return { mods, missing };
}

function resolveBase(cat, name) {
  if (cat.bases.has(name)) return name;
  const m = [...cat.bases.values()].filter(b => b.name.toLowerCase() === name.toLowerCase()).sort((a, b) => (b.drop_level ?? 0) - (a.drop_level ?? 0) || a.id.localeCompare(b.id));
  if (!m.length) throw new Error(`Unknown base ${name}`);
  return m[0].id;
}

// Pure: slot plan [slot, base name, intents, sockets?] for a kit. needAttrs (attributes PoB reported as unmet)
// take the attribute suffixes of the jewellery.
export function kitPlan({ attr, family, form, needAttrs = [], manaRegen = false, manaLeech = false }) {
  // Unmet attributes: armour of the first missing attribute, each armour piece adds that attribute as a suffix.
  const armour = ARMOUR[needAttrs[0] ?? attr] ?? ARMOUR.int;
  const na = needAttrs[0] ? ['attr_' + needAttrs[0]] : [];
  const mr = [...(manaRegen ? ['mana_regen'] : []), ...(manaLeech ? ['mana_leech'] : [])];
  const dot = form === 'damage_over_time';
  const spec = [
    ['Helmet', form === 'minion' ? 'Bone Helmet' : armour.Helmet, ['life', 'res_fire', 'res_cold', ...na, ...(form === 'minion' ? ['minion_gem'] : [])]],
    ['Body Armour', armour['Body Armour'], ['life', 'res_fire', 'res_lightning', ...na], 'B-B-B-B-B-B'],
    ['Gloves', armour.Gloves, ['life', 'res_cold', 'res_lightning', ...na]],
    ['Boots', armour.Boots, ['life', 'movement', 'res_fire', 'res_cold', ...na]],
    ['Belt', 'Leather Belt', ['life', 'res_cold', 'res_lightning']],
    // manaRegen (flask-free mana constraint): mana regeneration replaces chaos resistance on the amulet and a ring resistance.
    ['Amulet', 'Onyx Amulet', ['life', needAttrs.length ? 'attr_all' : 'attr', manaRegen ? 'mana_regen' : 'res_chaos']],
    ['Ring 1', 'Amethyst Ring', ['life', 'res_lightning', needAttrs[1] ? 'attr_' + needAttrs[1] : needAttrs[0] ? 'attr_' + needAttrs[0] : 'attr', ...mr]],
    ['Ring 2', 'Amethyst Ring', ['life', 'res_fire', needAttrs[1] ? 'attr_' + needAttrs[1] : 'res_cold', ...mr]]
  ];
  if (family === 'caster') {
    spec.push(['Weapon 1', 'Imbued Wand', dot ? ['spell_type', 'spell_gem', 'dot_type', 'dot_global', 'cast_speed'] : ['spell_type', 'spell_gem', 'spell_added', 'cast_speed', ...(manaRegen ? ['mana_regen'] : []), 'spell_crit', 'crit_multi']]);
    spec.push(['Weapon 2', 'Titanium Spirit Shield', ['life', 'spell_gem', 'spell_type', 'res_fire', 'res_cold', 'res_lightning']]);
  } else if (family === 'minion') {
    spec.push(['Weapon 1', 'Convoking Wand', ['minion_damage', 'minion_gem', 'minion_speed', 'minion_crit']]);
    spec.push(['Weapon 2', 'Bone Spirit Shield', ['life', 'minion_gem', 'minion_damage', 'res_fire', 'res_cold', 'minion_life']]);
  } else {
    const base = WEAPON_BASES[family];
    if (!base) throw new Error(`No weapon kit for ${family}`);
    spec.push(['Weapon 1', base, ['phys_pct', 'type_added', 'phys_added', 'attack_speed', 'attack_crit', manaLeech ? 'mana_leech_local' : 'crit_multi']]);
    if (family === 'Bow') spec.push(['Weapon 2', 'Spike-Point Arrow Quiver', ['life', 'res_fire', 'res_cold', 'crit_multi']]);
    else if (!/^(Two Hand|Staff)/.test(family)) spec.push(['Weapon 2', attr === 'int' ? 'Titanium Spirit Shield' : attr === 'dex' ? 'Imperial Buckler' : 'Pinnacle Tower Shield', ['life', 'res_fire', 'res_cold', 'res_lightning']]);
  }
  return spec;
}

// Pure: flask plan [slot, base, active]. Utility flasks carry the Instilling enchant "Used when Charges reach full"
// (the corpus norm for automatic flasks: 436 of 437 "Used when" lines) and are switched on in PoB (replace_items
// active); the life flask stays a reactive key, off. Bases follow corpus frequency: Quicksilver, a defence flask by
// armour attribute (Granite/Jade/Amethyst), Silver for attacks / Sulphur for spells / Basalt for minions, then
// Diamond for hits or the next unused defence flask. Charge sustain is not modelled: PoB treats active flasks as up.
export function flaskPlan({ attr, family, form }) {
  const attack = !['caster', 'minion'].includes(family);
  const hit = form !== 'damage_over_time' && form !== 'minion';
  const defence = { str: 'Granite Flask', dex: 'Jade Flask', int: 'Amethyst Flask' }[attr] ?? 'Granite Flask';
  const offence = attack ? 'Silver Flask' : form === 'minion' ? 'Basalt Flask' : 'Sulphur Flask';
  const used = new Set(['Quicksilver Flask', defence, offence]);
  const fifth = [hit ? 'Diamond Flask' : null, 'Basalt Flask', 'Granite Flask', 'Jade Flask'].find(b => b && !used.has(b));
  return [['Flask 1', 'Divine Life Flask', false], ['Flask 2', 'Quicksilver Flask', true], ['Flask 3', defence, true], ['Flask 4', offence, true], ['Flask 5', fifth, true]];
}
export const AUTO_FLASK_ENCHANT = 'Used when Charges reach full';
export function flaskText(base, auto) {
  return ['Rarity: MAGIC', base, 'Quality: 20', ...(auto ? ['Implicits: 1', `{crafted}${AUTO_FLASK_ENCHANT}`] : ['Implicits: 0'])].join('\n');
}

// WP5b item 5: eldritch implicits. Pool = RePoE mods with generation_type searing_exarch_implicit /
// eater_of_worlds_implicit whose spawn weight on the base tags is > 0 at ELDRITCH_TIER (id suffix 1..6: Lesser ..
// Perfect ember/ichor; the tier gate is the no_tier_N_eldritch_implicit tag, absent from a plain base). Presence
// variants ("while a Unique/Pinnacle enemy is in your Presence") are left out: their value depends on encounter config.
// Each armour piece gets the best Exarch and the best Eater type by the generator axes (nodeValue of the rendered
// text); ties go to the higher spawn weight (the more common outcome), then the type name.
export const ELDRITCH_TIER = 4;
export const ELDRITCH_SLOTS = ['Helmet', 'Body Armour', 'Gloves', 'Boots'];
export const ELDRITCH_SIDES = { searing_exarch_implicit: 'exarch', eater_of_worlds_implicit: 'eater' };
export function eldritchPool(cat, baseId, tier = ELDRITCH_TIER) {
  const base = cat.bases.get(baseId), tags = new Set(base.tags);
  const out = [];
  for (const mod of cat.mods.values()) {
    if (!ELDRITCH_SIDES[mod.generation_type] || /Presence$/.test(mod.type) || !mod.id.endsWith(String(tier))) continue;
    const weight = firstWeight(mod.spawn_weights, tags, 0);
    if (weight > 0) out.push({ id: mod.id, type: mod.type, side: ELDRITCH_SIDES[mod.generation_type], weight, text: mod.text ?? mod.id });
  }
  return out;
}
// Pure: best row per side; valueOf(text) -> number. Rows with value 0 still win over nothing (an empty implicit
// slot is never better), so the choice is deterministic for every skill.
export function pickEldritch(rows, valueOf) {
  const out = {};
  for (const side of ['exarch', 'eater']) {
    const best = rows.filter(r => r.side === side).map(r => ({ ...r, value: valueOf(r.text) }))
      .sort((a, b) => b.value - a.value || b.weight - a.weight || a.type.localeCompare(b.type))[0];
    if (best) out[side] = best;
  }
  return out;
}

// Delivery filter on top of nodeValue (whose axes do not separate attack and spell lines): an attack-only line has no
// value for spell/minion kits, a spell-only line none for attack kits; minion lines only for minion kits.
const ATTACK_LINE = /\b(to|with) attacks\b|\battack (damage|speed|skills?)\b|\baccuracy\b/i;
// "Suppress/Block Spell Damage" is defence, not spell delivery.
const SPELL_LINE = /\bto spells\b|(?<!(suppress|block) )\bspell damage\b|\bcast speed\b|\bspell skills?\b/i;
export function eldritchValue(text, axes, family) {
  const caster = family === 'caster', minion = family === 'minion';
  const attack = ATTACK_LINE.test(text), spell = SPELL_LINE.test(text);
  if (/\bminions?\b/i.test(text) && !minion) return 0;
  if (attack && !spell && (caster || minion)) return 0;
  if (spell && !attack && !caster) return 0;
  return nodeValue(text, axes, { family }).value;
}

const kitCache = new Map();
// axes: generator scaling axes [{axis, pattern, weight}] (eldritch implicit choice); without axes no eldritch implicits.
export function itemKit({ attr, family, damageTypes, form, needAttrs = [], manaRegen = false, manaLeech = false, axes = null }) {
  const key = JSON.stringify({ attr, family, damageTypes, form, needAttrs, manaRegen, manaLeech, axes: axes?.map(a => [a.axis, a.weight]) ?? null });
  if (kitCache.has(key)) return kitCache.get(key);
  const cat = itemCatalog(), notes = [];
  const ctx = { T: damageTypes[0] ?? 'Physical', attr: ATTR_TYPE[attr] ?? 'Intelligence' };
  const replace_items = [], bases = [];
  for (const [slot, name, intents, sockets] of kitPlan({ attr, family, form, needAttrs, manaRegen, manaLeech })) {
    const base = resolveBase(cat, name);
    let types = itemPool({ base, item_level: 84, tiers: 20, limit: 500 }, cat).types;
    let mods, missing, r, implicits;
    const eld = axes?.length && ELDRITCH_SLOTS.includes(slot) ? pickEldritch(eldritchPool(cat, base), text => eldritchValue(text, axes, family)) : null;
    if (eld) implicits = Object.values(eld).map(e => e.id);
    // A type the builder cannot export (violation names the mod) is removed from the pool and the intent re-picked.
    for (let attempt = 0; attempt < 8; attempt++) {
      ({ mods, missing } = pickMods(types, intents, ctx));
      r = buildItem({ base, item_level: 84, rarity: 'rare', roll: 'mid', mods: mods.map(m => m.id), sockets, ...(implicits ? { implicits } : {}) }, cat);
      if (r.legal) break;
      const bad = new Set(r.violations.map(v => mods.find(m => m.id === v.mod)?.type).filter(Boolean));
      if (!bad.size) break;
      notes.push(`${slot} ${name}: skipped ${[...bad].join(', ')} (${r.violations.map(v => v.code).join(', ')})`);
      types = types.filter(t => !bad.has(t.type));
    }
    if (missing.length) notes.push(`${slot} ${name}: no legal ${missing.join(', ')}`);
    if (!r.legal) throw new Error(`Kit item ${name} illegal: ${r.violations.map(v => `${v.code} ${v.detail ?? ''}`).join('; ').slice(0, 300)}`);
    replace_items.push({ slot, text: r.text });
    bases.push(`${slot}: ${name} (${mods.map(m => m.type).join(', ')})${eld ? ` + eldritch ${Object.values(eld).map(e => e.type).join(' / ')}` : ''}`);
  }
  for (const [slot, base, auto] of flaskPlan({ attr, family, form })) {
    replace_items.push({ slot, text: flaskText(base, auto), active: auto });
    bases.push(`${slot}: ${base}${auto ? ' (auto: ' + AUTO_FLASK_ENCHANT + ')' : ' (reactive key)'}`);
  }
  notes.push('Flasks: utility flasks automatic (Used when Charges reach full) and active in PoB; charge sustain not modelled.');
  const out = { replace_items, notes, bases };
  kitCache.set(key, out);
  return out;
}
