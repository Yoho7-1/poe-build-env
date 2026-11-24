// WP5 Build Request Mode: request -> candidate architectures -> PoB prototypes -> hard filters -> Pareto front.
// Every choice is made by code over local data or by PoB probes; the agent picks the request and interprets.
//   candidates : knowledge DB active gems (types/tags) x requested ascendancies, scored by design-blueprint rules
//   tree       : greedy legal allocation (tree-graph BFS) of notables matching the skill's scaling axes + life
//   items      : rare kit from item-builder (legal mods, mid tiers), weapon family from skill weapon restrictions
//   screen     : bare prototype (skill alone) through PoB, ranked by engine DPS
//   supports   : each type-compatible support probed alone through PoB (analysis-candidates prefilter), top N kept
//   auras/curse: reservation skills and, when an ascendancy node needs cursed enemies, Blasphemy + hex probed
//   evaluation : final prototype + analyze encounter (map boss, rare) at the requested tier
// Results go to research/lab/designs/<run>/; rejected prototypes become lab `failure` records.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbRoot, projectRoot, flags, readJson, atomicJson } from './workspace.mjs';
import { runPob, newPob, inspectBuild, scenarios } from './pob.mjs';
import { validatePrototype, specFromInspect } from './mechanic-validate.mjs';
import { foundationReport, chooseNormGroup, sustainComponents, corpusNorms } from './corpus-norms.mjs';
import { loadTree, rootsFor, distances, connectOne } from './tree-graph.mjs';
import { itemKit, KIT_TIER, ELDRITCH_SLOTS } from './design-kit.mjs';
import { clusterCandidates, clusterText, outerClusterSockets, innerClusterSockets, nestedCandidates } from './design-cluster.mjs';
import { pobGems, supportCompatible, readBuild, anointOptions, withAnoint, currentAnoint } from './analysis-candidates.mjs';
import { seedsFor, neutralConfig, weaponCompatible, slotItemText } from './design-seed.mjs';
import { readCards } from './corpus-learn.mjs';
import { buttonEstimate, buildCard } from './build-card.mjs';
import { noveltyScore, loadNoveltyCorpus } from './novelty.mjs';
import { optimizeCommand, optimizeHelp } from './design-optimize.mjs';
import { reverseCommand, reverseHelp } from './design-reverse.mjs';
import { runBatch, defaultConcurrency } from './analysis-engine.mjs';
import { canonicalJson, metrics as coreMetrics } from './analysis-core.mjs';
import { damageOf, analyzeEncounter } from './analysis-encounter.mjs';
import { createRecord } from './lab.mjs';
import { referenceDb, exampleQuery } from './reference-store.mjs';
import { loadBuild } from './build-store.mjs';
import * as B from './design-blueprint.mjs';
import { valueOf, layerGain, layerRecord, decideLayer, probeKitLayers, repairManaFromCorpus, manaCondition } from './design-layers.mjs';

const disclaimer = 'Generated prototypes are engine sketches with generic rare items and a greedy tree; numbers compare architectures under one item/tree policy, they are not optimised builds and not game tests.';
const round = (v, d = 0) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// ---------- data ----------
let gemCache = null;
export function loadGems() {
  if (gemCache) return gemCache;
  const db = new DatabaseSync(path.join(dbRoot, 'data/knowledge-3.30.sqlite'), { readOnly: true });
  try {
    const pob = pobGems();
    const out = new Map();
    for (const r of db.prepare("SELECT id,name,eligibility,payload_json FROM records WHERE category='gems'").all()) {
      const d = JSON.parse(r.payload_json);
      const a = d.active_skill ?? {};
      const p = pob.get(r.id);
      out.set(r.id, { id: r.id, name: p?.name ?? d.display_name ?? r.name, pob_known: !!p, pob_tags: p?.tags ?? {}, eligibility: r.eligibility,
        is_support: !!d.is_support, colour: d.color ?? null, tags: d.tags ?? [], types: a.types ?? [], minion_types: a.minion_types ?? [],
        weapon_restrictions: a.weapon_restrictions ?? [], description: a.description ?? '', support_gem: d.support_gem ?? null,
        release: d.base_item?.release_state ?? null, natural_max_level: p?.naturalMaxLevel ?? 20 });
    }
    gemCache = out;
    return out;
  } finally { db.close(); }
}

// ---------- tree ----------
// Greedy: repeatedly allocate the node with the best value per point of path (0-1 BFS over the PoB traversal
// rules) until the budget is spent. Masteries and keystones are not chosen (mastery effects and keystone trade-offs
// are left to WP6 / the agent). Small nodes count with 30% of their axis value, so leftover points go to them.
export function growTree(t, cls, { ascendancy = null, valueOf, budget, start = null }) {
  const allocated = new Set(start ?? [cls.start]);
  const picks = [];
  let left = budget;
  const pool = [...t.nodes.values()].filter(n => n.eligibility === 'tree_defined' && n.group != null && !n.proxy
    && (ascendancy ? n.ascendancy === ascendancy : !n.ascendancy) && ['notable', 'normal'].includes(n.type));
  const value = new Map(pool.map(n => [n.id, valueOf(n)]).filter(([, v]) => v.value > 0));
  while (left > 0 && value.size) {
    const dist = distances(t, rootsFor(t, cls, allocated, ascendancy), allocated);
    let best = null;
    for (const [id, v] of value) {
      if (allocated.has(id)) continue;
      const d = dist.get(id);
      if (d == null || d < 1 || d > left) continue;
      const ratio = v.value / d;
      if (!best || ratio > best.ratio || (ratio === best.ratio && d < best.d)) best = { id, d, ratio, v };
    }
    if (!best) break;
    const step = connectOne(t, cls, allocated, best.id, ascendancy);
    if (!step || step.added.length > left) { value.delete(best.id); continue; }
    step.added.forEach(id => allocated.add(id));
    left -= step.added.length;
    const n = t.nodes.get(best.id);
    if (n.type === 'notable') picks.push({ id: n.id, name: n.name, points: step.added.length, axes: best.v.axes, value: round(best.v.value, 2), reqs: best.v.reqs ?? [] });
    value.delete(best.id);
  }
  const added = [...allocated].filter(id => id !== cls.start && !(start ?? []).includes(id) && t.nodes.get(id).type !== 'ascendancy_start');
  return { allocate: added, picks, unspent: left };
}

function treeFor(t, gem, clsName, ascendancy, request, points, treeAttrs = [], family = null, force = []) {
  const cls = t.classes.find(c => c.name === clsName);
  // WP11: forced nodes (a keystone or mastery group a repair probes): their paths are allocated first and the greedy
  // tree grows around them on the remaining points, so a forced node always costs the same point budget.
  const forced = new Set([cls.start]);
  for (const id of force) { const step = connectOne(t, cls, forced, Number(id), null); if (step) step.added.forEach(x => forced.add(x)); }
  const forcedPath = [...forced].filter(id => id !== cls.start);
  // Flask-free mana: self-cast/attack skills also value mana regeneration/cost nodes (resource axis).
  const axes = [...B.axesFor(gem), ...(request.constraints?.no_mana_flask && B.damageFormOf(gem) !== 'minion' ? [B.RESOURCE_AXIS] : []), ...treeAttrs.map(B.attributeAxis)];
  const themes = B.skillThemes(gem);
  const main = growTree(t, cls, { budget: points - forcedPath.length, start: [...forced], valueOf: n => { const v = B.nodeValue(n.stats, axes, { family }); return { ...v, value: v.value * (n.type === 'normal' ? 0.3 : 1) }; } });
  // Ascendancy: axis value + 2 per requested theme the node provides; nodes whose condition the skill cannot meet
  // (and no generator enabler exists) are worth nothing. Remaining points go to the nearest notable (filler).
  const ascValue = n => {
    const reqs = B.nodeRequirements(n.stats), met = B.requirementsMet(reqs, themes);
    if (!met.ok) return { value: 0, axes: [], reqs };
    const v = B.nodeValue(n.stats, axes, { family });
    const text = n.stats.join('\n');
    const th = (request.themes ?? []).filter(k => B.THEMES[k].node.test(text));
    const generic = n.type === 'notable' ? 0.2 : 0.05;
    return { value: v.value + 2 * th.length + generic, axes: [...v.axes, ...th.map(k => `theme:${k}`)], reqs };
  };
  const asc = growTree(t, cls, { ascendancy, budget: 8, valueOf: ascValue });
  const enablers = [...new Set(asc.picks.flatMap(p => B.requirementsMet(p.reqs, themes).enablers))];
  return { allocate: [...forcedPath, ...main.allocate, ...asc.allocate], forced: forcedPath, main_picks: main.picks, ascendancy_picks: asc.picks, unspent: main.unspent + asc.unspent, enablers, axes };
}

// ---------- engine helpers ----------
// Calculation budget. sub(n) gives a step or a prototype its own cap: it takes from the parent as it goes, and what a
// step leaves unused stays with the parent (later prototypes get it), so early steps cannot starve later ones (WP11).
class Budget {
  constructor(max, parent = null) { this.max = max; this.used = 0; this.parent = parent; }
  left() { return Math.max(0, Math.min(this.max - this.used, this.parent ? this.parent.left() : Infinity)); }
  take(n) { this.used += n; this.parent?.take(n); }
  sub(n) { return new Budget(Math.max(0, Math.min(Math.floor(n), this.left())), this); }
}
function bestDps(r) { return r && !r.error ? damageOf(r.output ?? {}, null, r.minion_output).best_dps ?? 0 : 0; }
function batch(file, changesList, budget, concurrency) {
  const list = changesList.slice(0, Math.max(0, budget.left()));
  if (!list.length) return { results: new Map(), truncated: changesList.length };
  const b = runBatch({ file, scenario: 'sustained', changesList: list, concurrency });
  budget.take(b.runs);
  return { get: c => b.results.get(canonicalJson(c)), truncated: changesList.length - list.length };
}
const baseFiles = new Map();
function classBase(dir, cls, asc, level) {
  const key = `${asc}-${level}`;
  if (baseFiles.has(key)) return baseFiles.get(key);
  const file = path.join(dir, 'bases', `${key}.xml`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    newPob({ className: cls, ascendancy: asc, level, changes: {}, saveXml: file });
  }
  baseFiles.set(key, file);
  return file;
}
const withGroup = (changes, group) => ({ ...changes, skills: { add_groups: [...(changes.skills?.add_groups ?? []), group] } });
const gemSpec = (g, q = 20) => ({ name: g.name, level: Math.min(20, g.natural_max_level ?? 20), quality: q });

// ---------- candidates ----------
export function candidates(request, { gems = loadGems(), t = loadTree() } = {}) {
  const excluded = {}, rows = [];
  const skip = (reason, g) => { (excluded[reason] ??= { count: 0, examples: [] }).count++; if (excluded[reason].examples.length < 5) excluded[reason].examples.push(g.name); };
  for (const g of gems.values()) {
    const ok = B.isMainSkillCandidate(g);
    if (!ok.ok) { if (!g.is_support) skip(ok.reason, g); continue; }
    if (!g.pob_known) { skip('not_in_pob', g); continue; }
    if (g.release && g.release !== 'released') { skip(`release_${g.release}`, g); continue; }
    const family = B.weaponFamilyFor(g);
    if (!family) { skip('no_weapon_kit', g); continue; }
    for (const cls of request.classes) {
      const ascNodes = [...t.nodes.values()].filter(n => n.ascendancy === cls.ascendancy && n.type === 'notable' && n.eligibility === 'tree_defined').map(n => ({ name: n.name, stats: n.stats }));
      const s = B.scoreCandidate(g, cls, ascNodes, request);
      rows.push({ id: `${slug(g.id)}--${slug(cls.ascendancy)}`, gem: g.id, skill: g.name, class: cls.class, ascendancy: cls.ascendancy, family,
        form: B.damageFormOf(g), damage_types: B.damageTypesOf(g), ...s });
    }
  }
  return { rows: rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)), excluded };
}

