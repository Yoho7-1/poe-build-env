import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { treeCommand, treeFile } from '../scripts/tree-graph.mjs';
import { levelingCommand } from '../scripts/leveling.mjs';
import { changesCommand } from '../scripts/patch-changes.mjs';
import { metaCommand } from '../scripts/meta.mjs';
import { parseLuaTable } from '../scripts/lua-table.mjs';

const raw = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
// Independent plain BFS over the raw GGG export (no 0-1 weights, no shared code with tree-graph.mjs).
function rawShortest(start, goal) {
  const adj = new Map();
  for (const [k, n] of Object.entries(raw.nodes)) for (const o of [...(n.out ?? []), ...(n.in ?? [])]) {
    if (!adj.has(k)) adj.set(k, new Set()); if (!adj.has(o)) adj.set(o, new Set());
    adj.get(k).add(o); adj.get(o).add(k);
  }
  const ok = id => { const n = raw.nodes[id]; return n && n.group != null && !n.ascendancyName && n.classStartIndex === undefined && !n.isProxy && !n.isBlighted; };
  const dist = new Map([[start, 0]]), queue = [start];
  while (queue.length) {
    const id = queue.shift();
    if (id !== start && raw.nodes[id].isMastery) continue;
    for (const o of adj.get(id) ?? []) if (!dist.has(o) && ok(o)) { dist.set(o, dist.get(id) + 1); queue.push(o); }
  }
  return dist.get(goal);
}

test('tree path Witch -> Elemental Equilibrium is a legal minimum chain on the GGG 3.30 graph', () => {
  const r = treeCommand(['path', '--from', 'Witch', '--to', 'Elemental Equilibrium']);
  const witch = Object.entries(raw.nodes).find(([, n]) => n.classStartIndex === 3)[0];
  assert.equal(r.from.start, Number(witch));
  const ids = r.allocate.map(String);
  assert.equal(ids.at(-1), '39085');
  assert.equal(raw.nodes['39085'].name, 'Elemental Equilibrium');
  const linked = (a, b) => [...(raw.nodes[a].out ?? []), ...(raw.nodes[a].in ?? [])].includes(b) || [...(raw.nodes[b].out ?? []), ...(raw.nodes[b].in ?? [])].includes(a);
  [witch, ...ids].forEach((id, i, all) => { if (i) assert.ok(linked(all[i - 1], id), `${all[i - 1]} -> ${id} not linked`); });
  for (const id of ids) {
    const n = raw.nodes[id];
    assert.ok(!n.ascendancyName && n.classStartIndex === undefined && !n.isProxy && !n.isMastery, `${id} illegal on path`);
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, rawShortest(witch, '39085'));
  assert.equal(r.points.main_tree, ids.length);
  assert.equal(r.source.sha256, '1ba8e3bda13bf672e23033b07dc8a913cb3768d306b344103fe85cbe25e4ce44');
});

test('tree path reuses allocated nodes, separates ascendancy and reports mastery choices', () => {
  const base = treeCommand(['path', '--from', 'Witch', '--to', 'Elemental Equilibrium']);
  const half = base.allocate.slice(0, 10);
  const rest = treeCommand(['path', '--from', 'Witch', '--to', 'Elemental Equilibrium', '--allocated', half.join(',')]);
  assert.equal(rest.points.main_tree, base.allocate.length - 10);
  const multi = treeCommand(['path', '--from', 'Elementalist', '--to', 'Elemental Equilibrium,Mind Over Matter,Shaper of Flames,Life Mastery']);
  const asc = multi.sections.find(s => s.scope === 'ascendancy');
  assert.equal(asc.ascendancy, 'Elementalist');
  assert.ok(asc.points >= 1 && asc.points <= 8);
  const main = multi.sections.find(s => s.scope === 'main_tree');
  assert.ok(main.mastery_choices_required?.[0]?.options.length > 0);
  assert.ok(main.points < base.allocate.length + treeCommand(['path', '--from', 'Witch', '--to', 'Mind Over Matter']).allocate.length + 10);
  assert.throws(() => treeCommand(['path', '--from', 'Witch', '--to', 'Righteous Providence']), /Inquisitor/);
  assert.throws(() => treeCommand(['path', '--from', 'Witch', '--to', 'No Such Node Xyz']), /Unknown node/);
});

