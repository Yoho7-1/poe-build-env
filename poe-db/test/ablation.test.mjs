import test from 'node:test';
import assert from 'node:assert/strict';
import { planAblation, classifyRow, mergeChanges, extractSideEffects, ablationMarkdown, defaultThresholds, attachDependents } from '../scripts/analysis-ablation.mjs';
import { agent } from '../scripts/agent.mjs';

const gem = (index, name, skill_id, enabled = true) => ({ index, name, skill_id, enabled });
const build = {
  main_socket_group: 1,
  groups: [
    { index: 1, label: 'Main', slot: 'Body Armour', enabled: true, source: null, gems: [gem(1, 'Vortex', 'Vortex'), gem(2, 'Efficacy', 'SupportEfficacy'), gem(3, 'Empower', 'SupportEmpower', false)] },
    { index: 2, label: 'Aura', slot: null, enabled: true, source: null, gems: [gem(1, 'Malevolence', 'Malevolence')] },
    { index: 3, label: '', slot: 'Helmet', enabled: false, source: null, gems: [gem(1, 'Flame Dash', 'FlameDash')] },
    { index: 4, label: '', slot: 'Amulet', enabled: true, source: 'Item:5:Death\'s Oath', gems: [gem(1, 'Death Aura', 'DeathAura')] }
  ],
  allocated: new Set(['100', '200', '300', '400'])
};
const equipped = [
  { slot: 'Helmet', name: 'Doom Crown', base: 'Prophet Crown', rarity: 'RARE' },
  { slot: 'Weapon 1 Swap', name: 'X', base: 'Void Sceptre', rarity: 'RARE' },
  { slot: 'Flask 1', name: 'Divine Life Flask', base: 'Divine Life Flask', rarity: 'MAGIC', active: false },
  { slot: 'Flask 2', name: 'Quicksilver', base: 'Quicksilver Flask', rarity: 'MAGIC', active: true },
  { slot: 'Jewel 1', name: 'Large', base: 'Large Cluster Jewel', rarity: 'RARE' },
  { slot: 'Arm', name: "Warden's Arm", base: "Warden's Arm", rarity: 'NORMAL' }
];
const tree = { nodes: new Map([[100, { id: 100, name: 'Small', type: 'normal' }], [200, { id: 200, name: 'Heart of Ice', type: 'notable' }],
  [300, { id: 300, name: 'Mind Over Matter', type: 'keystone' }], [400, { id: 400, name: 'Void Beacon', type: 'notable', ascendancy: 'Occultist' }]]) };
const isSupport = g => /^Support/.test(g.skill_id);

test('ablation plan: one component per support, group, strippable item and tree notable', () => {
  const { components, skipped } = planAblation({ build, equipped, tree, isSupport });
  const ids = components.map(c => c.id);
  assert.deepEqual(ids, ['support:1:2', 'skill:2', 'item:Flask 2', 'item:Helmet', 'node:200', 'node:300', 'node:400']);
  assert.deepEqual(components[0].changes, { skills: { groups: [{ group: 1, remove_gems: [2] }] } });
  assert.deepEqual(components[1].changes, { skills: { groups: [{ group: 2, enabled: false }] } });
  assert.deepEqual(components.find(c => c.id === 'item:Helmet').changes, { replace_items: [{ slot: 'Helmet', text: 'Rarity: NORMAL\nProphet Crown' }] });
  assert.deepEqual(components.find(c => c.id === 'node:300').changes, { remove_nodes: [{ node: 300 }] });
  assert.equal(components.find(c => c.id === 'node:400').label, 'Void Beacon (ascendancy notable)');
  const reasons = Object.fromEntries(skipped.map(s => [s.id, s.reason]));
  assert.equal(reasons['skill:3'], 'already_disabled');
  assert.equal(reasons['skill:4'], 'item_granted_group_not_editable');
  assert.equal(reasons['item:Weapon 1 Swap'], 'weapon_swap');
  assert.equal(reasons['item:Flask 1'], 'flask_not_active_in_config');
  assert.match(reasons['item:Jewel 1'], /cluster/);
  assert.match(reasons['item:Arm'], /^normal_rarity/);
  // Kinds filter and base changes are merged, not overwritten.
  const only = planAblation({ build, equipped, tree, isSupport, kinds: ['supports'], base: { config: { useFrenzyCharges: true }, skills: { groups: [{ group: 2, enabled: true }] } } });
  assert.deepEqual(only.components.map(c => c.id), ['support:1:2']);
  assert.deepEqual(only.components[0].changes, { config: { useFrenzyCharges: true }, skills: { groups: [{ group: 2, enabled: true }, { group: 1, remove_gems: [2] }] } });
});