// Prototype changes for one architecture (without supports/auras/enablers).
function prototypeChanges(row, request, t, gems, { needAttrs = [], treeAttrs = [], reserve = 0, force = [], mana = {} } = {}) {
  const g = gems.get(row.gem);
  // PoB: level-1 + quest points (23 incl. bandits off); exact budget re-read from the engine. `reserve` points are
  // left for masteries (WP5b: corpus norm median), spent by probeMasteries.
  const points = request.level - 1 + 22 + 1 - reserve;
  const tree = treeFor(t, g, row.class, row.ascendancy, request, points, treeAttrs, row.family, force);
  // Armour/jewellery attribute follows the class; gem attribute deficits are covered by the attribute repair.
  const attr = B.CLASS_ATTRIBUTES[row.class][0];
  // mana: kit mana affixes chosen by the WP11 mana repair ({regen, leech}); the flask-free constraint keeps regen on.
  const kitArgs = { attr, family: row.family, damageTypes: row.damage_types, form: row.form, needAttrs, manaRegen: (!!request.constraints?.no_mana_flask && row.form !== 'minion') || !!mana.regen, manaLeech: !!mana.leech, axes: tree.axes };
  const kit = itemKit(kitArgs);
  const changes = { tree: { allocate: tree.allocate, ascendancy_points: 8 }, replace_items: kit.replace_items,
    skills: { add_groups: [{ label: 'Main', slot: 'Body Armour', main: true, gems: [gemSpec(g)] }] } };
  return { changes, tree, kit, kitArgs, gem: g, force, mana };
}

// WP5b: masteries. Candidates are mastery nodes of tree groups the prototype already allocated; every effect option is
// probed by PoB on top of the current changes. Value = DPS gain % + EHP gain % (+ a bonus when the effect turns a
// mana deficit into sustain, or fixes an unmet attribute). Greedy pick of at most `count`, one effect id per tree,
// one effect per node. Points come from the reserve the tree left free (count = corpus norm median).
export function masteryCandidates(t, allocated) {
  const groups = new Set([...allocated].map(id => t.nodes.get(Number(id))?.group).filter(g => g != null));
  return [...t.nodes.values()].filter(n => n.type === 'mastery' && groups.has(n.group) && n.mastery_effects?.length && !n.ascendancy)
    .flatMap(n => n.mastery_effects.map(e => ({ node: n.id, name: n.name, effect: e.effect, text: e.stats.join(' / ') })));
}
export function pickMasteries(rows, count) {
  const chosen = [], nodes = new Set(), effects = new Set();
  for (const r of [...rows].sort((a, b) => b.value - a.value || a.node - b.node || a.effect - b.effect)) {
    if (chosen.length >= count) break;
    if (!(r.value > 0) || nodes.has(r.node) || effects.has(r.effect)) continue;
    chosen.push(r); nodes.add(r.node); effects.add(r.effect);
  }
  return chosen;
}
function probeMasteries({ file, base, t, budget, concurrency, count, cap = 120 }) {
  if (count <= 0) return { chosen: [], probes: 0, reason: 'no mastery reserve' };
  const allocated = new Set((base.tree?.allocate ?? []).map(String));
  const cands = masteryCandidates(t, allocated).slice(0, cap);
  if (!cands.length) return { chosen: [], probes: 0, reason: 'no mastery in allocated groups' };
  const mk = c => ({ ...base, tree: { ...base.tree, masteries: [...(base.tree.masteries ?? []), { node: c.node, effect: c.effect }] } });
  const res = batch(file, [base, ...cands.map(mk)], budget, concurrency);
  if (!res.get) return { chosen: [], probes: 0, reason: 'budget' };
  const r0 = res.get(base), d0 = bestDps(r0), e0 = r0?.output?.TotalEHP ?? 0, s0 = sustainOf(r0), u0 = unmetAttrs(r0).length;
  const rows = cands.map(c => {
    const r = res.get(mk(c));
    if (!r || r.error) return null;
    const dg = d0 > 0 ? (bestDps(r) / d0 - 1) * 100 : 0, eg = e0 > 0 ? ((r.output?.TotalEHP ?? 0) / e0 - 1) * 100 : 0;
    const manaFix = s0 < 0 && sustainOf(r) >= 0 ? 25 : s0 < 0 && sustainOf(r) > s0 ? 10 * Math.min(1, (sustainOf(r) - s0) / -s0) : 0;
    const attrFix = u0 > unmetAttrs(r).length ? 15 : 0;
    return { ...c, dps_gain_pct: round(dg, 1), ehp_gain_pct: round(eg, 1), mana_fix: round(manaFix, 1), value: round(dg + eg + manaFix + attrFix, 2) };
  }).filter(Boolean);
  const chosen = pickMasteries(rows, count);
  return { chosen: chosen.map(({ node, name, effect, text, dps_gain_pct, ehp_gain_pct, mana_fix, value }) => ({ node, name, effect, text, dps_gain_pct, ehp_gain_pct, mana_fix, value })),
    probes: rows.length, reserve: count, top: [...rows].sort((a, b) => b.value - a.value).slice(0, 8).map(r => `${r.name}: ${r.text} (${r.value})`) };
}
// Mastery reserve = median masteries of the corpus norm group (ascendancy + skill family, falling back); 0 without norms.
export function masteryReserveFor(row, gem, cards = null, minGroup = 8) {
  try {
    const t = new Set(gem?.types ?? []);
    const family = t.has('Minion') || t.has('CreatesMinion') ? 'minion' : t.has('Attack') ? 'attack' : 'spell';
    const { norms } = chooseNormGroup({ cards: cards ?? undefined, ascendancy: row.ascendancy, family, minGroup });
    return Math.max(0, Math.min(10, Math.round(norms.masteries?.count?.median ?? 0)));
  } catch { return 0; }
}
// WP5b item 5: cluster jewels. Reserve = CLUSTER_RESERVE points when at least half of the corpus norm group uses
// cluster jewels (0 without norms). Candidates: the best-valued enchant + legal notables per size from the PoB data
// (design-cluster.mjs), each in the nearest reachable outer sockets; PoB probes them and the best positive one is kept.
export const CLUSTER_RESERVE = 12;
export function clusterReserveFor(row, gem, cards = null, minGroup = 8) {
  try {
    const t = new Set(gem?.types ?? []);
    const family = t.has('Minion') || t.has('CreatesMinion') ? 'minion' : t.has('Attack') ? 'attack' : 'spell';
    const { norms } = chooseNormGroup({ cards: cards ?? undefined, ascendancy: row.ascendancy, family, minGroup });
    return (norms.clusters?.uses ?? 0) >= 0.5 ? CLUSTER_RESERVE : 0;
  } catch { return 0; }
}
let notableStatsMap = null;
const notableStats = (t, name) => {
  if (!notableStatsMap) notableStatsMap = new Map([...t.nodes.values()].filter(n => ['notable', 'keystone'].includes(n.type)).map(n => [n.name, n.stats]));
  return notableStatsMap.get(name) ?? null;
};
// c.nested (optional): a smaller cluster in the first inner socket c.inner_socket (a real tree node inside the outer
// subgraph). The socket sits on the ring between the outer notables, so the path to them allocates it; pob-edit refuses
// an explicit allocation of an allocated node. A layout where the path misses the socket fails in PoB ("not allocated")
// and the probe drops that variant.
export const withCluster = (changes, c) => ({ ...changes, tree: { ...changes.tree, allocate: [...changes.tree.allocate, c.socket] },
  jewels: [...(changes.jewels ?? []), { node: c.socket, text: clusterText(c), allocate: c.notables.map(n => n.name) },
    ...(c.nested ? [{ node: c.inner_socket, text: clusterText(c.nested), allocate: c.nested.notables.map(n => n.name) }] : [])] });
// WP11: the alternative to a cluster is the same reserve spent on ordinary tree nodes (alt = tree grown without the
// cluster reserve). Gains are measured against it; a cluster is taken only when it beats the tree.
function probeClusters({ file, base, alt, t, row, axes, budget, concurrency, reserve, sockets = 2 }) {
  const altText = `the same ${reserve} points on ordinary tree nodes (greedy axis tree)`;
  if (reserve <= 0) return { chosen: null, probes: 0, reason: 'no cluster reserve (corpus norm below 50% or no norms)',
    layer: layerRecord('cluster', false, null, 'points stay on the tree', 'corpus norm group uses cluster jewels in < 50% of builds (or no norms): no points reserved', { decided_by: 'no_option' }) };
  const cls = t.classes.find(c => c.name === row.class);
  const allocated = new Set(base.tree.allocate.map(Number).filter(id => !t.nodes.get(id)?.ascendancy));
  allocated.add(cls.start);
  const cands = clusterCandidates({ valueOf: s => B.nodeValue(s, axes, { family: row.family }).value, notableStats: n => notableStats(t, n) });
  const near = outerClusterSockets(t).map(id => ({ id, path: connectOne(t, cls, allocated, id, null) })).filter(s => s.path)
    .sort((a, b) => a.path.cost - b.path.cost || a.id - b.id).slice(0, sockets);
  const single = cands.flatMap(c => near.filter(s => s.path.cost + c.points <= reserve).map(s => ({ ...c, socket: s.id, socket_cost: s.path.cost })));
  // Nested: the best outer cluster with sockets + the best smaller cluster in its first inner socket, when it fits.
  const nested = nestedCandidates(cands).flatMap(c => near.filter(s => s.path.cost + c.points <= reserve).map(s => ({ ...c, socket: s.id, socket_cost: s.path.cost, inner_socket: innerClusterSockets(t, s.id, c.size)[0] })))
    .filter(v => v.inner_socket != null);
  const variants = [...single, ...nested];
  if (!variants.length) return { chosen: null, probes: 0, reason: `no outer cluster socket within ${reserve} points`, layer: layerRecord('cluster', false, null, altText, `no outer cluster socket within ${reserve} points`, { decided_by: 'no_option' }) };
  const res = batch(file, [alt, ...variants.map(v => withCluster(base, v))], budget, concurrency);
  const r0 = res.get?.(alt);
  if (!r0 || r0.error) return { chosen: null, probes: 0, reason: 'budget', layer: layerRecord('cluster', false, null, altText, 'not probed: calculation budget', { decided_by: 'budget' }) };
  const v0 = valueOf(r0);
  const rows = variants.map(v => {
    const r = res.get(withCluster(base, v));
    if (!r || r.error) return null;
    const g = layerGain(valueOf(r), v0);
    return { ...v, dps_gain_pct: g.dps_pct, ehp_gain_pct: g.ehp_pct, gain: g.total };
  }).filter(Boolean).sort((a, b) => b.gain - a.gain || a.socket_cost - b.socket_cost);
  const brief = v => `${v.size} ${v.name} @${v.socket} [${v.notables.map(n => n.name).join(', ')}]${v.nested ? ` + ${v.nested.size} ${v.nested.name} @${v.inner_socket} [${v.nested.notables.map(n => n.name).join(', ')}]` : ''} (${v.gain})`;
  const best = rows[0]?.gain > 0 ? rows[0] : null;
  const top = rows[0] ? { dps_pct: rows[0].dps_gain_pct, ehp_pct: rows[0].ehp_gain_pct, total: rows[0].gain } : null;
  const layer = layerRecord('cluster', !!best, top, altText, best ? `best of ${rows.length} cluster variants beats the tree: ${brief(best)}`
    : rows.length ? `best of ${rows.length} cluster variants (${brief(rows[0])}) does not beat the same points on the tree` : 'no cluster variant ran', { decided_by: rows.length ? 'pob_probe' : 'budget' });
  return { chosen: best, probes: rows.length, reserve, top: rows.slice(0, 6).map(brief), reason: best ? null : 'no cluster variant beat the same points on the tree', layer };
}
const withMasteries = (changes, chosen) => chosen.length ? { ...changes, tree: { ...changes.tree, masteries: chosen.map(c => ({ node: c.node, effect: c.effect })) } } : changes;

