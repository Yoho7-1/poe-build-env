import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveDps, readMetric } from '../scripts/analysis-core.mjs';
import { damageOf, explosionsOf } from '../scripts/analysis-encounter.mjs';
import { itemGrantedTarget, readBuild, generateSupportCandidates, measuredGroup } from '../scripts/analysis-candidates.mjs';
import { runPob, newPob } from '../scripts/pob.mjs';

// ---------- pure: effective DPS ----------
test('effective DPS adds TotalDotDPS when PoB leaves it out of CombinedDPS (average-damage skills)', () => {
  // Essence Drain: CombinedDPS = average hit, debuff DoT only in TotalDotDPS.
  const ed = { CombinedDPS: 9300, AverageDamage: 9300, Speed: 2, TotalDPS: 18600, TotalDot: 137000, TotalDotDPS: 137000 };
  const e = effectiveDps(ed);
  assert.equal(e.basis, 'TotalDotDPS+hit');
  assert.equal(e.value, 18600 + 137000);
  assert.equal(readMetric({ output: ed }, 'dps'), 155600);
  // Without TotalDPS the hit rate is AverageDamage x Speed.
  assert.equal(effectiveDps({ CombinedDPS: 100, AverageDamage: 100, Speed: 3, TotalDotDPS: 1000 }).value, 1300);
  // Normal skill: PoB already includes the DoT (Combined >= TotalDotDPS).
  const da = { CombinedDPS: 104041, TotalDot: 104041, TotalDotDPS: 104041 };
  assert.deepEqual([effectiveDps(da).basis, effectiveDps(da).value], ['CombinedDPS', 104041]);
  assert.equal(effectiveDps({ CombinedDPS: 5000 }).basis, 'CombinedDPS');
});

test('encounter damage reports the DPS basis and uses the larger of FullDPS and effective DPS', () => {
  const life = { value: 155600, basis: 'test' };
  const ed = damageOf({ CombinedDPS: 9300, AverageDamage: 9300, Speed: 2, TotalDPS: 18600, TotalDotDPS: 137000, FullDPS: 0 }, life);
  assert.equal(ed.dps_basis, 'TotalDotDPS+hit');
  assert.equal(ed.best_dps, 155600);
  assert.equal(ed.time_to_kill_s, 1);
  assert.match(ed.time_to_kill_basis, /^TotalDotDPS\+hit/);
  const full = damageOf({ CombinedDPS: 1000, FullDPS: 5000 }, life);
  assert.deepEqual([full.dps_basis, full.best_dps], ['FullDPS', 5000]);
  const main = damageOf({ CombinedDPS: 8000, FullDPS: 5000 }, life);
  assert.deepEqual([main.dps_basis, main.best_dps], ['CombinedDPS', 8000]);
});

// ---------- pure: explosions ----------
test('on-kill explosions are scaled by the encounter enemy life, or marked not_modelled without it', () => {
  const mods = [{ source: 'Tree:37127', source_name: 'Profane Bloom', type: 'Chaos', amount: 25, chance: 0.5, conditions: ['enemy:Cursed'] },
    { source: 'Item:3:Hinekora', type: 'Fire', amount: 250, chance: 0.1, conditions: [] }];
  const x = explosionsOf(mods, { value: 200000, basis: 'test' });
  assert.equal(x.method, 'base_damage_from_enemy_life');
  assert.deepEqual(x.rows.map(r => [r.damage_type, r.damage_per_explosion, r.expected_damage_per_kill, r.requires.join()]),
    [['Chaos', 50000, 25000, 'enemy cursed'], ['Fire', 500000, 50000, '']]);
  const range = explosionsOf(mods.slice(0, 1), { range: [100000, 200000] });
  assert.deepEqual(range.rows[0].expected_damage_per_kill_range, [12500, 25000]);
  assert.equal(explosionsOf(mods, null).method, 'not_modelled');
  assert.equal(explosionsOf([], { value: 1 }), null);
});

