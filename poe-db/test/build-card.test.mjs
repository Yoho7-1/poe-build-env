import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { damageProfile, defenseProfile, resourceProfile, architectureSplit, signatureOf, saveCard, listCards, cardCommand, buttonEstimate, flaskButtons, classifySkill, conversionLinks, conversionProfile, diffCards } from '../scripts/build-card.mjs';

test('damage profile separates hit, skill DoT and ailments and finds the main type', () => {
  const dot = damageProfile({ CombinedDPS: 1000, TotalDPS: 100, TotalDotDPS: 900, TotalDot: 900, ColdDot: 900, ColdHitAverage: 50 });
  assert.equal(dot.primary_form, 'skill_dot'); assert.equal(dot.primary_type, 'Cold'); assert.equal(dot.parts.hit, 0.1);
  const poison = damageProfile({ CombinedDPS: 2000, TotalDPS: 500, TotalDotDPS: 1500, TotalPoisonDPS: 1500 });
  assert.equal(poison.primary_form, 'poison'); assert.equal(poison.parts.skill_dot, 0);
  const hit = damageProfile({ CombinedDPS: 5000, TotalDPS: 5000, FireHitAverage: 300, LightningHitAverage: 100 });
  assert.equal(hit.primary_form, 'hit'); assert.equal(hit.types.Fire, 0.75);
  const mixed = damageProfile({ CombinedDPS: 1000, TotalDotDPS: 600, TotalDot: 300, TotalIgniteDPS: 300 });
  assert.equal(mixed.primary_form, 'mixed');
  assert.equal(damageProfile({}).primary_form, null);
});

test('defense profile names the pool and the layers by stated thresholds', () => {
  const d = defenseProfile({ Life: 6000, EnergyShield: 2000, Armour: 20000, Evasion: 1000, BlockChance: 50, SpellBlockChance: 10, EffectiveSpellSuppressionChance: 100,
    LifeRecoup: 10, LifeRegenRecovery: 400, ChaosResist: 20, FreezeAvoidChance: 100, PhysicalMaximumHitTaken: 9000, FireMaximumHitTaken: 12000, ColdMaximumHitTaken: 12000,
    LightningMaximumHitTaken: 12000, ChaosMaximumHitTaken: 7000, TotalEHP: 50000 }, ['Mind Over Matter']);
  assert.equal(d.pool, 'life');
  assert.deepEqual(d.layers, ['armour', 'attack_block', 'spell_suppression', 'mind_over_matter', 'life_recoup', 'life_regen', 'freeze_immunity', 'chaos_res_positive']);
  assert.equal(d.weakest_type, 'Chaos');
  assert.equal(defenseProfile({ Life: 1, EnergyShield: 8000 }, ['Chaos Inoculation']).pool, 'ci_es');
  assert.equal(defenseProfile({ Life: 4000, EnergyShield: 3500 }).pool, 'hybrid');
  assert.equal(resourceProfile({ ManaRegenRecovery: 50, ManaPerSecondCost: 80, Mana: 1000 }).sustained, false);
});

test('architecture split keeps config assumptions apart and lists bridge nodes', () => {
  const split = architectureSplit({ analysis: 'ablation', file: 'x/b.xml', contract: { input_sha256: 'h' }, rows: [
    { label: 'Weapon', kind: 'items', tier: 'core' }, { label: 'Support', kind: 'supports', tier: 'minor' }, { label: 'Flask', kind: 'items', tier: 'negligible' },
    { label: 'Bridge', kind: 'tree', tier: 'minor', with_dependents: { other_key_nodes: ['X'], offense_loss_pct: 37, points: 16 } }, { label: 'Iso', kind: 'tree', tier: 'major' },
    { label: 'chilled', kind: 'config', tier: 'major', offense_loss_pct: 15 }, { label: 'err', kind: 'items', tier: 'error', error: 'x' }] });
  assert.deepEqual(split.core, ['Weapon']); assert.deepEqual(split.implementation, ['Support', 'Bridge', 'Iso']); assert.deepEqual(split.replaceable, ['Flask']);
  assert.deepEqual(split.bridges, [{ node: 'Bridge', branch_dps_loss_pct: 37, points: 16 }]); assert.equal(split.assumption_sensitivity[0].dps_loss_pct, 15);
  assert.equal(architectureSplit({ analysis: 'ablation', plan: true }), null);
});