// Support probes: every compatible support added alone; returns sorted gains.
function supportPool(g, request, gems) {
  const types = new Set([...g.types, ...g.minion_types]);
  const out = [], excluded = {};
  for (const s of gems.values()) {
    if (!s.is_support || !s.pob_known || s.eligibility !== 'released_in_client') continue;
    const tags = s.pob_tags ?? {};
    const why = tags.awakened ? 'awakened' : tags.exceptional || tags.low_max_level ? 'exceptional' : tags.trigger ? 'trigger'
      : request.constraints?.exclude_delivery_supports && (tags.totem || tags.trap || tags.mine) ? 'delivery_changes_buttons' : null;
    if (why) { excluded[why] = (excluded[why] ?? 0) + 1; continue; }
    const c = supportCompatible(s, types, { fromGem: true });
    if (!c.ok) { excluded[c.reason] = (excluded[c.reason] ?? 0) + 1; continue; }
    out.push(s);
  }
  return { pool: out, excluded };
}
// Probe order when the pool exceeds the cap: supports sharing more tags with the skill first (tags are PoB gem tags).
export function capSupports(pool, g, cap) {
  if (pool.length <= cap) return { pool, capped: 0 };
  const want = new Set([...g.tags, ...g.types.map(x => x.toLowerCase()), ...g.minion_types.map(x => x.toLowerCase())]);
  const score = s => Object.keys(s.pob_tags ?? {}).filter(k => want.has(k)).length;
  const ranked = [...pool].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  return { pool: ranked.slice(0, cap), capped: pool.length - cap };
}

function probeSupports({ file, base, g, request, gems, budget, concurrency, links, cap = 40 }) {
  const all = supportPool(g, request, gems), excluded = all.excluded;
  const { pool, capped } = capSupports(all.pool, g, cap);
  if (capped) excluded.capped_low_tag_overlap = capped;
  const mk = s => ({ ...base, skills: { ...base.skills, add_groups: base.skills.add_groups.map((gr, i) => i === 0 ? { ...gr, gems: [...gr.gems, gemSpec(s)] } : gr) } });
  const res = batch(file, [base, ...pool.map(mk)], budget, concurrency);
  if (!res.get) return { chosen: [], probes: [], excluded, truncated: res.truncated };
  const b0 = bestDps(res.get(base));
  const probes = pool.map(s => { const r = res.get(mk(s)); return { name: s.name, applied: !!r && !r.error && (r.applied_supports ?? []).some(a => a.name === s.name), dps: bestDps(r), error: r?.error ?? null }; })
    .filter(p => p.applied).map(p => ({ ...p, gain_pct: b0 > 0 ? round((p.dps / b0 - 1) * 100, 1) : null })).sort((a, b) => b.dps - a.dps);
  const chosen = [];
  for (const p of probes) { if (chosen.length >= links - 1) break; if (p.dps > b0) chosen.push(p.name); }
  return { base_dps: round(b0), chosen, probes: probes.slice(0, 12), excluded, candidates: pool.length, truncated: res.truncated };
}

function utilityPools(gems) {
  const auras = [], hexes = [];
  for (const g of gems.values()) {
    if (g.is_support || !g.pob_known || g.eligibility !== 'released_in_client' || /Royale$/.test(g.id) || g.tags.includes('vaal')) continue;
    const t = new Set(g.types);
    if (t.has('Aura') && t.has('HasReservation') && !['Herald', 'Banner', 'Mark', 'RemoteMined', 'Trapped', 'Minion', 'CreatesMinion', 'SummonsTotem', 'Damage'].some(x => t.has(x))) auras.push(g);
    if (t.has('Hex') && t.has('AppliesCurse') && !t.has('Mark')) hexes.push(g);
  }
  return { auras, hexes };
}

function probeUtility({ file, base, request, gems, budget, concurrency, needCurse }) {
  const { auras, hexes } = utilityPools(gems);
  const blasphemy = [...gems.values()].find(g => g.is_support && g.name === 'Blasphemy' && g.pob_known);
  const auraChanges = auras.map(a => ({ a, c: withGroup(base, { label: 'Aura', slot: 'Gloves', gems: [gemSpec(a)] }) }));
  const hexChanges = needCurse ? hexes.map(h => ({ h, c: withGroup(base, { label: 'Curse aura', slot: 'Helmet', gems: [gemSpec(h), ...(blasphemy ? [gemSpec(blasphemy)] : [])] }) })) : [];
  const res = batch(file, [base, ...auraChanges.map(x => x.c), ...hexChanges.map(x => x.c)], budget, concurrency);
  if (!res.get) return { auras: [], curse: null, truncated: res.truncated };
  const r0 = res.get(base), d0 = bestDps(r0), e0 = r0?.output?.TotalEHP ?? 0;
  const auraRows = auraChanges.map(({ a, c }) => { const r = res.get(c); return { name: a.name, dps: bestDps(r), ehp: r?.output?.TotalEHP ?? 0, ok: !!r && !r.error }; }).filter(x => x.ok);
  const offence = auraRows.filter(x => x.dps > d0 * 1.02).sort((a, b) => b.dps - a.dps)[0] ?? null;
  const defence = auraRows.filter(x => x.name !== offence?.name && x.ehp > e0 * 1.02).sort((a, b) => b.ehp - a.ehp)[0] ?? null;
  const hexRows = hexChanges.map(({ h, c }) => { const r = res.get(c); return { name: h.name, dps: bestDps(r), ok: !!r && !r.error }; }).filter(x => x.ok).sort((a, b) => b.dps - a.dps);
  return { base_dps: round(d0), base_ehp: round(e0), offence: offence && { ...offence, gain_pct: round((offence.dps / d0 - 1) * 100, 1) }, defence: defence && { ...defence, gain_pct: round((defence.ehp / e0 - 1) * 100, 1) },
    curse: needCurse ? (hexRows[0] ? { name: hexRows[0].name, with: blasphemy ? 'Blasphemy' : null, gain_pct: d0 > 0 ? round((hexRows[0].dps / d0 - 1) * 100, 1) : null } : null) : undefined,
    aura_candidates: auraRows.length, hex_candidates: hexRows.length, truncated: res.truncated };
}

// ---------- evaluation ----------
function summarise(final, boss, rare, gem, groups) {
  const o = final.output ?? {};
  const warnings = final.engine_warnings ?? [];
  const minion = !!final.main_skill?.minion || (!(bestDps({ output: o }) > 0) && !!final.minion_output);
  const buttons = B.countButtons(groups);
  const res = ['FireResist', 'ColdResist', 'LightningResist'].map(k => o[k] ?? null);
  return {
    dps: round(bestDps(final)), boss_dps: round(boss?.damage?.best_dps), rare_dps: round(rare?.damage?.best_dps), dps_scope: boss?.damage?.scope ?? null, dps_basis: boss?.damage?.dps_basis ?? null,
    boss_ttk_s: boss?.damage?.time_to_kill_s ?? null, boss_ttk_range_s: boss?.damage?.time_to_kill_range_s ?? null,
    weakest_max_hit: rare ? Math.min(...Object.values(rare.defence.max_hit).filter(v => v != null)) : null, weakest_type: rare?.defence?.weakest_type ?? null,
    max_hit: rare?.defence?.max_hit ?? null, ehp: round(o.TotalEHP), hits_to_die_rare: rare?.defence?.hits_to_die ?? null, hits_to_die_boss: boss?.defence?.hits_to_die ?? null,
    life: o.Life ?? null, energy_shield: o.EnergyShield ?? null, life_unreserved: o.LifeUnreserved ?? null,
    resists: { fire: res[0], cold: res[1], lightning: res[2], chaos: o.ChaosResist ?? null }, resists_capped: Math.min(...res.map(v => v ?? -100)),
    mana_cost: o.ManaCost ?? null, mana_unreserved: o.ManaUnreserved ?? null, mana_sustain: round(coreMetrics.mana_sustain.read(o), 1),
    explosions: (final.explode_mods ?? []).map(e => ({ source: e.source_name, chance: e.chance, pct_life: e.amount, type: e.type, conditions: e.conditions })),
    clear_score: B.clearScore([...gem.types, ...gem.minion_types], (final.explode_mods ?? []).length),
    buttons: buttons.pressed, buttons_detail: buttons, minion,
    unmet_requirements: warnings.filter(w => /do not meet/i.test(w)), skill_disabled: final.skill_disabled_reason ?? null,
    // Flask activation triggers ("Used when Charges reach full", the kit's automatic flasks) carry no stat: PoB leaves
    // them unparsed and models them through the slot's active flag, so they are not unparsed kit modifiers.
    unparsed_item_mods: (final.unparsed_item_modifiers ?? []).filter(u => !(/^Flask \d/.test(u.slot ?? '') && /^Used when /.test(u.line ?? ''))).length, engine_warnings: warnings,
    budget: final.budget ?? null
  };
}

function blueprintOf({ row, request, proto, sup, util, finalGroups, m }) {
  const g = proto.gem;
  const enablerParts = [];
  if (util.curse) enablerParts.push(`${util.curse.name}${util.curse.with ? ` + ${util.curse.with}` : ''}`);
  const clear = [];
  const t = new Set([...g.types, ...g.minion_types]);
  if (t.has('Minion') || t.has('CreatesMinion')) clear.push({ kind: 'minions', source: g.name, requires: [], status: 'engine_dps' });
  if (t.has('Area') && !t.has('Minion')) clear.push({ kind: 'skill_area', source: g.name, requires: [], status: 'engine_dps' });
  if (t.has('Projectile')) clear.push({ kind: 'projectiles', source: g.name, requires: [], status: 'engine_dps' });
  for (const e of m.explosions) clear.push({ kind: 'on_kill_explosion', source: e.source, requires: e.conditions ?? [], status: 'engine_reported_not_in_dps' });
  if (!clear.length) clear.push({ kind: 'single_target', source: g.name, requires: [], status: 'engine_dps' });
  return B.validateBlueprint({
    schema: B.BLUEPRINT_SCHEMA, id: row.id, class: row.class, ascendancy: row.ascendancy, request_source: request.source,
    damage_chain: { source: { skill: g.name, gem_id: g.id, types: g.types, minion_types: g.minion_types }, form: row.form, damage_types: row.damage_types,
      delivery_supports: sup.chosen, conversions: [], conditions: m.explosions.flatMap(e => e.conditions ?? []) },
    scaling_axes: proto.tree.axes.map(a => ({ axis: a.axis, weight: a.weight, notables: proto.tree.main_picks.filter(p => p.axes.includes(a.axis)).map(p => p.name) })),
    clear_mechanism: clear,
    defence_layers: [
      { layer: 'pool', detail: `life on every kit item + tree life nodes (${m.life} life, ${m.energy_shield} ES)` },
      { layer: 'resistances', detail: `kit resistances: fire ${m.resists.fire}, cold ${m.resists.cold}, lightning ${m.resists.lightning}, chaos ${m.resists.chaos}` },
      ...(util.defence ? [{ layer: 'mitigation', detail: `${util.defence.name} (+${util.defence.gain_pct}% EHP in probe)` }] : []),
      ...(proto.tree.ascendancy_picks.length ? [{ layer: 'recovery', detail: `ascendancy: ${proto.tree.ascendancy_picks.map(p => p.name).join(', ')} (recovery not separately modelled)` }] : [])
    ],
    resources: { mana_cost: m.mana_cost, mana_unreserved: m.mana_unreserved, mana_sustain_per_s: m.mana_sustain, reservation: [util.offence?.name, util.defence?.name, util.curse?.name].filter(Boolean), attributes_from: 'kit amulet/ring + class start' },
    uptime: { buttons_planned: m.buttons, pressed: m.buttons_detail.skills, recast_on_duration: m.buttons_detail.recast_on_duration, auto: enablerParts },
    components: {
      core: [g.name, ...proto.tree.ascendancy_picks.filter(p => p.axes.some(a => a.startsWith('theme:'))).map(p => p.name)],
      implementation: [...sup.chosen, ...proto.tree.ascendancy_picks.filter(p => !p.axes.some(a => a.startsWith('theme:'))).map(p => p.name), ...enablerParts],
      replaceable: [...proto.kit.bases, ...[util.offence?.name, util.defence?.name].filter(Boolean)]
    },
    success_criteria: B.successCriteria(request),
    assumptions: [...request.assumptions, `generic rare kit (tier ${KIT_TIER} mods from each base legal pool, ilvl 84, mid rolls), gems 20/20, no uniques; eldritch implicits (Exarch + Eater, tier 4 of 6, no Presence variants) on helmet/body/gloves/boots chosen by axis value; 5 kit flasks (utility automatic: Used when Charges reach full, charge sustain not modelled); masteries and one cluster jewel (PoB data enchant + legal notables), optionally with a smaller cluster in its inner socket, only where the corpus norm uses them and PoB shows a gain`, 'tree: greedy notable allocation by axis value per point, not optimised (WP6)', 'core/implementation split is the generator plan, not an ablation result (run analyze ablate on the XML)'],
    not_modelled: ['clear speed (clear_score is a documented heuristic)', ...(m.explosions.length ? ['on-kill explosion damage is reported by PoB but not part of DPS'] : []), 'boss life per boss (TTK uses enemy database estimates)', 'prices of rare items (no offline rare prices)'],
    groups: finalGroups.map(gr => ({ label: gr.label, slot: gr.slot, gems: gr.gems.map(x => x.name) }))
  });
}