// ---------- pure: item-granted target lookup ----------
test('a support-only group targets the item-granted active skill in the same slot', () => {
  const info = g => ({ DeathAura: { is_support: false }, SupportEfficacy: { is_support: true } })[g.skill_id] ?? null;
  const supports = { index: 2, slot: 'Body Armour', enabled: true, source: null, gems: [{ skill_id: 'SupportEfficacy', enabled: true }] };
  const granted = { index: 8, slot: 'Body Armour', enabled: true, source: "Item:10:Death's Oath, Astral Plate", gems: [{ skill_id: 'DeathAura', enabled: true }] };
  const other = { index: 3, slot: 'Helmet', enabled: true, source: "Item:4:x", gems: [{ skill_id: 'DeathAura', enabled: true }] };
  assert.equal(itemGrantedTarget({ groups: [supports, other, granted] }, supports, info), granted);
  assert.equal(itemGrantedTarget({ groups: [supports, other] }, supports, info), null);
});

// ---------- engine: item-granted groups ----------
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-dps-basis-'));
test.after(() => { if (path.basename(temp).startsWith('poe-dps-basis-')) fs.rmSync(temp, { recursive: true, force: true }); });
const deathsOath = `Rarity: UNIQUE
Death's Oath
Astral Plate
Selected Variant: 3
Sockets: R-R-R-R-R-R
Implicits: 1
+12% to all Elemental Resistances
Trigger Level 20 Death Aura when Equipped
+45 to all Attributes
12% increased Attack Speed
200% increased Armour
+65 to maximum Life
1% of Attack Damage Leeched as Life
You take 450 Chaos Damage per second for 3 seconds on Kill`;

test('item-granted skill: FullDPS toggle, support candidates measured on the granted skill, applied_supports', { timeout: 600000 }, () => {
  const xml = path.join(temp, 'oath.xml');
  newPob({ className: 'Witch', ascendancy: 'Occultist', level: 90, saveXml: xml, changes: {
    replace_items: [{ slot: 'Body Armour', text: deathsOath }],
    skills: { add_groups: [{ label: 'Death Aura supports', slot: 'Body Armour', gems: [{ name: 'Efficacy', level: 20, quality: 20 }, { name: 'Controlled Destruction', level: 20, quality: 20 }] }] } } });
  const build = readBuild(xml);
  const granted = build.groups.find(g => /^Item:/.test(g.source ?? '') && g.gems.some(x => x.skill_id === 'DeathAura'));
  assert.ok(granted, 'PoB created the item-granted Death Aura group');
  const support = build.groups.find(g => g.label === 'Death Aura supports');

  // 3: only include_in_full_dps may change on an item-granted group.
  const toggled = runPob({ input: fs.readFileSync(xml), changes: { skills: { groups: [{ group: granted.index, include_in_full_dps: true }] } } });
  assert.equal(toggled.edit_report.skills.modified[0].item_granted, true);
  assert.ok(toggled.output.FullDPS > 0, 'FullDPS includes the granted Death Aura');
  assert.throws(() => runPob({ input: fs.readFileSync(xml), changes: { skills: { groups: [{ group: granted.index, enabled: false }] } } }), /only include_in_full_dps/);

  // 2: candidates for the support-only group are measured on the granted skill.
  assert.equal(measuredGroup(xml, support.index), granted.index);
  const gen = generateSupportCandidates({ file: xml, group: support.index, search: 'Void Manipulation' });
  assert.equal(gen.active_skill.item_granted, true);
  assert.equal(gen.measured_group, granted.index);
  assert.ok(gen.candidates.length >= 1);
  const measured = runPob({ input: fs.readFileSync(xml), changes: { selection: { main_socket_group: granted.index }, ...gen.candidates[0].changes } });
  const applied = measured.applied_supports.map(s => s.name);
  assert.ok(applied.includes(gen.candidates[0].generated.support) && applied.includes('Efficacy'), `applied: ${applied}`);
  assert.ok(measured.output.CombinedDPS > 0);
  // explode_mods are exported (empty without an explosion source).
  assert.ok(Array.isArray(measured.explode_mods));
});