test('signature depends on structure only and is order-independent', () => {
  const f = { class: 'Witch', ascendancy: 'Occultist', main_skill: 'Vortex', primary_form: 'skill_dot', primary_type: 'Cold', defense_pool: 'life', defense_layers: ['a', 'b'], keystones: ['X', 'Y'], uniques: ['U'] };
  assert.equal(signatureOf(f), signatureOf({ ...f, defense_layers: ['b', 'a'], keystones: ['Y', 'X'] }));
  assert.notEqual(signatureOf(f), signatureOf({ ...f, main_skill: 'Cold Snap' }));
  assert.notEqual(signatureOf(f), signatureOf({ ...f, damage_scope: 'minion' }));
  assert.match(signatureOf(f), /^[0-9a-f]{16}$/);
});

test('card store saves by PoB hash and reports structural duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-cards-'));
  try {
    const card = (sha, sig) => ({ signature: sig, identity: { pob_sha256: sha, file: `${sha}.xml` }, features: { class: 'Witch' }, damage: { effective_dps: 1 }, defense: { ehp: 2 } });
    assert.deepEqual(saveCard(card('a'.repeat(64), 's1'), dir).same_signature, []);
    assert.deepEqual(saveCard(card('b'.repeat(64), 's1'), dir).same_signature, ['aaaaaaaaaaaaaaaa.json']);
    assert.equal(listCards(dir).length, 2);
    assert.equal(cardCommand(['list', '--dir', dir]).cards.length, 2);
    assert.throws(() => cardCommand([]), /Use build card/);
    assert.throws(() => cardCommand(['x.xml', '--trust', 'maybe']), /--trust/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attack damage types are read from the per-hand values PoB keeps for attacks', () => {
  const d = damageProfile({ CombinedDPS: 1000, TotalDPS: 1000, 'MainHand:PhysicalHitAverage': 900, 'MainHand:FireHitAverage': 100, 'OffHand:PhysicalHitAverage': 300 });
  assert.equal(d.primary_type, 'Physical'); assert.equal(d.types.Fire, 0.077);
});

// Fixtures shaped like the PoB export (pob-worker active_skills / conversion; Lua empty tables arrive as []).
const skillsFixture = [
  { name: 'Vortex', group: 1, main: true, cooldown: true },
  { name: 'Cold Snap', group: 2, cooldown: true },
  { name: 'Malevolence', group: 3, aura: true, reserves: true, buff: true },
  { name: 'Flame Dash', group: 4, movement: true, cooldown: true },
  { name: 'Steelskin', group: 4, guard: true, buff: true },
  { name: 'Frost Wall', group: 5, triggered: true },
  { name: 'Summon Stone Golem', group: 6, minion: true, golem: true, reserves: true },
  { name: 'Raise Spectre', group: 6, minion: true },
  { name: 'Vortex', group: 7, triggered: true },
  { name: 'Broken', group: 8, disabled: true },
  { name: 'Spell Totem Arc', group: 9, totem: true }
];
const flaskFixture = [
  { slot: 'Flask 1', name: 'Divine Life Flask', base: 'Divine Life Flask', rarity: 'MAGIC', text: 'Rarity: MAGIC\nDivine Life Flask' },
  { slot: 'Flask 2', name: 'Quicksilver Flask', base: 'Quicksilver Flask', rarity: 'MAGIC', text: 'Rarity: MAGIC\nQuicksilver Flask\nUsed when Charges reach full' },
  { slot: 'Flask 3', name: 'Granite Flask', base: 'Granite Flask', rarity: 'MAGIC', text: 'Rarity: MAGIC\nGranite Flask' },
  { slot: 'Flask 4', name: 'Jade Flask', base: 'Jade Flask', rarity: 'MAGIC', text: '' }
];