test('mergeChanges keeps base blocks and lets the ablation replace the same item slot', () => {
  const merged = mergeChanges({ replace_items: [{ slot: 'Helmet', text: 'a' }, { slot: 'Boots', text: 'b' }], remove_nodes: [{ node: 1 }] },
    { replace_items: [{ slot: 'Helmet', text: 'c' }], remove_nodes: [{ node: 2 }, { node: 1 }] });
  assert.deepEqual(merged.replace_items, [{ slot: 'Boots', text: 'b' }, { slot: 'Helmet', text: 'c' }]);
  assert.deepEqual(merged.remove_nodes, [{ node: 1 }, { node: 2 }]);
});

const row = deltas => ({ deltas: Object.fromEntries(Object.entries(deltas).map(([m, [before, after]]) => [m, { before, after, abs: after - before, pct: before > 0 ? (after / before - 1) * 100 : null }])) });
test('classification uses the largest offense or defense loss and flags hard breaks', () => {
  assert.equal(classifyRow(row({ dps: [100, 70], ehp: [1000, 1000] })).tier, 'core');
  assert.equal(classifyRow(row({ dps: [100, 100], ehp: [1000, 850] })).tier, 'major');
  assert.equal(classifyRow(row({ dps: [100, 96], ehp: [1000, 1000] })).tier, 'minor');
  assert.equal(classifyRow(row({ dps: [100, 99.5], ehp: [1000, 1000] })).tier, 'negligible');
  assert.equal(classifyRow(row({ dps: [100, 105], ehp: [1000, 1000] })).tier, 'removal_improves');
  assert.equal(classifyRow(row({ dps: [100, 0] })).tier, 'core');
  assert.equal(classifyRow({ ...row({ dps: [100, 100] }), skill_disabled_reason: 'Requires a weapon' }).tier, 'core');
  const mana = classifyRow(row({ dps: [100, 100], mana_sustain: [5, -3] }));
  assert.equal(mana.tier, 'major');
  assert.equal(mana.mana_sustain_broken, true);
  assert.equal(classifyRow({ error: 'boom' }).tier, 'error');
  // Custom thresholds
  assert.equal(classifyRow(row({ dps: [100, 85] }), { ...defaultThresholds, core: 10 }).tier, 'core');
  const c = classifyRow(row({ dps: [100, 80], maxhit: [5000, 4500], life: [4000, 4000] }));
  assert.equal(c.offense_loss_pct, 20);
  assert.equal(c.defense_loss_pct, 10);
});

test('side effects: unmet requirements, resists and removed nodes from the engine result', () => {
  const s = extractSideEffects({ output: { Str: 90, ReqStr: 111, Dex: 50, ReqDex: 20, FireResist: 75, EffectiveMovementSpeedMod: 1.3 },
    removed_nodes: { method: 'pob_misc_calculator_removeNodes', nodes: [{ id: 5, name: 'A', type: 'Notable', requested: true, dependents: 1 }, { id: 6, name: 'B', type: 'Normal' }] }, applied_supports: [{ name: 'Efficacy' }] });
  assert.deepEqual(s.unmet_requirements, [{ attribute: 'Str', have: 90, required: 111 }]);
  assert.deepEqual(s.resists, { FireResist: 75 });
  assert.equal(s.removed_nodes.length, 2);
  assert.deepEqual(s.applied_supports, ['Efficacy']);
  assert.equal(extractSideEffects({ output: {} }).removed_nodes, undefined);
});

test('markdown report lists every row with its tier and is pipe-safe', () => {
  const md = ablationMarkdown({ file: 'x/b.xml', scenario: 'sustained', method: 'm', baseline: { values: { dps: 1 }, dps_basis: 'CombinedDPS' },
    rows: [{ label: 'A | B', kind: 'items', tier: 'core', offense_loss_pct: 30, defense_loss_pct: 1, reasons: ['DPS -30%'], points_freed: 0 }], skipped: [{ id: 'skill:3', reason: 'already_disabled' }] });
  assert.match(md, /\| A \/ B \| items \| ядро \| -30\.0% \| -1\.0% \|/);
  assert.match(md, /already_disabled/);
});

