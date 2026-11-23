import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadCatalog, labRoot, digest } from '../catalog.mjs';
import { createSession, pool, step, replay, observe, counts, firstWeight, random } from '../engine.mjs';
import { practice } from '../practice.mjs';
import { cli, read, saveSnapshot } from '../cli.mjs';

const catalog = loadCatalog();
const start = read(path.join(labRoot, 'examples/amulet-start.json'));
const exercise = read(path.join(labRoot, 'examples/amulet-exercise.json'));

function toyCatalog() {
  const definition = (id, generation_type, weight, extra = {}) => ({ id, generation_type, domain: 'item', name: id, text: id,
    groups: [id], required_level: 1, is_essence_only: false, adds_tags: [], implicit_tags: [],
    spawn_weights: [{ tag: 'special', weight }, { tag: 'default', weight: 9999 }], generation_weights: [],
    stats: [{ id: 'test_stat', min: 10, max: 12 }], ...extra });
  const mods = [
    definition('prefix-a', 'prefix', 100),
    definition('suffix-b', 'suffix', 300, { generation_weights: [{ tag: 'special', weight: 50 }, { tag: 'default', weight: 0 }] }),
    definition('blocked-first-zero', 'prefix', 0),
    definition('too-high', 'prefix', 1000, { required_level: 90 }),
    definition('essence-only', 'prefix', 1000, { is_essence_only: true }),
    definition('crafted', 'prefix', 1000, { domain: 'crafted' }),
  ];
  return { bases: new Map([['toy', { id: 'toy', name: 'Toy', domain: 'item', release_state: 'released', tags: ['special', 'default'], implicits: [] }]]),
    mods: new Map(mods.map(mod => [mod.id, mod])), contract: 'toy-contract' };
}
const toyInput = { base: 'Toy', item_level: 50, rarity: 'rare', mods: [], seed: 0 };

test('ordered weights preserve first matching zero and percent generation multipliers', () => {
  const tags = new Set(['special', 'default']);
  assert.equal(firstWeight([{ tag: 'absent', weight: 500 }, { tag: 'special', weight: 0 }, { tag: 'default', weight: 9000 }], tags, 1), 0);
  const toy = toyCatalog(), session = createSession(toy, toyInput), result = pool(toy, session.item);
  assert.deepEqual(result.rows.map(row => [row.id, row.weight_units]), [['prefix-a', 10000], ['suffix-b', 15000]]);
  assert.equal(result.total_weight_units, 25000);
});

test('weighted draws reproduce hand-calculated 40/60 odds, with all seed values valid', () => {
  const toy = toyCatalog();
  let prefixes = 0;
  for (let seed = 0; seed < 4000; seed++) {
    const next = step(toy, createSession(toy, { ...toyInput, seed }), 'Exalted Orb');
    prefixes += next.item.mods[0].id === 'prefix-a';
    assert.ok(next.item.mods[0].stats[0].value >= 10 && next.item.mods[0].stats[0].value <= 12);
  }
  assert.ok(Math.abs(prefixes / 4000 - 0.4) < 0.035, `observed ${prefixes / 4000}`);
  assert.equal(random(0).int(1), 0);
  assert.ok(Number.isInteger(random(0xffffffff).int(0x100000000)));
});

test('added tags and implicit tags modify the next pool; groups block all related tiers', () => {
  const toy = toyCatalog();
  toy.mods.get('prefix-a').adds_tags = ['has-prefix'];
  toy.mods.get('suffix-b').generation_weights = [{ tag: 'has-prefix', weight: 0 }, { tag: 'default', weight: 100 }];
  const initial = createSession(toy, { ...toyInput, mods: ['prefix-a'] });
  assert.equal(pool(toy, initial.item).rows.length, 0);
  assert.ok(pool(toy, initial.item).tags.includes('has-prefix'));
  toy.bases.get('toy').implicits = ['prefix-a'];
  const withImplicit = createSession(toy, toyInput);
  assert.ok(!pool(toy, withImplicit.item).rows.some(row => row.id === 'suffix-b'));
  assert.equal(observe(toy, withImplicit).item.mods.length, 0, 'implicit must not become an explicit modifier');
  toy.mods.get('suffix-b').groups = ['prefix-a'];
  assert.throws(() => createSession(toy, { ...toyInput, mods: ['prefix-a', 'suffix-b'] }), /Conflicting/);
});

