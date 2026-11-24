import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../scripts/design-blueprint.mjs';
import { pickMods, kitPlan, flaskPlan, flaskText } from '../scripts/design-kit.mjs';

const profile = { id: 'main', profile: {
  preferred_skills: ['explosions (on-kill explode / explosion-themed)', 'Chieftain or Occultist'],
  preferred_content: ['T17 maps: fast clear'], buttons: 'few; many buttons disliked',
  disliked_mechanics: ['constant flask pressing', 'many buttons'], budget: { amount: 20, currency: 'divine' }, platform: null } };

const gem = (over = {}) => ({ id: 'X', name: 'X', is_support: false, eligibility: 'released_in_client', colour: 'b', tags: [], types: [], minion_types: [], weapon_restrictions: [], description: '', ...over });

test('profile -> request: ascendancies, themes, tier, buttons; unknowns stay null and defaults are listed', () => {
  const r = B.requestFromProfile(profile);
  assert.deepEqual(r.classes, [{ class: 'Marauder', ascendancy: 'Chieftain' }, { class: 'Witch', ascendancy: 'Occultist' }]);
  assert.ok(r.themes.includes('explosion') && r.themes.includes('on_kill_explosion'));
  assert.equal(r.map_tier, 17);
  assert.equal(r.buttons.max, 3);
  assert.equal(r.platform, null);
  assert.equal(r.constraints.no_mana_flask, true);
  assert.ok(r.assumptions.some(a => /level 92/.test(a)) && r.assumptions.some(a => /few buttons/.test(a)));
  const empty = B.requestFromProfile({ profile: {} });
  assert.equal(empty.buttons.max, null); assert.equal(empty.constraints.no_mana_flask, null); assert.equal(empty.map_tier, 16);
});

test('request validation rejects wrong class/ascendancy pairs and unknown themes; Warden maps to Raider', () => {
  const base = { schema: B.REQUEST_SCHEMA, classes: [], themes: [], level: 90, map_tier: 16 };
  assert.throws(() => B.validateRequest({ ...base, classes: [{ class: 'Witch', ascendancy: 'Chieftain' }] }), /belongs to Marauder/);
  assert.throws(() => B.validateRequest({ ...base, themes: ['teleport'] }), /Unknown theme/);
  assert.equal(B.validateRequest({ ...base, classes: [{ ascendancy: 'Warden' }] }).classes[0].ascendancy, 'Raider');
});

test('main-skill filter keeps attacks without Damage type and damaging auras, drops utility and vaal', () => {
  assert.ok(B.isMainSkillCandidate(gem({ types: ['Attack', 'Melee', 'Area'] })).ok);
  assert.ok(B.isMainSkillCandidate(gem({ types: ['Aura', 'Damage', 'Area'] })).ok);
  assert.equal(B.isMainSkillCandidate(gem({ types: ['Aura', 'HasReservation', 'Buff'] })).reason, 'non_damaging');
  assert.equal(B.isMainSkillCandidate(gem({ types: ['Spell', 'Travel', 'Damage'] })).reason, 'utility_Travel');
  assert.equal(B.isMainSkillCandidate(gem({ types: ['Spell', 'Damage'], tags: ['vaal'] })).reason, 'vaal_or_royale');
  assert.equal(B.isMainSkillCandidate(gem({ types: ['Spell', 'Damage'], eligibility: 'historical' })).reason, 'eligibility_historical');
});

test('weapon family, form and damage types come from skill types', () => {
  assert.equal(B.weaponFamilyFor(gem({ types: ['Spell', 'Damage'] })), 'caster');
  assert.equal(B.weaponFamilyFor(gem({ types: ['Attack'], weapon_restrictions: ['Claw', 'Bow'] })), 'Bow');
  assert.equal(B.weaponFamilyFor(gem({ types: ['Attack'], weapon_restrictions: ['FishingRod'] })), null);
  assert.equal(B.weaponFamilyFor(gem({ types: ['Spell', 'Minion', 'CreatesMinion'] })), 'minion');
  assert.equal(B.damageFormOf(gem({ types: ['Spell', 'DamageOverTime', 'Cold'] })), 'damage_over_time');
  assert.deepEqual(B.damageTypesOf(gem({ types: ['Attack'] })), ['Physical']);
});

