// WP9: rule `skill_source_required` - a skill that needs an entity another skill creates (Lingering Blades, corpses,
// placed mines) must have that source among the prototype's own skill groups, and the source must be a pressed key.
// The requirement pairs are derived from the pinned skill data, so the test checks the derivation, the rule and the
// prototypes of the WP11 stage-1 check run (the run where Blade Blast / Deadeye passed with no blade source at all).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rules, validatePrototype, specFromInspect, deriveSourceCatalog, sourceCatalog, objectsAfter } from '../scripts/mechanic-validate.mjs';
import { gaps } from '../mechanics/gaps.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const protoDir = path.join(root, '..', 'research/lab/designs/wp11-stage1-check/prototypes');
const status = (spec, catalog) => rules.skill_source_required({ ...spec, source_catalog: catalog ?? spec.source_catalog }).status;

// Synthetic skill data in the shape of the knowledge snapshot: one consumer, one source, one unrelated skill.
const synthetic = [
  { id: 'Detonator', name: 'Detonator', types: ['Spell'], description: 'Deals spell damage in an area, and will detonate any of your Lingering Blades it touches.', stat_ids: ['spell_minimum_base_physical_damage'] },
  { id: 'BladeMaker', name: 'Blade Maker', types: ['Spell'], description: 'Ethereal weapons rain from the sky.', stat_ids: ['blade_maker_blade_left_in_ground_for_every_X_volleys', 'maximum_number_of_blades_left_in_ground'] },
  { id: 'Cap', name: 'Spinner', types: ['Spell'], description: 'Spins blades around you.', stat_ids: ['maximum_number_of_spinning_blades'] },
  { id: 'Eater', name: 'Eater', types: ['Spell', 'DestroysCorpse'], description: 'Targets a corpse and explodes it.', stat_ids: [] },
  { id: 'Maker', name: 'Maker', types: ['Spell', 'CreatesCorpse'], description: 'Desecrates the ground, spawning corpses.', stat_ids: [] },
  { id: 'Plain', name: 'Plain', types: ['Spell'], description: 'Deals spell damage to a single enemy.', stat_ids: [] }
];

test('derivation: who needs an entity and who creates it comes from skill types, text and stat ids', () => {
  const c = deriveSourceCatalog(synthetic);
  const blades = c.entities.find(e => e.entity === 'Lingering Blade');
  assert.ok(blades, 'Lingering Blade derived from the consume phrase plus a creating stat id');
  assert.deepEqual(blades.consumers.map(x => x.name), ['Detonator']);
  assert.deepEqual(blades.providers.map(x => x.name), ['Blade Maker']);
  // A cap stat (maximum_number_of_...) counts blades, it does not create them.
  assert.ok(!blades.providers.some(p => p.name === 'Spinner'));
  const corpses = c.entities.find(e => e.entity === 'Corpse');
  assert.deepEqual(corpses.consumers.map(x => x.name), ['Eater']);
  assert.deepEqual(corpses.providers.map(x => x.name), ['Maker']);
  assert.deepEqual(c.requirementsOf('Plain'), []);
  assert.deepEqual(c.requirementsOf('Detonator').map(r => r.entity), ['Lingering Blade']);
  assert.deepEqual([...c.providesOf('Blade Maker')], ['Lingering Blade']);
  assert.deepEqual(objectsAfter('it will detonate any of your Lingering Blades it touches', /^detonat/i), ['Lingering Blades']);
});