test('tree cost validates connectivity and budget; near and search work', () => {
  const p = treeCommand(['path', '--from', 'Witch', '--to', 'Elemental Equilibrium']);
  const ok = treeCommand(['cost', '--from', 'Witch', '--allocated', p.allocate.join(',')]);
  assert.equal(ok.connected, true);
  assert.equal(ok.points.main_tree, p.allocate.length);
  const broken = treeCommand(['cost', '--from', 'Witch', '--allocated', p.allocate.slice(5).join(',')]);
  assert.equal(broken.connected, false);
  assert.ok(broken.disconnected.length > 0);
  const near = treeCommand(['near', '61419', '--radius', 'large']);
  assert.ok(near.total > 0 && near.results.every(r => r.distance <= 1800));
  assert.ok(near.results.every(r => r.type !== 'mastery'));
  const small = treeCommand(['near', '61419', '--radius', 'small']);
  assert.ok(small.total < near.total);
  const search = treeCommand(['search', 'Elemental Equilibrium', '--type', 'keystone']);
  assert.equal(search.results[0].id, 39085);
  assert.ok(!JSON.stringify(treeCommand(['search', 'blind', '--limit', '100'])).includes('[Blind|'));
});

test('leveling gems for Witch match the client export and official patch notes', () => {
  const act1 = levelingCommand(['gems', '--class', 'Witch', '--act', '1']);
  const enemy = act1.quests.find(q => q.quest === 'Enemy at the Gate');
  assert.ok(enemy.reward_choice.some(g => g.gem === 'Freezing Pulse'));
  assert.ok(enemy.vendor.some(g => g.gem === 'Fireball'));
  assert.equal(enemy.vendor_npc, 'Nessa');
  // Every Witch quest-reward gem row with a client record agrees, or the conflict is reported.
  const data = JSON.parse(fs.readFileSync(path.join(fileURLToPath(new URL('../data/', import.meta.url)), 'leveling-3.30.json'), 'utf8'));
  const witchRows = data.rewards.filter(r => r.source === 'quest_reward' && r.kind === 'gem' && (r.classes.includes('Witch') || r.classes.includes('all')) && r.act <= 3);
  assert.ok(witchRows.filter(r => r.client_check === 'match').length >= 40);
  for (const r of witchRows.filter(r => r.client_check === 'class_mismatch')) assert.ok(data.source_conflicts.some(c => c.item === r.item));
  // Patch notes 3.30.0: Arcane Link offered to Scion for Breaking the Seal, purchasable by Marauder, Duelist and Templar.
  const note = changesCommand(['get', 'Arcane Link']).patch_notes.linked.map(l => l.text).join('\n');
  assert.match(note, /offered to the Scion for completing Breaking the Seal/);
  const link = levelingCommand(['gem', 'Arcane Link']);
  assert.deepEqual(link.by_class.Scion.quest_reward, { act: 4, quest: 'Breaking the Seal' });
  for (const cls of ['Marauder', 'Duelist', 'Templar']) assert.equal(link.by_class[cls].vendor.npc, 'Petarus and Vanja');
  assert.equal(link.by_class.Witch.quest_reward, null);
  assert.ok(levelingCommand(['books']).count >= 20);
  assert.ok(levelingCommand(['recipes', 'movement']).total >= 1);
  assert.ok(levelingCommand(['uniques', '--max-level', '10']).results.every(u => u.required_level <= 10));
  assert.throws(() => levelingCommand(['gems', '--class', 'Elementalist', '--act', '1']), /base class/);
});

test('changes 3.29 -> 3.30 combine tree diff, unique versions and patch notes', () => {
  const surgeon = changesCommand(['get', 'Master Surgeon']);
  assert.equal(surgeon.tree[0].ascendancy, 'Pathfinder');
  assert.ok(surgeon.patch_notes.linked.length >= 1);
  const doedre = changesCommand(['get', "Doedre's Tongue"]);
  assert.ok(doedre.uniques[0].added.includes('+(30-35)% to all Elemental Resistances'));
  const none = changesCommand(['get', 'Elemental Equilibrium']);
  assert.equal(none.status, 'no_record');
  assert.match(none.notes[0], /does not prove/);
  assert.equal(changesCommand(['card']).id, 'guide-3-29-to-3-30-check');
  const lua = parseLuaTable('return { ["a"]= { 1, 2, "x\\ny" }, b = true, [3] = -1.5e2 }');
  assert.deepEqual(lua, { a: [1, 2, 'x\ny'], b: true, 3: -150 });
});

test('meta keeps league, patch and date labels and never claims 3.30 meta', () => {
  const r = metaCommand(['skill', 'Toxic Rain']);
  assert.match(r.warning, /Not 3\.30 meta/);
  assert.ok(r.builds.every(b => b.stale === (b.pob_patch !== '3.30') && b.checked_at === '2026-11-12'));
  assert.ok(r.price_history_3_29.length > 0 && r.price_history_3_29.every(p => p.patch === '3.29' && p.league.includes('Allflame')));
  const info = metaCommand(['info']);
  assert.ok(info.counts.builds >= 12 && info.counts.sources === 300);
});

test('data commands run through agent.mjs from another directory', () => {
  const script = fileURLToPath(new URL('../scripts/agent.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, 'tree', 'path', '--from', 'Witch', '--to', '39085'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).allocate.at(-1), 39085);
});