test('node requirements: curse has an enabler, bleed must come from the skill, optional totem kills do not block', () => {
  const curse = B.nodeRequirements(['Cursed Enemies you Kill have a 50% chance to Explode']);
  assert.deepEqual(B.requirementsMet(curse, []), { ok: true, unmet: [], enablers: ['curse'] });
  const bleed = B.nodeRequirements(['Bleeding Enemies you Kill Explode']);
  assert.equal(B.requirementsMet(bleed, ['fire']).ok, false);
  assert.equal(B.requirementsMet(bleed, ['bleed']).ok, true);
  assert.equal(B.requirementsMet(B.nodeRequirements(['Enemies you or your Totems Kill have 10% chance to Explode']), []).ok, true);
});

test('axes: minion skills scale minion stats, not the summon spell; node value sums matching axes', () => {
  const srs = gem({ types: ['Spell', 'Minion', 'Fire', 'CreatesMinion'], minion_types: ['Attack', 'Melee'] });
  const axes = B.axesFor(srs).map(a => a.axis);
  assert.ok(axes.includes('minion_damage') && axes.includes('life'));
  assert.ok(!axes.includes('spell_damage') && !axes.includes('fire_damage'));
  const cold = B.axesFor(gem({ types: ['Spell', 'Cold', 'DamageOverTime'] }));
  assert.ok(B.nodeValue(['+15% to Cold Damage over Time Multiplier'], cold).value > B.nodeValue(['10% increased maximum Life'], cold).value - 1);
  assert.equal(B.nodeValue(['10% increased Armour'], cold).value, 0);
});

test('candidate score: themes met by skill or by an ascendancy node with satisfiable condition', () => {
  const req = B.validateRequest({ schema: B.REQUEST_SCHEMA, classes: [{ ascendancy: 'Occultist' }], themes: ['on_kill_explosion'], level: 90, map_tier: 16 });
  const asc = [{ name: 'Profane Bloom', stats: ['Cursed Enemies you or your Minions Kill have a 50% chance to Explode, dealing a quarter of their maximum Life as Chaos Damage'] }];
  const s = B.scoreCandidate(gem({ types: ['Spell', 'Damage', 'Cold'] }), req.classes[0], asc, req);
  assert.deepEqual(s.themes_missing, []);
  assert.equal(s.themes_met[0].by, 'ascendancy:Profane Bloom');
  assert.deepEqual(s.themes_met[0].enablers, ['curse']);
  const bleedAsc = [{ name: 'GV', stats: ['Bleeding Enemies you Kill Explode'] }];
  assert.deepEqual(B.scoreCandidate(gem({ types: ['Spell', 'Damage', 'Cold'] }), req.classes[0], bleedAsc, req).themes_missing, ['on_kill_explosion']);
});

test('diversify keeps one per key before repeating', () => {
  const rows = [{ id: 'a', k: 1, score: 9 }, { id: 'b', k: 1, score: 8 }, { id: 'c', k: 2, score: 1 }];
  assert.deepEqual(B.diversify(rows, 2, r => r.k).map(r => r.id), ['a', 'c']);
  assert.deepEqual(B.diversify(rows, 3, r => r.k).map(r => r.id), ['a', 'c', 'b']);
});