test('real source level gates, capacities and modifier groups apply to all selected bases', () => {
  const item = createSession(catalog, start).item;
  const eligible = pool(catalog, item).rows;
  assert.ok(!eligible.some(row => row.groups.includes('IncreasedLife')));
  const low = createSession(catalog, { base: 'Amber Amulet', item_level: 1, rarity: 'rare', mods: [], seed: 1 });
  assert.ok(pool(catalog, low.item).rows.every(row => row.required_level <= 1));
  assert.throws(() => createSession(catalog, { ...start, item_level: 1 }), /level too low/);
  assert.throws(() => createSession(catalog, { ...start, mods: ['IncreasedLife4', 'IncreasedLife5'] }), /Conflicting/);
  for (const base of catalog.bases.values()) {
    let session = createSession(catalog, { base: base.id, item_level: 86, rarity: 'rare', mods: [], seed: 42 });
    for (let i = 0; i < 6; i++) session = step(catalog, session, 'Exalted Orb');
    assert.deepEqual(counts(catalog, session.item), { prefix: 3, suffix: 3 });
    assert.throws(() => step(catalog, session, 'Exalted Orb'), /open affix/);
    assert.equal(replay(catalog, session).revision, 6);
  }
});

test('Augmentation respects magic slots; Regal upgrades before selecting the new modifier', () => {
  let session = createSession(catalog, start);
  const magicPool = pool(catalog, session.item).rows;
  assert.ok(magicPool.length && magicPool.every(row => row.generation_type === 'suffix'));
  session = step(catalog, session, 'Orb of Augmentation');
  assert.deepEqual(counts(catalog, session.item), { prefix: 1, suffix: 1 });
  assert.throws(() => step(catalog, session, 'Orb of Augmentation'), /budget exhausted|open affix/);
  const regalPool = pool(catalog, session.item, { rarity: 'rare' }).rows;
  assert.ok(regalPool.some(row => row.generation_type === 'prefix') && regalPool.some(row => row.generation_type === 'suffix'));
  const result = step(catalog, session, 'Regal Orb');
  assert.equal(result.item.rarity, 'rare'); assert.equal(result.item.mods.length, 3);
  assert.ok(result.item.mods.some(roll => roll.id === 'IncreasedLife5'));
});

test('illegal actions are atomic, spend nothing and do not advance RNG', () => {
  const session = createSession(catalog, start), before = digest(session);
  for (const action of ['Chaos Orb', 'Essence', 'Exalted Orb', 'Orb of Scouring']) assert.throws(() => step(catalog, session, action));
  assert.equal(digest(session), before);
  const legal = observe(catalog, session);
  assert.equal(digest(session), before, 'observing actions must not consume random draws');
  assert.equal(legal.actions.find(row => row.action === 'Exalted Orb').legal, false);
  assert.equal(legal.actions.find(row => row.action === 'Regal Orb').legal, true);
});

test('Annulment preserves rarity, Divine preserves identities, Scouring preserves base', () => {
  const input = { ...start, budget: null, mods: ['IncreasedLife5', 'Strength1'] };
  let session = createSession(catalog, input);
  const divined = step(catalog, session, 'Divine Orb');
  assert.deepEqual(divined.item.mods.map(mod => mod.id), session.item.mods.map(mod => mod.id));
  assert.equal(divined.item.rarity, 'magic');
  session = step(catalog, session, 'Orb of Annulment');
  session = step(catalog, session, 'Orb of Annulment');
  assert.equal(session.item.rarity, 'magic'); assert.equal(session.item.mods.length, 0);
  assert.throws(() => step(catalog, session, 'Orb of Annulment'), /nonempty/);
  const scoured = step(catalog, session, 'Orb of Scouring');
  assert.equal(scoured.item.rarity, 'normal'); assert.equal(scoured.item.base_id, session.item.base_id);
  assert.throws(() => step(catalog, scoured, 'Orb of Augmentation'), /magic/);
});

test('replay detects edited rolls, state, spend, history and contract', () => {
  let saved = createSession(catalog, start);
  for (const action of exercise.actions) saved = step(catalog, saved, action);
  assert.deepEqual(replay(catalog, saved), saved);
  const edits = [
    s => { s.spent['Exalted Orb'] = 1; },
    s => { s.rng_state = (s.rng_state + 1) >>> 0; },
    s => { s.history[0].effect.added_mod = 'fake'; },
    s => { s.item.mods[0].stats[0].value = 70; },
    s => { s.item.base_id = 'Metadata/Items/Rings/Ring4'; },
    s => { s.contract = 'other'; },
  ];
  // Force the roll edit to be different, independent of this seed's actual roll.
  edits[3] = s => { s.item.mods[0].stats[0].value = s.item.mods[0].stats[0].value === 70 ? 71 : 70; };
  for (const edit of edits) { const changed = structuredClone(saved); edit(changed); assert.throws(() => replay(catalog, changed)); }
});

