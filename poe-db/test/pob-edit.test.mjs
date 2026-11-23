import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPob, newPob, exportCode, importCode, inspectBuild, resolvePowerShellHost, smokeEngine } from '../scripts/pob.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-pob-edit-'));
test.after(() => {
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('poe-pob-edit-'));
  fs.rmSync(temp, { recursive: true, force: true });
});
const file = name => path.join(temp, name);
const minimal = {
  tree: { allocate: ['Heart of Thunder'] },
  skills: { add_groups: [{ label: 'Main', main: true, include_in_full_dps: true, gems: [{ name: 'Fireball', level: 20 }, { name: 'Controlled Destruction' }] }] }
};
const sameNumbers = (a, b) => {
  const keys = [...new Set([...Object.keys(a.output), ...Object.keys(b.output)])];
  for (const key of keys) assert.ok(Object.is(a.output[key], b.output[key]) || Math.abs(a.output[key] - b.output[key]) <= 1e-9 * Math.max(1, Math.abs(a.output[key])), `${key}: ${a.output[key]} vs ${b.output[key]}`);
};

test('PowerShell host is resolved (pwsh, then Windows PowerShell 5.1) and the engine starts', () => {
  const host = resolvePowerShellHost({ refresh: true });
  assert.ok(fs.existsSync(host.file));
  assert.match(smokeEngine().lua, /LuaJIT/);
  const saved = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, windir: process.env.windir, ProgramFiles: process.env.ProgramFiles, POE_POWERSHELL: process.env.POE_POWERSHELL };
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    process.env.PATH = temp; process.env.SystemRoot = temp; process.env.ProgramFiles = temp;
    assert.throws(() => resolvePowerShellHost({ refresh: true }), /No PowerShell host found.*POE_POWERSHELL/s);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resolvePowerShellHost({ refresh: true });
  }
});

test('build from scratch -> run -> export-code -> import-code gives the same numbers', { timeout: 180000 }, () => {
  const created = newPob({ className: 'Witch', ascendancy: 'Elementalist', level: 40, changes: minimal, saveXml: file('scratch.xml') });
  assert.equal(created.class, 'Witch');
  assert.equal(created.ascendancy, 'Elementalist');
  assert.equal(created.tree_version, '3_30');
  assert.ok(created.edit_report.tree.allocated[0].points >= 10);
  assert.ok(created.budget.passive_used >= 10 && created.budget.passive_used <= created.budget.passive_available);
  assert.deepEqual(created.budget.disconnected_nodes, []);
  assert.equal(created.groups.length, 1);
  assert.ok(created.applied_supports.some(s => s.id === 'SupportControlledDestruction'));
  assert.ok(created.output.CombinedDPS > 0 && created.output.FullDPS > 0);
  const audit = inspectBuild(fs.readFileSync(file('scratch.xml')));
  assert.equal(audit.tree_version, '3_30');
  assert.equal(audit.level, 40);
  assert.ok(audit.tree_specs[0].nodes >= 11);

  const run = runPob({ input: fs.readFileSync(file('scratch.xml')) });
  sameNumbers(created, run);
  const exported = exportCode(fs.readFileSync(file('scratch.xml')));
  assert.equal(exported.round_trip.ok, true);
  assert.equal(exported.round_trip.bytes_equal, true);
  assert.deepEqual(exported.round_trip.engine.mismatches, []);
  assert.match(exported.code, /^[A-Za-z0-9_=-]+$/);
  const imported = importCode(exported.code, { saveXml: file('imported.xml') });
  assert.equal(imported.import.round_trip.ok, true);
  sameNumbers(run, imported);
  sameNumbers(run, runPob({ input: fs.readFileSync(file('imported.xml')) }));
  assert.throws(() => importCode('<PathOfBuilding/>', { saveXml: file('x.xml') }), /already XML/);
  assert.throws(() => runPob({ input: fs.readFileSync(file('scratch.xml')), saveXml: file('scratch.xml') }), /already exists/);
});