test('buttons: auras, reservation and auto curse enablers are not pressed; duration skills are flagged for recast', () => {
  const b = B.countButtons([
    { label: 'Main', gems: [{ name: 'Vortex', types: ['Spell', 'Duration', 'Area'] }, { name: 'Supp', types: null }] },
    { label: 'Aura', gems: [{ name: 'Malevolence', types: ['Aura', 'HasReservation'] }] },
    { label: 'Curse', gems: [{ name: 'Frostbite', types: ['Hex', 'AppliesCurse'], role: 'enabler_auto' }] },
    { label: 'Off', enabled: false, gems: [{ name: 'Cyclone', types: ['Attack', 'Channel'] }] }]);
  assert.equal(b.pressed, 1); assert.deepEqual(b.recast_on_duration, ['Vortex']);
});

test('hard filters: damage, requirements, cost, flask-free mana sustain, unparsed mods', () => {
  const req = { constraints: { no_mana_flask: true } };
  assert.deepEqual(B.hardFilters({ dps: 1000, mana_unreserved: 500, mana_cost: 20, mana_sustain: 5, unmet_requirements: [], unparsed_item_mods: 0 }, req), []);
  const codes = B.hardFilters({ dps: 0, mana_unreserved: 10, mana_cost: 20, mana_sustain: -3, unmet_requirements: ['You do not meet the Intelligence requirement of X'], unparsed_item_mods: 2 }, req).map(f => f.code);
  assert.deepEqual(codes, ['no_damage', 'requirements_unmet', 'cannot_pay_cost', 'mana_not_sustained', 'unparsed_item_mods']);
  assert.ok(!B.hardFilters({ dps: 1, mana_sustain: -3, minion: true }, req).some(f => f.code === 'mana_not_sustained'));
  assert.ok(!B.hardFilters({ dps: 1, mana_sustain: -3 }, { constraints: {} }).length);
});

test('Pareto front: dominance over max/min objectives, nulls lose', () => {
  const obj = [{ key: 'dps', dir: 'max' }, { key: 'buttons', dir: 'min' }];
  const rows = [{ id: 'a', dps: 10, buttons: 1 }, { id: 'b', dps: 20, buttons: 2 }, { id: 'c', dps: 5, buttons: 2 }, { id: 'd', dps: null, buttons: 1 }];
  const f = B.paretoFront(rows, obj);
  assert.deepEqual(f.front.map(r => r.id), ['a', 'b']);
  assert.deepEqual(f.dominated.find(r => r.id === 'c').dominated_by.sort(), ['a', 'b']);
  assert.deepEqual(f.dominated.find(r => r.id === 'd').dominated_by, ['a']);
  assert.equal(B.dominates({ dps: 1, buttons: 1 }, { dps: 1, buttons: 1 }, obj), false);
});

test('blueprint schema validates the required sections', () => {
  const ok = { schema: B.BLUEPRINT_SCHEMA, id: 'vortex--occultist', class: 'Witch', ascendancy: 'Occultist',
    damage_chain: { source: { skill: 'Vortex' }, form: 'damage_over_time', damage_types: ['Cold'], delivery_supports: [] },
    scaling_axes: [{ axis: 'cold_damage' }], clear_mechanism: [{ kind: 'on_kill_explosion' }], defence_layers: [{ layer: 'pool' }],
    resources: { reservation: [] }, uptime: { buttons_planned: 1 }, components: { core: ['Vortex'], implementation: [], replaceable: [] },
    success_criteria: B.successCriteria({ map_tier: 17, buttons: { max: 3 }, constraints: { no_mana_flask: true } }), assumptions: [], not_modelled: [] };
  assert.equal(B.validateBlueprint(structuredClone(ok)).id, 'vortex--occultist');
  assert.throws(() => B.validateBlueprint({ ...ok, class: 'Marauder' }), /mismatch/);
  assert.throws(() => B.validateBlueprint({ ...ok, damage_chain: { ...ok.damage_chain, form: 'laser' } }), /form/);
  assert.throws(() => B.validateBlueprint({ ...ok, defence_layers: [] }), /defence_layers/);
  assert.throws(() => B.validateBlueprint({ ...ok, success_criteria: [{ metric: 'x', op: '=', source: 'profile' }] }), /op/);
  assert.ok(B.successCriteria({ map_tier: 17, buttons: { max: 3 }, constraints: { no_mana_flask: true } }).some(c => c.metric === 'buttons' && c.value === 3));
});