// Generic repairs after the first final run, each one engine-checked and reported:
//  1. attributes PoB reports as unmet -> the kit jewellery takes those attribute suffixes;
//  2. flask-free mana deficit (profile constraint) -> best aura that makes mana sustained (probed), else drop
//     the last-chosen (smallest probe gain) supports, at most two.
const unmetAttrs = r => [...new Set((r?.engine_warnings ?? []).map(w => /do not meet the (Strength|Dexterity|Intelligence) requirement/i.exec(w)?.[1]).filter(Boolean))].map(a => a.slice(0, 3).toLowerCase());
const sustainOf = r => coreMetrics.mana_sustain.read(r?.output ?? {});
const cannotPay = r => { const o = r?.output ?? {}; return o.ManaUnreserved != null && o.ManaCost != null && o.ManaUnreserved < o.ManaCost; };
function repairPrototype({ file, row, request, t, gems, budget, concurrency, state, cards = null, ctx = null, manaBudget = null }) {
  let { final, finalChanges, proto, sup, util } = state;
  const steps = [];
  let anoint = null, manaRounds = 0;
  const run1 = c => { budget.take(1); return runPob({ input: fs.readFileSync(file), scenario: 'sustained', changes: c }); };
  // Mana first: a repair aura can add attribute requirements, which the attribute repair then covers.
  const minion = proto.gem.types.includes('Minion') || proto.gem.types.includes('CreatesMinion');
  // WP11: any self-cast/attack deficit -> corpus-derived candidates probed by PoB (design-layers.mjs).
  if (ctx && !minion && (sustainOf(final) ?? 0) < 0 && budget.left() > 0) {
    const m = repairManaFromCorpus({ ctx, file, row, request, t, gems, budget: manaBudget ?? budget, state: { final, finalChanges, proto }, cards });
    steps.push(...m.steps); ({ final, finalChanges } = m.state); anoint = m.anoint; manaRounds = m.rounds_run ?? 0;
    sup.chosen = finalChanges.skills.add_groups[0].gems.slice(1).map(x => x.name);
  }
  if (request.constraints?.no_mana_flask && !minion && sustainOf(final) < 0 && budget.left() > 0) {
    // Loop (at most 4 rounds): probe a mana aura in either aura slot; if none makes mana sustained, probe removing
    // each support and keep the best variant (most DPS among sustained, else best balance), then try again.
    const { auras } = utilityPools(gems);
    let main = finalChanges.skills.add_groups[0];
    for (let round_ = 0; round_ < 4 && sustainOf(final) < 0 && budget.left() > 0; round_++) {
      const before = round(sustainOf(final), 1);
      const cands = ['Aura 2', 'Aura'].flatMap(label => { const others = finalChanges.skills.add_groups.filter(g => g.label !== label);
        return auras.map(a => ({ a, slot: label, c: { ...finalChanges, skills: { add_groups: [...others, { label, slot: label === 'Aura' ? 'Gloves' : 'Boots', gems: [gemSpec(a)] }] } } })); });
      const res = batch(file, cands.map(x => x.c), budget, concurrency);
      const best = cands.map(x => ({ ...x, r: res.get?.(x.c) })).filter(x => x.r && !x.r.error && sustainOf(x.r) >= 0 && !cannotPay(x.r)).sort((p, q) => bestDps(q.r) - bestDps(p.r))[0];
      if (best) {
        finalChanges = best.c; final = best.r;
        const replaced = best.slot === 'Aura' ? util.offence?.name : util.defence?.name;
        steps.push({ step: 'mana_aura', aura: best.a.name, slot: best.slot, replaced: replaced ?? null, sustain_before: before, sustain_after: round(sustainOf(final), 1) });
        if (best.slot === 'Aura') util.offence = { name: best.a.name, gain_pct: null, purpose: 'mana sustain repair' }; else util.defence = { name: best.a.name, gain_pct: null, purpose: 'mana sustain repair' };
        break;
      }
      if (main.gems.length <= 2 || budget.left() <= 0) break;
      const variants = main.gems.slice(1).map((gem, i) => ({ removed: gem.name, main: { ...main, gems: main.gems.filter((_, j) => j !== i + 1) } }))
        .map(v => ({ ...v, c: { ...finalChanges, skills: { add_groups: [v.main, ...finalChanges.skills.add_groups.slice(1)] } } }));
      const rr = batch(file, variants.map(v => v.c), budget, concurrency);
      const rows = variants.map(v => ({ ...v, r: rr.get?.(v.c) })).filter(v => v.r && !v.r.error);
      if (!rows.length) break;
      const ok = rows.filter(v => sustainOf(v.r) >= 0).sort((p, q) => bestDps(q.r) - bestDps(p.r));
      const pick = ok[0] ?? rows.sort((p, q) => sustainOf(q.r) - sustainOf(p.r))[0];
      main = pick.main; finalChanges = pick.c; final = pick.r;
      steps.push({ step: 'drop_support', removed: pick.removed, sustain_after: round(sustainOf(final), 1), dps_after: round(bestDps(final)) });
    }
    sup.chosen = finalChanges.skills.add_groups[0].gems.slice(1).map(x => x.name);
  }
  const need = unmetAttrs(final);
  if (need.length && budget.left() > 0) {
    const p2 = prototypeChanges(row, request, t, gems, { needAttrs: need, mana: proto.mana ?? {} });
    // The amulet keeps an anoint a repair put on it.
    const oldAm = finalChanges.replace_items.find(i => i.slot === 'Amulet'), an = currentAnoint(oldAm?.text);
    const items = p2.changes.replace_items.map(i => i.slot === 'Amulet' && an ? { ...i, text: withAnoint(i.text, an) ?? i.text } : i);
    const c2 = { ...finalChanges, replace_items: items };
    const r2 = run1(c2);
    steps.push({ step: 'attributes', need, resolved: !unmetAttrs(r2).length });
    finalChanges = c2; final = r2; proto.kit = p2.kit; proto.kitArgs = p2.kitArgs;
    // Second step: still unmet -> regrow the tree with an attribute axis for the missing attributes.
    const still = unmetAttrs(r2);
    if (still.length && budget.left() > 0) {
      const cl = proto.cluster?.chosen;
      const p3 = prototypeChanges(row, request, t, gems, { needAttrs: need, treeAttrs: still, reserve: (finalChanges.tree?.masteries ?? []).length + (cl ? CLUSTER_RESERVE : 0), force: proto.force ?? [], mana: proto.mana ?? {} });
      // Keep chosen masteries whose tree group is still allocated in the regrown tree, and the cluster socket.
      const groups = new Set(p3.changes.tree.allocate.map(id => t.nodes.get(Number(id))?.group));
      const keep = (finalChanges.tree?.masteries ?? []).filter(m => groups.has(t.nodes.get(Number(m.node))?.group));
      const c3 = { ...finalChanges, tree: { ...p3.changes.tree, allocate: [...p3.changes.tree.allocate, ...(cl ? [cl.socket] : [])], ...(keep.length ? { masteries: keep } : {}) } };
      const r3 = run1(c3);
      steps.push({ step: 'attribute_tree', need: still, resolved: !unmetAttrs(r3).length, dps_after: round(bestDps(r3)) });
      finalChanges = c3; final = r3; proto.tree = p3.tree;
    }
  }
  // WP11: a deficit that survives every repair round is an explicit condition of the prototype, not only a norm warning.
  const conditions = [];
  if (!minion) { const c = manaCondition(sustainOf(final), manaRounds); if (c) { conditions.push(c); steps.push({ step: 'mana_unresolved', rounds: manaRounds, sustain: round(sustainOf(final), 1), condition: c.code }); } }
  return { steps, state: { final, finalChanges }, anoint, conditions };
}