test('button estimate counts pressed and utility skills, skips automatic ones and states uncertainty', () => {
  const b = buttonEstimate(skillsFixture, flaskFixture);
  assert.deepEqual(b.skills.pressed.map(s => s.name), ['Vortex', 'Cold Snap', 'Spell Totem Arc']);
  assert.deepEqual(b.skills.utility.map(s => [s.name, s.reason]), [['Flame Dash', 'movement'], ['Steelskin', 'guard']]);
  assert.deepEqual(b.skills.auto.map(s => s.reason), ['aura', 'triggered', 'persistent_minion']);
  assert.deepEqual(b.skills.uncertain.map(s => s.name), ['Raise Spectre']);
  assert.deepEqual(b.skills.ignored.map(s => s.name), ['Broken']);
  // A skill in a pressed group and a triggered copy counts once, as pressed.
  assert.equal(b.skills.pressed.filter(s => s.name === 'Vortex').length, 1);
  assert.equal(b.flasks.manual.length, 2); assert.equal(b.flasks.auto[0].reason, 'used_when_mod'); assert.equal(b.flasks.reactive.length, 1);
  assert.equal(b.estimate, 3 + 2 + 2); assert.equal(b.minimum, 3); assert.equal(b.maximum, 7 + 1 + 1);
  assert.ok(b.uncertainty.some(u => /macro/.test(u)));
  assert.equal(buttonEstimate(undefined).estimate, null);
  assert.match(buttonEstimate(undefined).reason, /unavailable/);
});

test('Mageblood makes magic utility flasks automatic, life flasks stay reactive', () => {
  const f = flaskButtons(flaskFixture, { mageblood: true });
  assert.deepEqual(f.manual, []); assert.equal(f.auto.length, 3); assert.equal(f.reactive.length, 1);
  assert.equal(classifySkill({ name: 'Blood Rage', buff: true }).kind, 'utility');
  assert.equal(classifySkill({ name: 'Herald of Ice', herald: true, reserves: true }).kind, 'auto');
});

const conversionFixture = {
  skill: { Physical: { mult: 1, conversion: [], gain: [] }, Lightning: { mult: 1, conversion: [], gain: [] }, Cold: { mult: 1, conversion: [], gain: [] }, Fire: { mult: 1, conversion: [], gain: [] }, Chaos: { mult: 1, conversion: [], gain: [] } },
  main_hand: { Physical: { mult: 0.4, conversion: { Lightning: 0.5, Fire: 0.1 }, gain: { Cold: 0.2 } }, Lightning: { mult: 0.5, conversion: { Cold: 0.5 }, gain: [] }, Cold: { mult: 1, conversion: [], gain: [] }, Fire: { mult: 1, conversion: [], gain: [] }, Chaos: { mult: 1 } }
};

test('conversion profile reports PoB links and chains without recomputing them', () => {
  const p = conversionProfile(conversionFixture).value;
  assert.equal(p.basis, 'main_hand'); assert.equal(p.source, 'pob_conversion_table');
  assert.deepEqual(p.links.map(l => [l.from, l.to, l.kind, l.pct].join(':')), ['Physical:Lightning:convert:50', 'Physical:Cold:gain_as:20', 'Physical:Fire:convert:10', 'Lightning:Cold:convert:50']);
  assert.deepEqual(p.chains, ['Physical > Lightning > Cold', 'Physical > Cold', 'Physical > Fire']);
  assert.deepEqual(p.unconverted_share, { Physical: 0.4, Lightning: 0.5 });
  assert.ok(p.has_conversion && p.has_gain_as);
  assert.equal(p.other_bases[0].basis, 'skill');
  const none = conversionProfile({ skill: conversionFixture.skill }).value;
  assert.deepEqual(none.links, []); assert.equal(none.has_conversion, false);
  assert.equal(conversionProfile(undefined).value, null);
  assert.match(conversionProfile({ skill: conversionFixture.skill }, 'minion').reason, /minion/);
  assert.equal(conversionLinks([]), null);
});

const cardV1 = { schema_version: 1, kind: 'build_card', signature: 's1', identity: { file: 'a.xml', scenario: 'sustained', level: 95, versions: { pob: '2.68.1' } },
  features: { class: 'Witch', ascendancy: 'Occultist', main_skill: 'Vortex', damage_scope: 'player', primary_form: 'skill_dot', primary_type: 'Cold', defense_pool: 'life', defense_layers: ['armour'], keystones: ['Mind Over Matter'], uniques: [] },
  skills: { main: { name: 'Vortex', supports: ['Swift Affliction', 'Efficacy'] }, active: [{ name: 'Vortex' }, { name: 'Flame Dash' }] },
  damage: { effective_dps: 1000, parts: { hit: 0.1, skill_dot: 0.9 }, types: { Cold: 1 } },
  defense: { ehp: 30000, life: 5000, max_hit: { Physical: 8000, Chaos: 6000 }, resists: { Fire: 75, Chaos: 0 } },
  tree: { ascendancy_notables: ['Frigid Wake'], notables: 30, points: { passive: 120 } }, items: { equipped: [{ slot: 'Helmet', name: 'A' }, { slot: 'Boots', name: 'B' }] },
  assumptions: [{ key: 'conditionEnemyChilled', value: true }] };