test('clear score is a documented heuristic over types and engine-reported explosions', () => {
  assert.equal(B.clearScore(['Area', 'Projectile', 'Chains'], 1), 4);
  assert.equal(B.clearScore(['Melee'], 0), 0);
});

test('kit: pickMods respects affix sides, mod groups and tier; plan covers weapon families', () => {
  const types = [
    { type: 'IncreasedLife', side: 'prefix', groups: ['IncreasedLife'], tiers: [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }, { id: 'L4' }] },
    { type: 'ColdDamageWeaponPrefix', side: 'prefix', groups: ['WeaponCasterDamagePrefix'], tiers: [{ id: 'C1' }] },
    { type: 'WeaponSpellDamage', side: 'prefix', groups: ['WeaponCasterDamagePrefix'], tiers: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }] },
    { type: 'FireResistance', side: 'suffix', groups: ['FireResistance'], tiers: [{ id: 'F1' }, { id: 'F2' }] }];
  const r = pickMods(types, ['life', 'spell_type', 'res_fire', 'res_cold'], { T: 'Cold', attr: 'Intelligence' });
  assert.deepEqual(r.mods.map(m => m.id), ['L3', 'C1', 'F2']);
  assert.deepEqual(r.missing, ['res_cold']);
  // The cold prefix occupies the caster-damage group, so plain spell damage cannot be added on top.
  assert.deepEqual(pickMods(types, ['spell_type', 'spell_type'], { T: 'Cold', attr: 'Intelligence' }).missing, ['spell_type']);
  assert.ok(kitPlan({ attr: 'dex', family: 'Bow', form: 'attack_hit' }).some(([slot, base]) => slot === 'Weapon 2' && /Quiver/.test(base)));
  assert.ok(!kitPlan({ attr: 'str', family: 'Two Hand Mace', form: 'attack_hit' }).some(([slot]) => slot === 'Weapon 2'));
  assert.throws(() => kitPlan({ attr: 'str', family: 'FishingRod', form: 'attack_hit' }), /No weapon kit/);
});

test('kit flasks: life flask reactive, four distinct automatic utility flasks by archetype', () => {
  for (const ctx of [{ attr: 'str', family: 'Two Hand Mace', form: 'attack_hit' }, { attr: 'int', family: 'caster', form: 'damage_over_time' }, { attr: 'int', family: 'minion', form: 'minion' }]) {
    const plan = flaskPlan(ctx);
    assert.deepEqual(plan.map(p => p[0]), ['Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5']);
    assert.equal(plan[0][2], false);
    assert.equal(new Set(plan.map(p => p[1])).size, 5);
    assert.ok(plan.slice(1).every(p => p[2] === true));
  }
  assert.equal(flaskPlan({ attr: 'dex', family: 'Bow', form: 'attack_hit' })[3][1], 'Silver Flask');
  assert.equal(flaskPlan({ attr: 'int', family: 'caster', form: 'spell_hit' })[4][1], 'Diamond Flask');
  assert.match(flaskText('Granite Flask', true), /Implicits: 1\n\{crafted\}Used when Charges reach full$/);
  assert.doesNotMatch(flaskText('Divine Life Flask', false), /Used when/);
});

test('support cap keeps the supports sharing most tags with the skill', async () => {
  const { capSupports } = await import('../scripts/design-generate.mjs');
  const g = { tags: ['spell', 'cold'], types: ['Spell', 'Cold', 'Area'], minion_types: [] };
  const pool = [{ name: 'A', pob_tags: { attack: true } }, { name: 'B', pob_tags: { spell: true, cold: true } }, { name: 'C', pob_tags: { area: true } }];
  assert.deepEqual(capSupports(pool, g, 2).pool.map(s => s.name), ['B', 'C']);
  assert.equal(capSupports(pool, g, 5).capped, 0);
});