test('ablate CLI validates options before running the engine', () => {
  assert.throws(() => agent(['analyze', 'ablate']), /Build file required/);
  assert.throws(() => agent(['analyze', 'ablate', 'x.xml', '--kinds', 'flasks']), /--kinds accepts/);
  assert.throws(() => agent(['analyze', 'ablate', 'x.xml', '--core', '5', '--major', '10']), /core >= major >= minor/);
  assert.ok(Object.keys(agent(['help', '--full']).commands).some(k => k.startsWith('analyze ablate')));
});

test('with_dependents: branch loss, freed points and other key nodes, as the PoB tree tooltip', () => {
  const row = { id: 'node:1', kind: 'tree', label: 'Cruel Preparation (notable)', tier: 'minor', offense_loss_pct: 0, defense_loss_pct: 3.89, reasons: ['defense -3.89%'] };
  const dep = { deltas: { dps: { before: 100, after: 62.6, pct: -37.4 }, life: { before: 5995, after: 5546, pct: -7.49 } },
    extra: { removed_nodes: [{ id: 1, name: 'Cruel Preparation', type: 'Notable', requested: true }, { id: 2, name: 'Heart of Ice', type: 'Notable' }, { id: 3, name: 'Bitter Frost', type: 'Keystone' }, { id: 4, name: 'Cold Damage', type: 'Normal' }] } };
  const out = attachDependents(row, dep);
  assert.equal(out.tier, 'minor');
  assert.deepEqual(out.with_dependents.other_key_nodes, ['Heart of Ice', 'Bitter Frost']);
  assert.equal(out.with_dependents.points, 4); assert.equal(out.with_dependents.tier, 'core'); assert.equal(out.with_dependents.dps_loss_per_point, 9.35);
  assert.ok(out.reasons.some(r => /^bridge:/.test(r)));
  assert.equal(attachDependents(row, { error: 'x' }).with_dependents.error, 'x');
});

test('remove_nodes is validated before the engine runs and cannot be mixed with tree edits', async () => {
  const { runPob } = await import('../scripts/pob.mjs');
  assert.throws(() => runPob({ changes: { remove_nodes: [] } }), /1-100 entries/);
  assert.throws(() => runPob({ changes: { remove_nodes: [{ node: 'x' }] } }), /allocated node id/);
  assert.throws(() => runPob({ changes: { remove_nodes: [{ node: 5, extra: 1 }] } }), /Unsupported remove_nodes field/);
  assert.throws(() => runPob({ changes: { remove_nodes: [{ node: 5 }], tree: { allocate: [1] } } }), /do not combine/);
});

test('variants and node_power are validated before the engine runs', async () => {
  const { validateVariants } = await import('../scripts/pob.mjs');
  const keys = ['CombinedDPS'];
  assert.doesNotThrow(() => validateVariants({ variants: [{ id: 'rm:1', remove_nodes: [{ node: 1, with_dependents: true }] }, { id: 'add:2', add_nodes: [2] }], variant_keys: keys }));
  assert.throws(() => validateVariants({ variants: [{ id: 'a b', add_nodes: [2] }], variant_keys: keys }), /variant needs id/);
  assert.throws(() => validateVariants({ variants: [{ id: 'x', add_nodes: [2] }, { id: 'x', add_nodes: [3] }], variant_keys: keys }), /Duplicate/);
  assert.throws(() => validateVariants({ variants: [{ id: 'x' }], variant_keys: keys }), /changes nothing/);
  assert.throws(() => validateVariants({ variants: [{ id: 'x', add_nodes: [2] }] }), /variant_keys/);
  assert.throws(() => validateVariants({ node_power: { max_dist: 0 }, variant_keys: keys }), /max_dist/);
  assert.throws(() => validateVariants({ node_power: { max_dist: 3, shard: { index: 2, count: 2 } }, variant_keys: keys }), /shard/);
  assert.throws(() => validateVariants({ variant_keys: keys }), /only with/);
});

test('variant runner maps candidate changes to computed variants and reports skips', async () => {
  const { variantRunner } = await import('../scripts/analysis-engine.mjs');
  const run = variantRunner({ results: new Map([['rm:1', { output: { CombinedDPS: 1 } }], ['deps:1', { skipped: 'no_dependents' }]]) });
  assert.deepEqual(run({ variant: 'rm:1', base: {} }).output, { CombinedDPS: 1 });
  assert.throws(() => run({ variant: 'deps:1' }), /no_dependents/);
  assert.throws(() => run({ variant: 'zzz' }), /not computed/);
});