function evaluateArchitecture({ dir, row, request, t, gems, budget, concurrency, links, masteryReserve = 0, cards = null }) {
  // WP11: the prototype's budget share is split into step caps; what a step leaves stays for the next steps/prototypes.
  const S = budget.max;
  const part = (f, min = 4) => budget.sub(Math.max(min, Math.floor(S * f)));
  const ctx = { batch: (f, l, b) => batch(f, l, b, concurrency), prototypeChanges, gemSpec, withGroup, CLUSTER_RESERVE };
  const file = classBase(dir, row.class, row.ascendancy, request.level);
  const clusterReserve = clusterReserveFor(row, gems.get(row.gem), cards);
  // Cluster layer: the reserve tree + cluster against the same points spent on ordinary nodes (altProto).
  const altProto = prototypeChanges(row, request, t, gems, { reserve: masteryReserve });
  let proto = clusterReserve ? prototypeChanges(row, request, t, gems, { reserve: masteryReserve + clusterReserve }) : altProto;
  const cluster = probeClusters({ file, base: proto.changes, alt: altProto.changes, t, row, axes: proto.tree.axes, budget: part(0.12), concurrency, reserve: clusterReserve });
  if (cluster.chosen) proto.changes = withCluster(proto.changes, cluster.chosen);
  else proto = altProto;
  proto.cluster = cluster;
  const layers = [cluster.layer];
  const sup = probeSupports({ file, base: proto.changes, g: proto.gem, request, gems, budget: part(0.22), concurrency, links });
  const withSup = { ...proto.changes, skills: { add_groups: [{ ...proto.changes.skills.add_groups[0], gems: [gemSpec(proto.gem), ...sup.chosen.map(n => gemSpec([...gems.values()].find(x => x.name === n && x.is_support)))] }] } };
  const needCurse = proto.tree.enablers.includes('curse');
  const util = probeUtility({ file, base: withSup, request, gems, budget: part(0.15), concurrency, needCurse });
  // Final: add utilities; drop the defensive then the offensive aura if the main skill can no longer be paid for.
  const groupsFor = (useOff, useDef) => [
    ...(util.curse ? [{ label: 'Curse aura', slot: 'Helmet', gems: [{ name: util.curse.name, level: 20, quality: 20 }, ...(util.curse.with ? [{ name: util.curse.with, level: 20, quality: 20 }] : [])] }] : []),
    ...(useOff && util.offence ? [{ label: 'Aura', slot: 'Gloves', gems: [{ name: util.offence.name, level: 20, quality: 20 }] }] : []),
    ...(useDef && util.defence ? [{ label: 'Aura 2', slot: 'Boots', gems: [{ name: util.defence.name, level: 20, quality: 20 }] }] : [])];
  let final = null, finalChanges = null, dropped = [];
  for (const [off, def] of [[true, true], [true, false], [false, false]]) {
    finalChanges = { ...withSup, skills: { add_groups: [...withSup.skills.add_groups, ...groupsFor(off, def)] } };
    if (budget.left() <= 0) break;
    final = runPob({ input: fs.readFileSync(file), scenario: 'sustained', changes: finalChanges });
    budget.take(1);
    const o = final.output ?? {};
    if (!(o.ManaUnreserved != null && o.ManaCost != null && o.ManaUnreserved < o.ManaCost) && !((o.LifeUnreserved ?? 1) <= 0)) break;
    dropped.push(def && util.defence ? util.defence.name : util.offence?.name);
  }
  if (!final) return { id: row.id, status: 'not_evaluated', reason: 'calculation budget exhausted' };
  // WP5b: spend the mastery reserve on PoB-probed mastery effects (after auras: mana sustain depends on them).
  const masteries = probeMasteries({ file, base: finalChanges, t, budget: part(0.15), concurrency, count: masteryReserve });
  if (masteries.chosen.length && budget.left() > 0) {
    const c = withMasteries(finalChanges, masteries.chosen);
    const r = runPob({ input: fs.readFileSync(file), scenario: 'sustained', changes: c });
    budget.take(1);
    if (!r.error) { finalChanges = c; final = r; } else masteries.chosen = [];
  }
  // WP11 masteries layer: the chosen effects against the same points on ordinary tree nodes (tree regrown without
  // the mastery reserve, cluster kept). Without chosen masteries the reserve goes back to the tree.
  if (masteryReserve > 0 && budget.left() > 0) {
    const p = prototypeChanges(row, request, t, gems, { reserve: cluster.chosen ? CLUSTER_RESERVE : 0 });
    const { masteries: _m, ...tree } = { ...finalChanges.tree, ...p.changes.tree, allocate: [...p.changes.tree.allocate, ...(cluster.chosen ? [cluster.chosen.socket] : [])] };
    const altC = { ...finalChanges, tree };
    budget.take(1);
    const altR = runPob({ input: fs.readFileSync(file), scenario: 'sustained', changes: altC });
    const altText = `the same ${masteryReserve} points on ordinary tree nodes`;
    if (altR.error) layers.push(layerRecord('masteries', masteries.chosen.length > 0, null, altText, `alternative failed in PoB: ${String(altR.error).slice(0, 120)}`, { decided_by: 'alternative_failed' }));
    else if (!masteries.chosen.length) {
      finalChanges = altC; final = altR; proto.tree = p.tree;
      layers.push(layerRecord('masteries', false, null, altText, `${masteries.reason ?? 'no mastery effect improved the prototype'}; reserve returned to the tree`,
        { decided_by: masteries.probes > 0 ? 'pob_probe' : masteries.reason === 'budget' ? 'budget' : 'no_option' }));
    } else {
      const d = decideLayer(valueOf(final), valueOf(altR));
      layers.push(layerRecord('masteries', d.taken, d.gain, altText, d.taken ? `${masteries.chosen.length} effects beat the tree${d.guard ? ` (${d.guard})` : ''}` : `${masteries.chosen.length} effects do not beat the tree: points returned to ordinary nodes`,
        { effects: masteries.chosen.map(m => `${m.name}: ${m.text}`) }));
      if (!d.taken) { finalChanges = altC; final = altR; proto.tree = p.tree; masteries.chosen = []; }
    }
  } else layers.push(layerRecord('masteries', false, null, 'points on the tree', masteryReserve > 0 ? 'not probed (calculation budget)' : 'corpus norm median masteries is 0: no reserve',
    { decided_by: masteryReserve > 0 ? 'budget' : 'no_option' }));
  proto.masteries = masteries;
  // The mana share must hold three repair rounds (design-layers probeCap splits it), hence the floor of 12 calculations.
  const repairs = repairPrototype({ file, row, request, t, gems, budget, concurrency, state: { final, finalChanges, proto, sup, util }, cards, ctx, manaBudget: part(0.16, 12) });
  ({ final, finalChanges } = repairs.state);
  // WP11 kit layers on the finished kit: eldritch implicits, automatic flasks, anoint.
  let normAnoints = [];
  try { normAnoints = chooseNormGroup({ cards: cards ?? undefined, ascendancy: row.ascendancy, family: B.damageFormOf(proto.gem) === 'minion' ? 'minion' : proto.gem.types.includes('Attack') ? 'attack' : 'spell' }).norms.anoint.top.map(x => x.value); } catch { normAnoints = []; }
  const kit = probeKitLayers({ ctx, file, final, finalChanges, proto, row, budget: part(0.12), normAnoints, anointTaken: repairs.anoint });
  ({ final, finalChanges } = kit);
  layers.push(...kit.layers);
  const finalGroups = finalChanges.skills.add_groups.map(gr => typedGroup(gr, gems));
  const done = finishPrototype({ id: row.id, dir, file, final, finalChanges, request, row, budget, concurrency, proto, finalGroups, layers });
  const blueprint = blueprintOf({ row, request, proto, sup, util, finalGroups, m: done.metrics });
  return { ...done, blueprint, layers, tree: { main_notables: proto.tree.main_picks.map(p => p.name), ascendancy: proto.tree.ascendancy_picks.map(p => p.name), unspent: proto.tree.unspent, enablers: proto.tree.enablers, forced: proto.tree.forced ?? [],
      cluster: proto.cluster?.chosen ? `${proto.cluster.chosen.size} ${proto.cluster.chosen.name} in socket ${proto.cluster.chosen.socket}: ${proto.cluster.chosen.notables.map(n => n.name).join(', ')}${proto.cluster.chosen.nested ? `; ${proto.cluster.chosen.nested.size} ${proto.cluster.chosen.nested.name} in inner socket ${proto.cluster.chosen.inner_socket}: ${proto.cluster.chosen.nested.notables.map(n => n.name).join(', ')}` : ''}` : null,
      cluster_probe: proto.cluster ? { probes: proto.cluster.probes, reserve: proto.cluster.reserve ?? 0, reason: proto.cluster.reason, top: proto.cluster.top } : null,
      masteries: proto.masteries?.chosen?.map(m => `${m.name}: ${m.text}`) ?? [], mastery_probe: proto.masteries ? { probes: proto.masteries.probes, reserve: proto.masteries.reserve, reason: proto.masteries.reason, top: proto.masteries.top } : null },
    supports: sup, utility: { ...util, dropped_for_mana: dropped.filter(Boolean) }, repairs: repairs.steps, conditions: repairs.conditions ?? [], kit_notes: proto.kit.notes };
}