const cardV2 = { ...structuredClone(cardV1), schema_version: 2, signature: 's2',
  features: { ...cardV1.features, keystones: ['Mind Over Matter', 'Elemental Overload'], uniques: ['Mageblood'], buttons: 5 },
  skills: { main: { name: 'Vortex', supports: ['Swift Affliction', 'Elemental Focus'] }, active: [{ name: 'Vortex' }, { name: 'Cold Snap' }] },
  damage: { effective_dps: 1500, parts: { hit: 0.2, skill_dot: 0.8 }, types: { Cold: 1 }, conversion: conversionProfile(conversionFixture).value },
  defense: { ehp: 27000, life: 4800, max_hit: { Physical: 8000, Chaos: 7000 }, resists: { Fire: 75, Chaos: 20 } },
  buttons: buttonEstimate(skillsFixture, flaskFixture), items: { equipped: [{ slot: 'Helmet', name: 'C' }, { slot: 'Boots', name: 'B' }] }, assumptions: [] };

test('card diff lists structural and numeric changes and reads v1 cards without failing', () => {
  const d = diffCards(cardV1, cardV2);
  assert.equal(d.same_signature, false);
  assert.deepEqual(d.sets.keystones, { added: ['Elemental Overload'], removed: [] });
  assert.deepEqual(d.sets.supports, { added: ['Elemental Focus'], removed: ['Efficacy'] });
  assert.deepEqual(d.sets.active_skills, { added: ['Cold Snap'], removed: ['Flame Dash'] });
  assert.deepEqual(d.items, [{ slot: 'Helmet', a: 'A', b: 'C' }]);
  assert.equal(d.damage.effective_dps.pct, 50); assert.equal(d.damage.parts.hit, 0.1);
  assert.equal(d.defense.ehp.delta, -3000); assert.equal(d.defense.max_hit.Chaos.delta, 1000); assert.equal(d.defense.resists.Chaos.delta, 20);
  assert.equal(d.buttons.status, 'not_in_card'); assert.equal(d.buttons.a, 'not_in_card'); assert.equal(d.buttons.b, 7);
  assert.equal(d.damage.conversion.status, 'not_in_card');
  assert.deepEqual(d.assumptions, [{ key: 'conditionEnemyChilled', a: true, b: null }]);
  assert.ok(d.notes.some(n => /schema_version/.test(n)));
  const same = diffCards(cardV2, structuredClone(cardV2));
  assert.equal(same.structural_changes, 0); assert.equal(same.buttons.estimate.delta, 0); assert.deepEqual(same.damage.conversion.added, []);
  const noConv = structuredClone(cardV2); noConv.damage.conversion = null; noConv.damage.conversion_reason = 'PoB gives no conversion table for the main skill';
  const c = diffCards(noConv, cardV2).damage.conversion;
  assert.equal(c.added.length, 4); assert.equal(c.reason.a, 'PoB gives no conversion table for the main skill');
  assert.throws(() => diffCards({ kind: 'x' }, cardV2), /build_card/);
});

test('card diff CLI reads card JSON by path or by name in the card directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-cards-diff-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(cardV1)); fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(cardV2));
    assert.equal(cardCommand(['diff', 'a.json', path.join(dir, 'b.json'), '--dir', dir]).analysis, 'card_diff');
    assert.throws(() => cardCommand(['diff', 'a.json', '--dir', dir]), /build card diff/);
    assert.throws(() => cardCommand(['diff', 'a.xml', 'b.xml', '--dir', dir]), /card JSON/);
    const listed = listCards(dir);
    assert.deepEqual(listed.map(c => [c.schema_version, c.buttons]), [[1, null], [2, 7]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