test('unknown mechanics, malformed target/stat data and malformed budgets fail closed', () => {
  for (const extra of [{ influenced: true }, { fractured: true }, { quality: 20 }, { typo: 1 }]) assert.throws(() => createSession(catalog, { ...start, ...extra }), /Unsupported/);
  assert.throws(() => createSession(catalog, { ...start, base: 'Large Cluster Jewel' }), /coverage/);
  for (const budget of [{ 'Regal Orb': -1 }, { 'Chaos Orb': 2 }, { 'Regal Orb': null }]) assert.throws(() => createSession(catalog, { ...start, budget }));
  for (const target of [{}, { typo: [] }, { stats: [] }, { all_mods: ['invented'] }, { stats: [{ id: 'invented', min: 1 }] }]) assert.throws(() => createSession(catalog, { ...start, target }));
  const modified = createSession(catalog, start); modified.item.mods[0].stats[0].id = 'additional_strength';
  assert.throws(() => step(catalog, modified, 'Regal Orb'), /Stat identity/);
  const unlimited = createSession(catalog, { ...start, budget: null });
  assert.equal(unlimited.initial.budget, null);
});

test('target scoring uses actual explicit rolls, with implicit stats excluded', () => {
  const target = { stats: [{ id: 'base_maximum_life', min: 70 }] };
  const session = createSession(catalog, { ...start, target });
  assert.equal(observe(catalog, session).target.met, true);
  const belt = createSession(catalog, { base: 'Leather Belt', item_level: 86, rarity: 'rare', mods: [], seed: 42, target });
  assert.equal(observe(catalog, belt).target.met, false);
  assert.equal(observe(catalog, belt).target.checks[0].actual, 0);
});

test('batch accounting includes failures, rejects unsupported plans and is reproducible', () => {
  const result = practice(catalog, exercise, { episodes: 40, seed: 7 });
  assert.deepEqual(practice(catalog, exercise, { episodes: 40, seed: 7 }), result);
  assert.equal(Object.values(result.outcomes).reduce((a, b) => a + b, 0), 40);
  assert.equal(result.outcomes.action_rejected, 0);
  assert.equal(result.currency_spent_total['Regal Orb'], 40);
  assert.ok(result.currency_spent_total['Exalted Orb'] <= 120);
  const rejected = practice(catalog, { ...exercise, actions: ['Exalted Orb'] }, { episodes: 10 });
  assert.equal(rejected.outcomes.action_rejected, 10);
  assert.equal(rejected.currency_spent_total['Exalted Orb'], 0);
  assert.throws(() => practice(catalog, { ...exercise, actions: ['Chaos Orb'] }));
  const alreadyMet = practice(catalog, { ...exercise, start: { ...exercise.start, target: { all_mods: ['IncreasedLife5'] } } }, { episodes: 10 });
  assert.equal(alreadyMet.outcomes.success, 10); assert.equal(alreadyMet.steps_per_episode.mean, 0);
});

test('pool truncation retains the full denominator and portable CLI never writes implicitly', () => {
  const result = cli(['pool', '--base', 'Amber Amulet', '--ilvl', '86', '--match', 'IncreasedLife', '--limit', '1']);
  assert.equal(result.total_candidates, 264);
  assert.equal(result.total_weight_units, 21465000);
  assert.equal(result.matched_candidates, 9); assert.equal(result.omitted_matches, 8);
  assert.ok(result.matched_probability > result.rows[0].probability);
  assert.ok(Math.abs(result.rows[0].probability - 100000 / 21465000) < 1e-12);
  const child = spawnSync(process.execPath, [path.join(labRoot, 'cli.mjs'), 'new', '--file', path.join(labRoot, 'examples/amulet-start.json')], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).session.revision, 0);
  assert.throws(() => cli(['pool', '--base', 'Amber Amulet', '--ilvl', '86', '--limit', '1.5']));
  assert.throws(() => cli(['pool', '--base', 'Amber Amulet', '--ilvl', '86', '--unknown', '1']));
});

test('saving is opt-in, confined to runs, and cannot overwrite a prior snapshot', () => {
  const name = `test-${process.pid}-${Date.now()}.json`;
  let saved;
  try {
    assert.throws(() => saveSnapshot('../escape.json', {}));
    assert.throws(() => saveSnapshot('con.json', {}));
    saved = saveSnapshot(name, { fixture: true });
    assert.equal(path.dirname(saved), path.join(labRoot, 'runs'));
    assert.throws(() => saveSnapshot(name, { fixture: false }), /EEXIST/);
    assert.deepEqual(read(saved), { fixture: true });
  } finally { if (saved) fs.unlinkSync(saved); }
});