// WP11 stage 1: a power layer the generator rejected by a PoB comparison must not return as a corpus-norm warning.
// The basics check only counts layers; the layer decision says why the count is what it is. Such a warning becomes a
// recorded decision ("rejected by calculation, gain vs alternative X%"). Only a layer whose record says it was
// decided by PoB probes (decided_by) is reconciled: with no option, no budget, or an author's seed nothing was
// compared, so the warning stands.
export const LAYER_OF_WARNING = { masteries_low: 'masteries', no_cluster_jewels: 'cluster', no_eldritch_implicits: 'eldritch', no_auto_flasks: 'flasks', no_anoint: 'anoint' };
export function reconcileFoundation(check, layers = []) {
  if (!check || !Array.isArray(check.warnings) || !check.warnings.length || !layers?.length) return check;
  const byLayer = new Map(layers.filter(l => l?.layer).map(l => [l.layer, l]));
  const kept = [], decided = [];
  for (const w of check.warnings) {
    const l = byLayer.get(LAYER_OF_WARNING[w.code]);
    if (!(l && l.taken === false && l.decided_by === 'pob_probe')) { kept.push(w); continue; }
    const total = l.gain_vs_alternative?.total;
    decided.push({ code: w.code, layer: l.layer, detail: w.detail,
      decision: `rejected by PoB calculation${total != null ? `: gain vs alternative ${total > 0 ? '+' : ''}${total}%` : ''} (alternative: ${l.alternative}); ${l.reason}` });
  }
  if (!decided.length) return check;
  const counts = { fail: kept.filter(x => x.severity === 'fail').length, warn: kept.filter(x => x.severity === 'warn').length, info: kept.filter(x => x.severity === 'info').length };
  return { ...check, warnings: kept, layer_decisions: decided, counts, status: counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok' };
}

const typedGroup = (gr, gems) => ({ ...gr, gems: gr.gems.map(x => { const k = [...gems.values()].find(y => y.name === x.name); return { ...x, types: k && !k.is_support ? k.types : null, role: /Curse/i.test(gr.label ?? '') ? 'enabler_auto' : null }; }) });
// Shared tail: save the prototype XML, encounters, hard filters, WP9 mechanic rules, WP5b foundation check.
function finishPrototype({ id, dir, file, final, finalChanges, request, row, budget, concurrency, proto, finalGroups, authorItems = false, layers = [] }) {
  const xml = path.join(dir, 'prototypes', `${id}.xml`);
  fs.mkdirSync(path.dirname(xml), { recursive: true });
  if (fs.existsSync(xml)) fs.rmSync(xml);
  runPob({ input: fs.readFileSync(file), scenario: 'sustained', changes: finalChanges, saveXml: xml }); // cache hit
  let boss = null, rare = null;
  if (budget.left() >= 2) {
    boss = analyzeEncounter({ file: xml, spec: { enemy: 'map_boss', tier: request.map_tier, mods: [] }, concurrency });
    rare = analyzeEncounter({ file: xml, spec: { enemy: 'rare', tier: request.map_tier, mods: [] }, concurrency });
    budget.take(2);
  }
  const m = summarise(final, boss, rare, proto.gem, finalGroups);
  let failures = B.hardFilters(m, request);
  // Author items of a corpus seed: unparsed mods are the author's (PoB numbers are a lower bound), not a generator kit error.
  if (authorItems) failures = failures.filter(f => f.code !== 'unparsed_item_mods');
  // WP9 mechanic rules (curse for Profane Bloom, Blasphemy hex, curse limit, corpses...): fail = hard failure.
  let mechanics = null;
  try {
    mechanics = validatePrototype(specFromInspect(inspectBuild(fs.readFileSync(xml)), final));
    for (const c of mechanics.checks.filter(c => c.status === 'fail')) failures.push({ code: `mechanic_${c.id}`, detail: c.evidence ?? "" });
  } catch (e) { mechanics = { error: e.message.slice(0, 300) }; }
  // WP5b: build basics vs corpus norms of the ascendancy (warnings only; norms describe guides, not the optimum).
  let foundation = null;
  try { const fr = foundationReport({ file: xml, ascendancy: row.ascendancy ?? null }); foundation = { ...reconcileFoundation(fr.check, layers), norm_group: fr.norm_group, profile: fr.foundation }; }
  catch (e) { foundation = { error: e.message.slice(0, 300) }; }
  return { id, status: failures.length ? 'rejected' : 'passed', failures, metrics: m, xml: path.relative(projectRoot, xml),
    calculation_id: final.calculation_id, encounters: { boss: boss?.calculation_id ?? null, rare: rare?.calculation_id ?? null },
    mechanics: mechanics && (mechanics.error ? mechanics : { valid: mechanics.valid, counts: mechanics.counts, flagged: mechanics.checks.filter(c => ['fail', 'warn'].includes(c.status)) }), foundation };
}

// WP5b item 3: seeded prototype. The closest corpus build of the ascendancy (design-seed.mjs) keeps its tree, items,
// jewels, flasks, masteries and utility groups; its main group is replaced by the candidate skill with supports probed
// by PoB in the same socket group. No tree growth, no generic kit, no generator repairs: the basics are the author's.
export function groupRoles(groups, gems) {
  const byName = new Map([...gems.values()].map(x => [`${x.is_support ? 's' : 'a'}:${x.name}`, x]));
  const reservation = [], utility = [];
  for (const gr of groups) {
    const actives = gr.gems.map(y => byName.get(`a:${y.name}`)).filter(Boolean);
    const reserving = gr.gems.some(y => (byName.get(`s:${y.name}`)?.support_gem?.added_types ?? []).includes('HasReservation'));
    for (const a of actives) (reserving || a.types.includes('HasReservation') ? reservation : utility).push(a.name);
  }
  return { reservation, utility };
}
// WP11 stage 1: the steps after the support probe (final run, encounters, button estimate) must always be paid for,
// so the probe pool gets a sub-share and what the tail needs stays with the job. A share below the job minimum is
// reported as such instead of letting the job die half-way with "budget exhausted".
export const SEED_TAIL_CALCS = 4;                        // final run + boss and rare encounters + headroom
export const SEED_MIN_CALCS = 1 + SEED_TAIL_CALCS + 4;   // config run + tail + bare group and three support probes
export const JOB_MIN_CALCS = { scratch: 0, seed: SEED_MIN_CALCS };
function evaluateSeeded({ dir, row, request, gems, budget, concurrency, links, seed }) {
  const id = `${row.id}--seed`;
  const file = seed.xml;
  const build = readBuild(file);
  const idx = seed.main_group ?? build.main_socket_group;
  const grp = build.groups[idx - 1];
  if (!grp) return { id, status: 'not_evaluated', reason: `seed ${seed.file}: main group ${idx} not found` };
  if (grp.source) return { id, status: 'not_evaluated', reason: `seed ${seed.file}: main group is granted by an item` };
  const g = gems.get(row.gem);
  const wc = weaponCompatible(slotItemText(fs.readFileSync(file, 'utf8')), g?.weapon_restrictions ?? []);
  if (!wc.ok) return { id, status: 'not_evaluated', reason: `seed ${seed.file}: the author's ${wc.weapon} cannot use ${row.skill} (weapon restrictions: ${g.weapon_restrictions.join(', ')})` };
  // Links: the seed group's own socket count (gems it held), capped by the request.
  const seedLinks = Math.max(2, Math.min(links, grp.gems.length));
  // WP11: the author's Configuration tab (charges, "been hit recently", enemy conditions, Pantheon) belongs to the
  // author's skill and play; the seed runs on PoB's new-build configuration like scratch prototypes (design-seed).
  if (budget.left() < SEED_MIN_CALCS) return { id, status: 'not_evaluated', reason: `budget share ${budget.left()} below the seed minimum of ${SEED_MIN_CALCS} calculations` };
  const defaults = runPob({ input: fs.readFileSync(classBase(dir, row.class, row.ascendancy, request.level)), scenario: 'sustained', full: true }).config ?? {};
  const author = runPob({ input: fs.readFileSync(file), scenario: 'sustained', full: true }).config ?? {};
  budget.take(1);
  const nc = neutralConfig(author, defaults, Object.keys(scenarios.sustained.config));
  const config = nc.config;
  let base = { config, skills: { remove_groups: [idx], add_groups: [{ label: 'Main', slot: grp.slot ?? 'Body Armour', main: true, gems: [gemSpec(g)] }] } };
  const supBudget = budget.sub(budget.left() - SEED_TAIL_CALCS);
  let sup = probeSupports({ file, base, g, request, gems, budget: supBudget, concurrency, links: seedLinks });
  // The seed slot can block linked supports (an item that grants its own support or forbids others). Then probe the
  // group without a slot: PoB applies the gems' supports, the item's socketed-gem modifiers are lost (reported).
  if (!sup.chosen.length && (sup.probes?.length ?? 0) <= 1 && grp.slot) {
    const free = { config, skills: { remove_groups: [idx], add_groups: [{ label: 'Main', main: true, gems: [gemSpec(g)] }] } };
    const sup2 = probeSupports({ file, base: free, g, request, gems, budget: supBudget, concurrency, links: seedLinks });
    if (sup2.chosen.length) { base = free; sup = { ...sup2, slot_note: `supports did not apply in ${grp.slot} (item-granted/blocked); group moved off the item, its socketed-gem bonuses no longer count` }; }
  }
  const finalChanges = { config, skills: { ...base.skills, add_groups: [{ ...base.skills.add_groups[0], gems: [gemSpec(g), ...sup.chosen.map(n => gemSpec([...gems.values()].find(x => x.name === n && x.is_support)))] }] } };
  if (budget.left() <= 0) return { id, status: 'not_evaluated', reason: 'calculation budget exhausted after the support probe' };
  const final = runPob({ input: fs.readFileSync(file), scenario: 'sustained', changes: finalChanges });
  budget.take(1);
  // Buttons: every enabled group of the seed except its replaced main group, plus the new main group.
  const kept = build.groups.filter(x => x.enabled && x.index !== idx && !x.source).map(x => ({ label: x.label, slot: x.slot, gems: x.gems.filter(y => y.enabled).map(y => ({ name: y.name })) }));
  const finalGroups = [...finalChanges.skills.add_groups, ...kept].map(gr => typedGroup(gr, gems));
  const proto = { gem: g };
  const done = finishPrototype({ id, dir, file, final, finalChanges, request, row, budget, concurrency, proto, finalGroups, authorItems: true });
  // Buttons of a seeded build: PoB's own active-skill flags (BuildCard rule), since the author's groups carry triggers,
  // item-granted skills and utility gems the generator's type rule cannot see.
  try {
    const full = runPob({ input: fs.readFileSync(path.join(projectRoot, done.xml)), scenario: 'sustained', full: true });
    const flasks = (full.equipped_items ?? []).filter(i => /^Flask \d/.test(i.slot)).map(i => ({ slot: i.slot, name: i.name, base: i.base, rarity: i.rarity, text: build.slots?.get(i.slot) ?? '' }));
    const be = buttonEstimate(full.active_skills, flasks, { mageblood: (full.equipped_items ?? []).some(i => /^Mageblood/.test(i.name ?? '')) });
    if (be.estimate != null) { done.metrics.buttons = be.minimum + be.skills.utility.filter(s => s.reason !== 'vaal').length; done.metrics.buttons_detail = { source: 'pob_active_skill_flags', pressed: be.skills.pressed.map(s => s.name), utility: be.skills.utility.map(s => s.name), estimate: be.estimate, minimum: be.minimum, maximum: be.maximum }; }
  } catch { /* keep the type-rule count */ }
  // Kept groups: reservation (an active gem with the HasReservation type, or a support adding it, e.g. Blasphemy) vs
  // other utility (movement, guard, minions, triggered skills): only the former is "auras".
  const split = groupRoles(kept, gems);
  const blueprint = { schema: B.BLUEPRINT_SCHEMA, id, class: row.class, ascendancy: row.ascendancy, damage_chain: { source: { skill: g.name, gem_id: g.id, types: g.types, minion_types: g.minion_types }, form: row.form, damage_types: row.damage_types, delivery_supports: sup.chosen },
    resources: { reservation: split.reservation, utility: split.utility }, seed,
    assumptions: [`seeded from corpus build ${seed.file} (${seed.main_skill}, level ${seed.level}); its tree, items, jewels, flasks, masteries and utility groups are kept unchanged`, 'only the main group is replaced; tree/items are not re-optimised for the new skill (WP6)',
      `configuration: PoB new-build defaults (author inputs reset: ${nc.reset.join(', ') || '-'}${nc.kept.length ? `; not reset: ${nc.kept.join(', ')}` : ''}); author custom modifier blocks are kept`] };
  // Seed layers are the author's: reported as kept (present in the author build) or absent, not re-probed.
  const fp = done.foundation?.profile ?? {};
  const authorLayer = (layer, present, detail) => layerRecord(layer, !!present, null, 'not compared: the seed is evaluated as the author built it', present ? `author build: ${detail}` : 'absent in the author build', { decided_by: 'author_build' });
  const layers = [layerRecord('configuration', true, null, "author's Configuration tab", `reset to PoB new-build defaults: ${nc.reset.length} inputs${nc.reset.length ? ` (${nc.reset.slice(0, 12).join(', ')}${nc.reset.length > 12 ? ', ...' : ''})` : ''}`, { decided_by: 'author_build' }),
    authorLayer('cluster', fp.clusters?.total, `${fp.clusters?.total} cluster jewels`), authorLayer('masteries', fp.masteries?.count, `${fp.masteries?.count} masteries`),
    authorLayer('eldritch', fp.eldritch?.items, `${fp.eldritch?.items} items with eldritch implicits`), authorLayer('flasks', fp.flasks?.auto, `${fp.flasks?.auto} automatic flasks`), authorLayer('anoint', fp.anoint, fp.anoint)];
  // The seed is evaluated as the author built it (no generator repairs), so a mana deficit is stated as a condition.
  const manaCond = done.metrics?.minion ? null : manaCondition(done.metrics?.mana_sustain, 0);
  return { ...done, blueprint, seed, layers, config_reset: nc, conditions: manaCond ? [manaCond] : [],
    budget_steps: { supports: { cap: supBudget.max, used: supBudget.used }, tail_reserved: SEED_TAIL_CALCS }, tree: { main_notables: [], ascendancy: [], unspent: null, enablers: [], source: 'corpus_seed' }, supports: sup, utility: { kept_groups: kept.map(x => x.label || x.gems[0]?.name).filter(Boolean), ...split }, repairs: [], kit_notes: [`seed: ${seed.file}`] };
}

// ---------- run ----------
// WP11 coverage: every requested ascendancy gets an equal screening quota (diversity key inside it); slots an
// ascendancy cannot fill go to the best remaining rows of any ascendancy.
export function screenQuota(pool, ascendancies, screen, keyOf) {
  const quota = Math.max(1, Math.floor(screen / Math.max(1, ascendancies.length)));
  const picked = ascendancies.flatMap(a => B.diversify(pool.filter(r => r.ascendancy === a), quota, keyOf));
  const ids = new Set(picked.map(r => r.id));
  return [...picked, ...B.diversify(pool.filter(r => !ids.has(r.id)), Math.max(0, screen - picked.length), keyOf)];
}
export const JOB_WEIGHT = { scratch: 4, seed: 1 };
// EHP note: PoB TotalEHP averages hits over avoidance (block, evasion, suppression); when it exceeds the weakest
// max hit by far, the pool against one big hit is what the weakest max hit says, not EHP.
export function prototypeFlags(m) {
  const flags = [];
  if (m?.ehp != null && m?.weakest_max_hit > 0 && m.ehp / m.weakest_max_hit > 20)
    flags.push('ehp_avoidance_dominated: EHP ' + Math.round(m.ehp) + ' is ' + Math.round(m.ehp / m.weakest_max_hit) + 'x the weakest max hit (block/evasion/suppression averaged); compare weakest max hit');
  if (!m?.minion && m?.mana_sustain != null && m.mana_sustain < 0)
    flags.push('mana_deficit: ' + m.mana_sustain + '/s; the reported DPS is not sustained by mana (holds in bursts only, or with a mana flask)');
  return flags;
}
export function generate({ request, limit = 6, screen = 24, budgetCalcs = 1000, concurrency = defaultConcurrency, out = null, links = 6, lab = true, onlyGems = null, seed = 'both', seedCards = () => null, novelty = true } = {}) {
  B.validateRequest(request);
  if (!['both', 'only', 'none'].includes(seed)) throw new Error('--seed must be both|only|none');
  if (!request.classes.length) throw new Error('request has no ascendancy; pass --ascendancy A[,B] or name one in the profile');
  const started = Date.now();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${slug(request.classes.map(c => c.ascendancy).join('-'))}`;
  const dir = path.resolve(out ?? path.join(projectRoot, 'research/lab/designs', runId));
  fs.mkdirSync(dir, { recursive: true });
  const t = loadTree(), gems = loadGems(), budget = new Budget(budgetCalcs);
  atomicJson(path.join(dir, 'request.json'), request);
  // 1. candidates (code), theme filter (relaxed when fewer than `limit` meet every requested theme)
  const cand = candidates(request, { gems, t });
  let pool = cand.rows.filter(r => !onlyGems || onlyGems.includes(r.gem));
  const full = pool.filter(r => !r.themes_missing.length);
  const themeFilter = request.themes.length ? (full.length >= limit ? 'all_themes_met' : 'relaxed') : 'none';
  if (request.themes.length && full.length >= limit) pool = full;
  const key = r => `${r.ascendancy}|${r.form}|${r.damage_types[0] ?? '-'}`;
  const toScreen = screenQuota(pool, request.classes.map(c => c.ascendancy), screen, key);
  // 2. screen: bare prototypes grouped by class base
  const screened = [];
  for (const asc of [...new Set(toScreen.map(r => r.ascendancy))]) {
    const rows = toScreen.filter(r => r.ascendancy === asc);
    const file = classBase(dir, rows[0].class, asc, request.level);
    const protos = rows.map(r => { try { return { r, p: prototypeChanges(r, request, t, gems) }; } catch (e) { return { r, error: e.message }; } });
    const okRows = protos.filter(x => !x.error);
    const res = batch(file, okRows.map(x => x.p.changes), budget, concurrency);
    for (const x of protos) {
      if (x.error) { screened.push({ ...x.r, screen_dps: null, screen_error: x.error }); continue; }
      const r = res.get?.(x.p.changes);
      screened.push({ ...x.r, screen_dps: r ? round(bestDps(r)) : null, screen_error: r?.error ?? (r ? null : 'not_run_budget'), screen_warnings: (r?.engine_warnings ?? []).filter(w => /do not meet|disabled/i.test(w)) });
    }
  }
  const viable = screened.filter(r => r.screen_dps > 0);
  // Final selection: diversity first, then screen DPS within the pre-engine score order.
  const ranked = viable.map(r => ({ ...r, score: r.score + Math.log10(1 + r.screen_dps) / 2 }));
  // Balanced across requested ascendancies (round robin), diversity key inside each.
  const perAsc = request.classes.map(c => B.diversify(ranked.filter(r => r.ascendancy === c.ascendancy), limit, key));
  const chosen = [];
  for (let i = 0; chosen.length < limit && perAsc.some(l => l.length > i); i++) for (const l of perAsc) if (l[i] && chosen.length < limit) chosen.push(l[i]);
  // 3. architectures. WP11 coverage: jobs in round-robin order over ascendancies; each job gets a share of what is
  // left, weighted by its kind (a scratch prototype probes ~4x more than a seed), so every chosen row is evaluated.
  const results = [];
  // Corpus cards are read once (norms, seeds, mana candidates).
  const cards = seedCards() ?? (() => { try { return readCards(); } catch { return null; } })();
  const jobs = [];
  for (const row of chosen) {
    const candidate = { score: row.score, themes_met: row.themes_met, reasons: row.reasons };
    if (seed !== 'only') jobs.push({ kind: 'scratch', row, candidate, weight: JOB_WEIGHT.scratch });
    if (seed !== 'none') {
      const s = seedsFor(row, gems.get(row.gem), { cards: cards ?? undefined, budgetDivine: /^div/i.test(request.budget?.currency ?? '') ? request.budget.amount : null })[0];
      if (!s) results.push({ id: row.id + '--seed', status: 'not_evaluated', reason: 'no corpus build of ' + row.ascendancy + ' similar to ' + row.skill });
      else jobs.push({ kind: 'seed', row, candidate, seed: s, weight: JOB_WEIGHT.seed });
    }
  }
  let weightLeft = jobs.reduce((x, j) => x + j.weight, 0);
  for (const job of jobs) {
    const share = budget.sub(Math.max(JOB_MIN_CALCS[job.kind] ?? 0, budget.left() * job.weight / weightLeft));
    weightLeft -= job.weight;
    const { row, candidate } = job;
    if (job.kind === 'scratch') {
      const masteryReserve = masteryReserveFor(row, gems.get(row.gem), cards);
      try { results.push({ ...evaluateArchitecture({ dir, row, request, t, gems, budget: share, concurrency, links, masteryReserve, cards }), candidate, budget_share: { cap: share.max, used: share.used } }); }
      catch (e) { results.push({ id: row.id, status: 'error', error: e.message.slice(0, 500) }); }
    } else {
      try { results.push({ ...evaluateSeeded({ dir, row, request, gems, budget: share, concurrency, links, seed: job.seed }), candidate, budget_share: { cap: share.max, used: share.used } }); }
      catch (e) { results.push({ id: row.id + '--seed', status: 'error', error: e.message.slice(0, 500), seed: job.seed.file }); }
    }
  }
  // 3b. WP8: structural novelty of every evaluated prototype against the quality-filtered corpus (BuildCard of the
  // prototype XML -> noveltyScore). A separate axis from performance; it joins the Pareto objectives.
  if (novelty) {
    let corpus = null;
    try { corpus = loadNoveltyCorpus().cards; } catch { corpus = null; }
    for (const r of results.filter(x => x.xml && x.metrics)) {
      try {
        const card = buildCard({ file: path.join(projectRoot, r.xml), scenario: 'sustained' });
        const s = noveltyScore(card, corpus ?? [], { top: 3 });
        r.metrics.novelty = s.novelty;
        r.novelty = { novelty: s.novelty, band: s.band, nearest: s.nearest.slice(0, 2).map(n => ({ card: n.card, distance: n.distance, main_skill: n.main_skill, ascendancy: n.ascendancy, source: n.source, differences: n.differences })) };
      } catch (e) { r.novelty = { error: e.message.slice(0, 300) }; }
    }
  }
  // 4. front over passing prototypes
  const passed = results.filter(r => r.status === 'passed').map(r => ({ id: r.id, ...r.metrics }));
  const objectives = novelty ? [...B.DEFAULT_OBJECTIVES, { key: 'novelty', dir: 'max' }] : B.DEFAULT_OBJECTIVES;
  const front = B.paretoFront(passed, objectives);
  // 5. lab: rejected prototypes become failure records
  const labRecords = [];
  if (lab) for (const r of results.filter(x => x.status === 'rejected')) {
    try {
      const rec = createRecord({ type: 'failure', title: `Design prototype rejected: ${r.blueprint.damage_chain.source.skill} ${r.blueprint.ascendancy}`.slice(0, 200),
        statement: r.failures.map(f => `${f.code}: ${f.detail}`).join('\n').slice(0, 4000),
        mechanism: 'WP5 generator hard filter on a PoB prototype (generic rare kit, greedy tree); a rejection of this implementation, not proof the architecture cannot work.',
        tags: ['design', 'wp5', ...r.failures.map(f => f.code)], scope: { skills: [r.blueprint.damage_chain.source.skill], ascendancies: [r.blueprint.ascendancy], archetypes: [r.blueprint.damage_chain.form] },
        evidence: [{ kind: 'calculation', ref: r.calculation_id, summary: `design run ${runId}: ${r.failures.map(f => f.code).join(', ')}` }],
        data: { run: runId, prototype: r.id, xml: r.xml, metrics: { dps: r.metrics.dps, boss_dps: r.metrics.boss_dps, ehp: r.metrics.ehp, mana_sustain: r.metrics.mana_sustain } } });
      labRecords.push(rec.id);
    } catch (e) { labRecords.push(`error: ${e.message.slice(0, 200)}`); }
  }
  const report = {
    game: 'poe1', patch: '3.30', analysis: 'design_generate', run: runId, dir: path.relative(projectRoot, dir), request,
    stages: { candidates: cand.rows.length, theme_filter: themeFilter, screened: screened.length, viable: viable.length, architectures: results.length, passed: passed.length },
    excluded_skills: cand.excluded,
    screen: screened.map(r => ({ id: r.id, skill: r.skill, ascendancy: r.ascendancy, form: r.form, damage: r.damage_types, score: r.score, themes_met: r.themes_met.map(x => `${x.theme}:${x.by}`), screen_dps: r.screen_dps, error: r.screen_error ?? undefined, warnings: r.screen_warnings?.length ? r.screen_warnings : undefined })),
    prototypes: results.map(r => r.status === 'passed' || r.status === 'rejected' ? {
      id: r.id, status: r.status, failures: r.failures, skill: r.blueprint.damage_chain.source.skill, ascendancy: r.blueprint.ascendancy, form: r.blueprint.damage_chain.form, damage: r.blueprint.damage_chain.damage_types,
      origin: r.seed ? 'corpus_seed' : 'scratch', novelty: r.novelty ?? null, seed: r.seed ? { file: r.seed.file, main_skill: r.seed.main_skill, score: r.seed.score, reasons: r.seed.reasons, source: r.seed.source } : undefined,
      foundation: r.foundation?.error ? r.foundation : r.foundation ? { status: r.foundation.status, counts: r.foundation.counts, warnings: r.foundation.warnings?.map(w => `${w.code}: ${w.detail}`),
        layer_decisions: r.foundation.layer_decisions?.map(d => `${d.code} (${d.detail}): ${d.decision}`) } : null,
      supports: r.supports.chosen, auras: r.blueprint.resources.reservation, utility_groups: r.blueprint.resources.utility ?? [], layers: r.layers ?? [], flags: prototypeFlags(r.metrics), conditions: r.conditions?.length ? r.conditions : undefined, config_reset: r.config_reset ? { reset: r.config_reset.reset, kept: r.config_reset.kept } : undefined, budget_share: r.budget_share, ascendancy_nodes: r.tree.ascendancy, repairs: r.repairs, mechanics: r.mechanics, xml: r.xml,
      metrics: { boss_dps: r.metrics.boss_dps, rare_dps: r.metrics.rare_dps, dps_scope: r.metrics.dps_scope, boss_ttk_s: r.metrics.boss_ttk_s ?? r.metrics.boss_ttk_range_s, weakest_max_hit: r.metrics.weakest_max_hit, weakest_type: r.metrics.weakest_type, ehp: r.metrics.ehp, hits_to_die_rare: r.metrics.hits_to_die_rare,
        life: r.metrics.life, resists: r.metrics.resists, mana_sustain: r.metrics.mana_sustain, buttons: r.metrics.buttons, clear_score: r.metrics.clear_score, explosions: r.metrics.explosions.map(e => `${e.source} ${Math.round((e.chance ?? 0) * 100)}% x ${e.pct_life}% life ${e.type}`) } } : r),
    coverage: request.classes.map(c => ({ ascendancy: c.ascendancy, screened: screened.filter(r => r.ascendancy === c.ascendancy).length, viable: viable.filter(r => r.ascendancy === c.ascendancy).length,
      evaluated: results.filter(r => r.metrics && r.blueprint?.ascendancy === c.ascendancy).length, not_evaluated: results.filter(r => !r.metrics && r.id.includes('--' + slug(c.ascendancy))).length })),
    front: front.front.map(r => r.id), dominated: front.dominated, objectives, lab_failures: labRecords,
    calculations: { used: budget.used, budget: budget.max }, timing_s: round((Date.now() - started) / 1000),
    disclaimer
  };
  atomicJson(path.join(dir, 'candidates.json'), { rows: cand.rows.slice(0, 200), excluded: cand.excluded, screened });
  for (const r of results) if (r.blueprint) atomicJson(path.join(dir, 'blueprints', `${r.id}.json`), { blueprint: r.blueprint, metrics: r.metrics, supports: r.supports, utility: r.utility, tree: r.tree, kit_notes: r.kit_notes, failures: r.failures });
  atomicJson(path.join(dir, 'report.json'), report);
  fs.writeFileSync(path.join(dir, 'report.md'), markdown(report), 'utf8');
  return report;
}

export function layerMarkdown(r) {
  const lines = [];
  if (r.coverage) lines.push('', '## Coverage', '', ...r.coverage.map(c => '- ' + c.ascendancy + ': screened ' + c.screened + ', with damage ' + c.viable + ', evaluated ' + c.evaluated + ', not evaluated ' + c.not_evaluated));
  const g = x => x ? ' (' + (x.total >= 0 ? '+' : '') + x.total + '% vs alternative: DPS ' + x.dps_pct + '%, EHP ' + x.ehp_pct + '%' + (x.ms_pct != null ? ', MS ' + x.ms_pct + '%' : '') + ')' : '';
  const withLayers = r.prototypes.filter(x => x.layers?.length);
  if (withLayers.length) lines.push('', '## Layer decisions', '');
  for (const p of withLayers) {
    lines.push('- **' + p.id + '**');
    for (const l of p.layers) lines.push('  - ' + l.layer + ': ' + (l.taken ? 'taken' : 'not taken') + g(l.gain_vs_alternative) + '; alternative: ' + l.alternative + '; ' + l.reason);
    for (const fl of p.flags ?? []) lines.push('  - flag: ' + fl);
    for (const st of (p.repairs ?? []).filter(x => x.step === 'mana_corpus')) lines.push('  - mana repair round ' + st.round + ': ' + (st.change ?? st.result) + ' (' + (st.sustain_before ?? st.sustain) + ' -> ' + (st.sustain_after ?? '-') + '/s)');
  }
  return lines;
}
export function markdown(r) {
  const n = v => v == null ? '-' : Math.round(v).toLocaleString('en-US');
  const lines = [`# Design run ${r.run}`, '', `Request: ${r.request.classes.map(c => c.ascendancy).join(', ')}; themes: ${r.request.themes.join(', ') || '-'}; level ${r.request.level}; T${r.request.map_tier}; buttons max ${r.request.buttons?.max ?? '-'}`, '',
    `Stages: ${r.stages.candidates} candidates -> ${r.stages.screened} screened -> ${r.stages.viable} with damage -> ${r.stages.architectures} prototypes -> ${r.stages.passed} passed. Calculations ${r.calculations.used}/${r.calculations.budget}, ${r.timing_s} s.`, '',
    '| Prototype | Origin | Status | Boss DPS | Rare DPS | Weakest max hit | EHP | Buttons | Clear | Mana/s | Basics | Novelty | Front |', '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|:---:|'];
  for (const p of r.prototypes) {
    if (!p.metrics) { lines.push(`| ${p.id} | | ${p.status} | ${p.error ?? p.reason ?? ''} ||||||||||`); continue; }
    const m = p.metrics;
    const basics = p.foundation?.counts ? `${p.foundation.status} (${p.foundation.counts.fail}f/${p.foundation.counts.warn}w)` : '-';
    lines.push(`| ${p.skill} / ${p.ascendancy} | ${p.origin === 'corpus_seed' ? `seed ${p.seed.file}` : 'scratch'} | ${p.status}${p.failures?.length ? ` (${p.failures.map(f => f.code).join(', ')})` : ''} | ${n(m.boss_dps)} | ${n(m.rare_dps)} | ${n(m.weakest_max_hit)} ${m.weakest_type ?? ''} | ${n(m.ehp)} | ${m.buttons} | ${m.clear_score} | ${m.mana_sustain ?? '-'} | ${basics} | ${p.novelty?.novelty != null ? `${p.novelty.novelty} ${p.novelty.band}` : '-'} | ${r.front.includes(p.id) ? 'yes' : ''} |`);
  }
  lines.push('', '## Prototypes');
  for (const p of r.prototypes.filter(x => x.metrics)) lines.push(`- **${p.skill} / ${p.ascendancy}** (${p.form}, ${p.damage.join('/')}): supports ${p.supports.join(', ') || '-'}; auras ${p.auras.join(', ') || '-'}${p.utility_groups?.length ? '; utility ' + p.utility_groups.join(', ') : ''}; ascendancy ${p.ascendancy_nodes.join(', ')}; explosions ${p.metrics.explosions.join('; ') || '-'}; \`${p.xml}\``);
  for (const p of r.prototypes.filter(x => x.foundation?.warnings?.length)) lines.push(`  - basics of ${p.id}: ${p.foundation.warnings.join('; ')}`);
  for (const p of r.prototypes.filter(x => x.foundation?.layer_decisions?.length)) lines.push(`  - basics of ${p.id} decided by calculation: ${p.foundation.layer_decisions.join('; ')}`);
  for (const p of r.prototypes.filter(x => x.conditions?.length)) lines.push(`  - **condition** on ${p.id}: ${p.conditions.map(c => `${c.code}: ${c.detail}`).join('; ')}`);
  lines.push(...layerMarkdown(r));
  lines.push('', `Lab failures:${r.lab_failures.join(', ') || '-'}`, '', r.disclaimer);
  return lines.join('\n') + '\n';
}