test('rule: missing source fails, present source passes, unaccounted button warns', () => {
  const catalog = deriveSourceCatalog(synthetic);
  const group = gems => ({ skills: [{ label: 'Main', gems }], source_catalog: catalog });
  assert.equal(status(group(['Detonator'])), 'fail');
  assert.equal(status(group(['Detonator', 'Blade Maker'])), 'pass');
  assert.equal(status(group(['Eater'])), 'fail');
  assert.equal(status(group(['Eater', 'Maker'])), 'pass');
  assert.equal(status(group(['Plain'])), 'not_applicable');
  assert.equal(status({ source_catalog: catalog }), 'unknown');
  const failed = rules.skill_source_required(group(['Detonator']));
  assert.match(failed.evidence, /needs Lingering Blade/);
  assert.match(failed.evidence, /Blade Maker/);
  assert.equal(failed.gap, 'skill_source_uptime');
  assert.equal(failed.sources.entities[0].provided, false);
  // Button accounting: PoB lists the source as a skill, the estimate must count it as a pressed key.
  const withSource = { ...group(['Detonator', 'Blade Maker']), active_skills: [{ name: 'Detonator', main: true }, { name: 'Blade Maker', aura: true }] };
  assert.equal(status(withSource), 'warn');
  assert.match(rules.skill_source_required(withSource).evidence, /not counted as a pressed key/);
  assert.equal(status({ ...withSource, active_skills: [{ name: 'Detonator', main: true }, { name: 'Blade Maker' }] }), 'pass');
  assert.equal(status({ ...group(['Detonator', 'Blade Maker']), buttons: { pressed: [{ name: 'Detonator' }], utility: [] } }), 'warn');
  assert.equal(status({ ...group(['Detonator', 'Blade Maker']), buttons: { pressed: [{ name: 'Detonator' }, { name: 'Blade Maker' }] } }), 'pass');
});

test('pinned skill data: the derived entities are the ones PoB takes on trust', () => {
  const c = sourceCatalog();
  assert.ok(c, 'knowledge snapshot available');
  const names = c.entities.map(e => e.entity).sort();
  assert.deepEqual(names, ['Corpse', 'Lingering Blade', 'Mine', 'Sentinel']);
  const blades = c.entities.find(e => e.entity === 'Lingering Blade');
  assert.deepEqual(blades.consumers.map(x => x.name), ['Blade Blast']);
  assert.ok(blades.providers.some(p => p.name === 'Bladefall'));
  assert.ok(!blades.providers.some(p => p.name === 'Blade Vortex'), 'Blade Vortex blades are not Lingering Blades');
  const corpses = c.entities.find(e => e.entity === 'Corpse');
  for (const n of ['Detonate Dead', 'Volatile Dead', 'Cremation']) assert.ok(corpses.consumers.some(x => x.name === n), n);
  for (const n of ['Desecrate', 'Unearth']) assert.ok(corpses.providers.some(x => x.name === n), n);
  // Entities the data cannot judge stay out of the rule instead of being guessed.
  assert.ok(c.unjudgeable.some(u => u.entity === 'Steel Shard'));
  assert.equal(status({ skills: [{ gems: ['Blade Blast'] }] }), 'fail');
  assert.equal(status({ skills: [{ gems: ['Blade Blast', 'Bladefall'] }] }), 'pass');
  assert.equal(status({ skills: [{ gems: ['Arc'] }] }), 'not_applicable');
});

test('WP11 stage-1 prototypes: Blade Blast without a blade source fails, the others do not', { skip: !fs.existsSync(protoDir) }, async () => {
  const { inspectBuild } = await import('../scripts/pob.mjs');
  const got = {};
  for (const file of fs.readdirSync(protoDir).filter(f => f.endsWith('.xml')).sort()) {
    const spec = specFromInspect(inspectBuild(fs.readFileSync(path.join(protoDir, file))));
    got[file] = rules.skill_source_required(spec).status;
  }
  assert.equal(got['bladeblast--deadeye.xml'], 'fail', 'the 5.06M DPS prototype detonates blades nobody creates');
  for (const [file, s] of Object.entries(got)) if (file !== 'bladeblast--deadeye.xml') assert.notEqual(s, 'fail', `${file}: ${s}`);
  assert.equal(validatePrototype(specFromInspect(inspectBuild(fs.readFileSync(path.join(protoDir, 'bladeblast--deadeye.xml'))))).valid, false);
});

test('gap registry: the uptime and density of a source are a PoB gap with confidence and an observe plan', () => {
  const gap = gaps.find(g => g.id === 'skill_source_uptime');
  assert.ok(gap, 'skill_source_uptime in the registry');
  assert.equal(gap.pob_status, 'config_assumed');
  assert.ok(gap.confidence, 'confidence stated');
  assert.ok(gap.observe && gap.observe.length > 20, 'observe plan for a game test');
  assert.ok(gap.checks.includes('skill_source_required'));
  assert.equal(gap.model, null, 'no approximate model yet: nothing to mix with PoB numbers');
});