test('--changes edits sets, masteries, jewels, clusters and skill groups through PoB', { timeout: 180000 }, () => {
  newPob({ className: 'Witch', ascendancy: 'Elementalist', level: 40, changes: minimal, saveXml: file('base.xml') });
  const base = fs.readFileSync(file('base.xml'));
  const changes = {
    sets: [{ type: 'tree', action: 'copy', title: 'Act 3 tree', activate: true }, { type: 'skill', action: 'copy', title: 'Act 3 skills', activate: true }, { type: 'item', action: 'new', title: 'Act 3 gear', activate: true }],
    tree: { allocate: ['Shaper of Storms', 61419, 21984], masteries: [{ node: 58816, effect: 53046 }] },
    jewels: [
      { node: 61419, text: 'Rarity: RARE\nTest Jewel\nCobalt Jewel\n+10 to Intelligence\n10% increased Lightning Damage' },
      { node: 21984, text: 'Rarity: MAGIC\nLarge Cluster Jewel\nAdds 8 Passive Skills\nAdded Small Passive Skills grant: 12% increased Lightning Damage\n1 Added Passive Skill is Sadist', allocate: ['Sadist'] }
    ],
    skills: { groups: [{ group: 1, add_gems: [{ name: 'Added Lightning Damage' }], replace_gems: [{ gem: 1, name: 'Arc' }] }], add_groups: [{ label: 'Aura', gems: [{ name: 'Clarity', level: 5 }] }] }
  };
  const edited = runPob({ input: base, changes, saveXml: file('edited.xml') });
  const report = edited.edit_report;
  assert.deepEqual(report.sets.map(s => [s.type, s.title, s.active]), [['tree', 'Act 3 tree', true], ['skill', 'Act 3 skills', true], ['item', 'Act 3 gear', true]]);
  assert.deepEqual(edited.tree_specs.map(s => s.title), ['Default', 'Act 3 tree']);
  assert.equal(edited.selection.tree_spec, 2);
  assert.equal(report.tree.allocated[0].node.ascendancy, 'Elementalist');
  assert.equal(report.tree.masteries[0].effect, 53046);
  assert.equal(report.jewels[1].cluster, true);
  assert.equal(report.jewels[1].allocated[0].node.name, 'Sadist');
  assert.equal(report.skills.modified[0].gems[0].name, 'Arc');
  assert.equal(report.skills.added[0].gems[0].level, 5);
  assert.ok(edited.applied_supports.some(s => s.id === 'SupportAddedLightningDamage'));
  assert.equal(edited.groups[0].gems[0].name, 'Arc');
  const audit = inspectBuild(fs.readFileSync(file('edited.xml')));
  assert.deepEqual(audit.skill_sets.map(s => s.title ?? 'Default'), ['Default', 'Act 3 skills']);
  assert.equal(audit.tree_specs.length, 2);
  // The original tree spec is untouched; recalculating the saved XML gives the same result.
  sameNumbers(edited, runPob({ input: fs.readFileSync(file('edited.xml')) }));

  const removed = runPob({ input: fs.readFileSync(file('edited.xml')), changes: { tree: { deallocate: ['Sadist', 'Shaper of Storms'] }, skills: { remove_groups: [2], groups: [{ group: 1, remove_gems: [3], include_in_full_dps: false }] } } });
  assert.equal(removed.edit_report.tree.deallocated[0].removed.length, 1);
  assert.equal(removed.groups.length, 1);
  assert.equal(removed.groups[0].gems.length, 2);
  assert.equal(removed.output.FullDPS, 0);
  assert.ok(removed.allocated_points.ascendancy_total < edited.allocated_points.ascendancy_total);
});

test('edit errors are fatal and explain the problem', { timeout: 240000 }, () => {
  const base = fs.readFileSync(file('base.xml'));
  const fails = (changes, pattern) => assert.throws(() => runPob({ input: base, changes }), pattern);
  fails({ tree: { allocate: ['Intelligence'] } }, /Ambiguous allocate node name "Intelligence"; use one of the ids/);
  fails({ tree: { allocate: ['No Such Passive'] } }, /No allocate node named/);
  fails({ tree: { allocate: ['Heart of Thunder'] } }, /already allocated/);
  fails({ tree: { allocate: [60118] } }, /has no path/);
  fails({ tree: { quest_points: 0, allocate: ['Deep Wisdom'] }, selection: { character_level: 1 } }, /passive budget exceeded/);
  fails({ tree: { bloodline: 'Oshabi Bloodline', allocate: ['Shaper of Storms', 'Shaper of Flames', 'Shaper of Winter', 'Bringer of Ruin', 'The Vivid Cat'] } }, /ascendancy budget exceeded: \d+ used \(bloodline [1-9]\d*\), 8 available/);
  fails({ tree: { ascendancy: 'Juggernaut' } }, /does not belong to Witch/);
  fails({ tree: { masteries: [{ node: 58816, effect: 1 }] } }, /is not an option of Lightning Mastery/);
  fails({ tree: { allocate: [58816] } }, /is a mastery/);
  fails({ skills: { add_groups: [{ gems: [{ name: 'Firebal' }] }] } }, /not an exact gem name \(closest: Fireball\)/);
  fails({ skills: { add_groups: [{ main: true, gems: [{ name: 'Controlled Destruction' }] }] } }, /needs an active skill gem/);
  fails({ skills: { remove_groups: [5] } }, /unknown socket group 5/);
  fails({ jewels: [{ node: 61419, text: 'Rarity: RARE\nTest\nCobalt Jewel\n+10 to Intelligence' }] }, /not allocated/);
  fails({ sets: [{ type: 'tree', action: 'copy', title: 'Акт 1' }] }, /printable ASCII/);
  fails({ sets: [{ type: 'tree', action: 'copy', from: 9 }] }, /unknown tree spec index 9/);
  fails({ tree: { invented: true } }, /Unsupported tree.invented/);
  const velka = runPob({ input: base, changes: { tree: { bloodline: 'Velka Bloodline' } } });
  assert.ok(velka.edit_report.tree.warnings.some(w => /unconfirmed/.test(w)));
  const over = runPob({ input: base, changes: { tree: { quest_points: 0, allow_over_budget: true, allocate: ['Deep Wisdom'] }, selection: { character_level: 1 } } });
  assert.ok(over.budget.passive_used > over.budget.passive_available);
  assert.throws(() => newPob({ className: 'Witch', level: 101, saveXml: file('bad.xml') }), /--level/);
  assert.throws(() => newPob({ className: 'Witch', ascendancy: 'Slayer', saveXml: file('bad.xml') }), /does not belong to Witch/);
  assert.equal(fs.existsSync(file('bad.xml')), false);
});