// ---------- reference check ----------
// Derive a request from a reference example's class/ascendancy and main skill *structure* (form and damage themes,
// never the skill name), run candidates + screen, and report where the reference main skill lands.
export function verifyExample({ id, limit = 6, screen = 24, budgetCalcs = 200, concurrency = defaultConcurrency, out = null, prototype = false }) {
  const db = referenceDb(undefined, { readOnly: true });
  let ex;
  try { ex = exampleQuery('get', id, db).results[0]; } finally { db.close(); }
  if (!ex) throw new Error(`Example ${id} not found`);
  if (ex.kind === 'quarantined') throw new Error('Quarantined examples cannot be used');
  const a = ex.audit;
  const group = a.skills[(a.main_socket_group ?? 1) - 1];
  const gems = loadGems();
  const main = group.gems.map(x => gems.get(x.skill_id)).find(g => g && !g.is_support);
  if (!main) throw new Error('Reference main group has no active gem known to the knowledge DB');
  // Structure only: delivery/form themes plus the primary damage type (a full damage-type set would identify the skill).
  const structural = ['minion', 'totem', 'trap', 'mine', 'brand', 'damage_over_time', 'projectile', 'melee', 'channelling'];
  const primary = (B.damageTypesOf(main)[0] ?? '').toLowerCase();
  const themes = B.skillThemes(main).filter(x => structural.includes(x) || x === primary);
  const request = B.validateRequest({ schema: B.REQUEST_SCHEMA, source: `example:${id}`, classes: [{ ascendancy: a.ascendancy }], themes, avoid_themes: [], level: Math.min(95, a.level ?? 92), map_tier: 16,
    buttons: { max: null, text: null }, constraints: {}, budget: null, platform: null, content: [], goals: [], assumptions: ['synthetic request derived from the reference class and main-skill structure; skill name withheld'] });
  const cand = candidates(request);
  const inTheme = cand.rows.filter(r => !r.themes_missing.length);
  const rankOf = list => { const i = list.findIndex(r => r.gem === main.id); return i < 0 ? null : i + 1; };
  const check = { reference: { skill: main.name, gem: main.id, ascendancy: a.ascendancy, kind: ex.kind }, request, candidates: cand.rows.length, theme_matching: inTheme.length,
    rank_all: rankOf(cand.rows), rank_theme: rankOf(inTheme) };
  if (prototype) {
    const rep = generate({ request, limit, screen, budgetCalcs, concurrency, out, lab: false, seed: 'none', novelty: false }); // a corpus seed could leak the reference build
    const screened = rep.screen.sort((x, y) => (y.screen_dps ?? 0) - (x.screen_dps ?? 0));
    check.generate = { run: rep.run, dir: rep.dir, screened: screened.length, reference_screened: screened.some(r => r.id.startsWith(`${slug(main.id)}--`)),
      reference_screen_rank: (() => { const i = screened.findIndex(r => r.id.startsWith(`${slug(main.id)}--`)); return i < 0 ? null : i + 1; })(),
      reference_prototyped: rep.prototypes.some(p => p.id?.startsWith(`${slug(main.id)}--`)), prototypes: rep.prototypes.map(p => p.id), front: rep.front };
  }
  check.reproduced = check.generate ? check.generate.reference_prototyped : check.rank_theme != null && check.rank_theme <= screen;
  check.note = 'Reproduced = the reference main skill reaches the prototype stage (with --prototype) or the screening pool; the generator never sees the skill name.';
  return check;
}

// ---------- CLI ----------
export function designCommand(rest) {
  const [op = 'help', ...args] = rest;
  if (op === 'optimize') return optimizeCommand(rest);
  if (op === 'reverse') return reverseCommand(rest);
  const { positional, options } = flags(args, ['profile', 'request', 'ascendancy', 'themes', 'limit', 'screen', 'budget-calcs', 'level', 'map-tier', 'out', 'concurrency', 'example', 'gems', 'links', 'seed'], ['no-lab', 'prototype', 'no-novelty']);
  const int = (v, d, name) => { if (v == null) return d; const x = Number(v); if (!Number.isInteger(x) || x < 1) throw new Error(`--${name} must be a positive integer`); return x; };
  if (op === 'help') return { usage: designHelp };
  if (op === 'request' || op === 'generate' || op === 'candidates') {
    let request;
    if (options.request) request = B.validateRequest(readJson(path.resolve(options.request)));
    else {
      // The system is not tied to one build: the request comes from an explicit profile or request file.
      if (!options.profile) throw new Error(`design ${op} needs --profile <build.json | build id> or --request <req.json>`);
      const prof = options.profile;
      const file = path.resolve(prof);
      const build = fs.existsSync(file) ? readJson(file) : loadBuild(prof);
      request = B.requestFromProfile(build, { level: options.level ? int(options.level, null, 'level') : null, mapTier: options['map-tier'] ? int(options['map-tier'], null, 'map-tier') : null });
    }
    if (options.ascendancy) request.classes = options.ascendancy.split(',').map(a => ({ ascendancy: a.trim() }));
    if (options.themes) request.themes = options.themes.split(',').map(s => s.trim()).filter(Boolean);
    B.validateRequest(request);
    if (op === 'request') return { request, blueprint_schema: B.BLUEPRINT_SCHEMA, success_criteria: B.successCriteria(request) };
    if (op === 'candidates') {
      const c = candidates(request);
      const limit = int(options.limit, 30, 'limit');
      return { request, total: c.rows.length, top: c.rows.slice(0, limit).map(r => ({ id: r.id, skill: r.skill, ascendancy: r.ascendancy, form: r.form, damage: r.damage_types, family: r.family, score: r.score, themes_met: r.themes_met, missing: r.themes_missing, reasons: r.reasons })), excluded: c.excluded };
    }
    return generate({ request, limit: int(options.limit, 6, 'limit'), screen: int(options.screen, 24, 'screen'), budgetCalcs: int(options['budget-calcs'], 1000, 'budget-calcs'),
      concurrency: int(options.concurrency, defaultConcurrency, 'concurrency'), out: options.out ?? null, lab: !options['no-lab'], links: int(options.links, 6, 'links'),
      onlyGems: options.gems ? options.gems.split(',').map(s => s.trim()) : null, seed: options.seed ?? 'both', novelty: !options['no-novelty'] });
  }
  if (op === 'verify') {
    if (!options.example) throw new Error('design verify --example <id> required');
    return verifyExample({ id: options.example, limit: int(options.limit, 6, 'limit'), screen: int(options.screen, 24, 'screen'), budgetCalcs: int(options['budget-calcs'], 200, 'budget-calcs'),
      concurrency: int(options.concurrency, defaultConcurrency, 'concurrency'), out: options.out ?? null, prototype: !!options.prototype });
  }
  if (op === 'show') {
    const dir = path.resolve(positional[0] ?? '');
    return readJson(path.join(dir, 'report.json'));
  }
  throw new Error('Use design request|candidates|generate|verify|show|help');
}

export const designHelp = {
  ...optimizeHelp,
  ...reverseHelp,
  'design request [--profile <build.json> | --request req.json] [--ascendancy A,B] [--themes t1,t2] [--level N] [--map-tier N]': 'Build Request Mode: structured request from the profile (unknown = null, defaults listed in assumptions), blueprint schema id and success criteria',
  'design candidates [same request options] [--limit 30]': 'Main-skill candidates from the knowledge DB x requested ascendancies: theme/axis/ascendancy-synergy score and excluded skills with reasons (no engine)',
  'design generate [same request options] [--limit 6] [--screen 24] [--budget-calcs 1000] [--links 6] [--gems id,id] [--seed both|only|none] [--no-novelty] [--no-lab] [--out dir]': 'Candidates -> (scratch: greedy axis tree + generic rare kit; corpus seed: tree/items/jewels/flasks/masteries of the closest corpus build of the ascendancy with only the main group replaced; --seed both by default) -> structural novelty vs the corpus as an extra Pareto axis (--no-novelty off) -> PoB screen -> PoB-probed supports/auras/curse enabler -> T-tier boss/rare encounters -> hard filters -> Pareto front; Blueprints, XML and report in research/lab/designs/<run>/, rejected prototypes as lab failures',
  'design verify --example <id> [--prototype] [--limit N] [--screen N] [--budget-calcs N]': 'Generator check: synthetic request from a reference example (class + main-skill structure, name withheld); reports the rank of the reference skill and, with --prototype, whether it reaches the prototype stage',
  'design show <run-dir>': 'Stored report of a design run'
};
