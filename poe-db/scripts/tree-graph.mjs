// Passive tree graph for PoE 1 3.30 built from the pinned GGG skilltree-export (3.30.0).
// Traversal rules mirror PoB 2.68.1 PassiveSpec:BuildAllDependsAndPaths: links are out+in,
// paths never enter class/ascendancy starts, never leave masteries and never cross ascendancies.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { dbRoot, projectRoot, readJson, flags } from './workspace.mjs';

export const treeFile = path.join(projectRoot, 'research/330/ggg-passive-tree.json');
export const TREE_SOURCE = 'https://raw.githubusercontent.com/grindinggear/skilltree-export/550fb34ae7fca9ec4d760a2ac845bb2ba1032ec3/data.json';
// PoB data.jewelRadii["3_16"] (used for 3.16+ trees).
export const JEWEL_RADII = { small: 960, medium: 1440, large: 1800, 'very-large': 2400, massive: 2880 };
const CLASS_ALIASES = { SIX: 'Shadow', Seven: 'Scion' };

let cached = null;
// GGG export markup "[Id|Text]" / "[Text]" -> plain client text (as PoB displays it).
export const cleanStat = s => String(s).replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]|]*)\]/g, '$1');
function expectedSha() {
  try {
    const manifest = readJson(path.join(dbRoot, 'cache/knowledge/manifest.json'));
    return manifest.sources.find(s => s.file === '../research/330/ggg-passive-tree.json')?.sha256 ?? null;
  } catch { return null; }
}

function orbitAngles(count) {
  if (count === 16) return [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330].map(d => d * Math.PI / 180);
  if (count === 40) return [0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180, 190, 200, 210, 220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350].map(d => d * Math.PI / 180);
  return Array.from({ length: count }, (_, i) => 2 * Math.PI * i / count);
}

export function loadTree(file = treeFile) {
  if (cached && cached.file === file) return cached;
  const text = fs.readFileSync(file, 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  const expected = file === treeFile ? expectedSha() : null;
  if (expected && expected !== sha256) throw new Error(`Pinned tree checksum mismatch: ${file}`);
  const raw = JSON.parse(text);
  const historical = new Set(raw.alternate_ascendancies.filter(a => !a.name.endsWith('Bloodline')).map(a => a.id));
  const bloodlines = new Set(raw.alternate_ascendancies.filter(a => a.name.endsWith('Bloodline')).map(a => a.id));
  const ascToClass = new Map();
  raw.classes.forEach((c, index) => c.ascendancies.forEach(a => ascToClass.set(a.id, { class: c.name, classIndex: index, name: a.name })));
  const angles = raw.constants.skillsPerOrbit.map(orbitAngles);
  const nodes = new Map();
  for (const [key, n] of Object.entries(raw.nodes)) {
    if (key === 'root') continue;
    const id = Number(key);
    const group = n.group != null ? raw.groups[n.group] : null;
    let type = 'normal';
    if (n.classStartIndex !== undefined) type = 'class_start';
    else if (n.isAscendancyStart) type = 'ascendancy_start';
    else if (n.isMastery) type = 'mastery';
    else if (n.isJewelSocket) type = 'jewel_socket';
    else if (n.isKeystone) type = 'keystone';
    else if (n.isNotable) type = 'notable';
    let x = null, y = null;
    if (group) {
      const angle = angles[n.orbit][n.orbitIndex];
      const radius = raw.constants.orbitRadii[n.orbit];
      x = group.x + Math.sin(angle) * radius;
      y = group.y - Math.cos(angle) * radius;
    }
    const asc = n.ascendancyName ?? null;
    const eligibility = asc && historical.has(asc) ? 'historical' : asc === 'Brinerot' ? 'unconfirmed' : !group && !n.isAscendancyStart ? 'granted_only' : 'tree_defined';
    nodes.set(id, {
      id, name: n.name, type, stats: (n.stats ?? []).map(cleanStat), group: n.group ?? null, x, y,
      ascendancy: asc, bloodline: !!n.isBloodline || (asc != null && bloodlines.has(asc)),
      proxy: !!n.isProxy || !!group?.isProxy, blighted: !!n.isBlighted, eligibility,
      class_start: n.classStartIndex !== undefined ? (CLASS_ALIASES[n.name] ?? raw.classes[n.classStartIndex].name) : null,
      expansion: n.expansionJewel ?? null, multiple_choice_option: !!n.isMultipleChoiceOption,
      mastery_effects: n.masteryEffects ? n.masteryEffects.map(e => ({ effect: e.effect, stats: (e.stats ?? []).map(cleanStat) })) : null, granted_points: n.grantedPassivePoints ?? 0,
      reminder: n.reminderText ?? null, links: new Set()
    });
  }
  for (const [key, n] of Object.entries(raw.nodes)) {
    if (key === 'root') continue;
    const a = nodes.get(Number(key));
    for (const other of [...(n.out ?? []), ...(n.in ?? [])]) {
      const b = nodes.get(Number(other));
      if (!b || b === a) continue;
      a.links.add(b.id); b.links.add(a.id);
    }
  }
  const classes = raw.classes.map((c, index) => {
    const start = [...nodes.values()].find(n => n.type === 'class_start' && raw.nodes[n.id].classStartIndex === index);
    return { name: c.name, index, start: start.id, ascendancies: c.ascendancies.map(a => ({ id: a.id, name: a.name })) };
  });
  const ascStarts = new Map([...nodes.values()].filter(n => n.type === 'ascendancy_start').map(n => [n.ascendancy, n.id]));
  cached = { file, sha256, source: file === treeFile ? TREE_SOURCE : file, tree: raw.tree, points: raw.points, nodes, classes, ascToClass, ascStarts, historical, bloodlines };
  return cached;
}

const norm = s => String(s).toLowerCase().replace(/[’`]/g, "'").trim();

export function resolveClass(value, t = loadTree()) {
  if (value == null) throw new Error('--from <class|ascendancy> required');
  const v = norm(value);
  const cls = t.classes.find(c => norm(c.name) === v);
  if (cls) return { class: cls, ascendancy: null };
  for (const c of t.classes) {
    const a = c.ascendancies.find(a => norm(a.id) === v || norm(a.name) === v);
    if (a) return { class: c, ascendancy: a.id };
  }
  throw new Error(`Unknown class or ascendancy: ${value}. Classes: ${t.classes.map(c => c.name).join(', ')}`);
}

function brief(n, extra = {}) {
  const out = { id: n.id, name: n.name, type: n.type };
  if (n.ascendancy) out.ascendancy = n.ascendancy;
  if (n.eligibility !== 'tree_defined') out.eligibility = n.eligibility;
  return Object.assign(out, extra);
}

function isMainTree(n) { return n.group != null && !n.proxy && !n.blighted && !n.ascendancy && n.eligibility === 'tree_defined'; }

// Resolve a node reference (numeric id or exact name). Ambiguous names (e.g. "Life Mastery")
// resolve to the candidate nearest to the current allocation and are flagged.
export function resolveNode(ref, t = loadTree(), { near = null, includeHistorical = false } = {}) {
  const raw = String(ref).trim();
  if (/^\d+$/.test(raw)) {
    const n = t.nodes.get(Number(raw));
    if (!n) throw new Error(`Unknown node id: ${raw}`);
    return { node: n, ambiguous: 0 };
  }
  const v = norm(raw);
  let candidates = [...t.nodes.values()].filter(n => norm(n.name) === v && n.group != null && !n.proxy && (includeHistorical || ['tree_defined'].includes(n.eligibility)));
  if (!candidates.length) {
    const any = [...t.nodes.values()].filter(n => norm(n.name) === v);
    if (any.length) throw new Error(`Node "${raw}" exists but is not allocatable on the tree (${[...new Set(any.map(n => n.eligibility))].join(', ')})`);
    const close = [...t.nodes.values()].filter(n => norm(n.name).includes(v) && isMainTree(n)).slice(0, 8).map(n => `${n.name} (${n.id})`);
    throw new Error(`Unknown node: ${raw}${close.length ? `. Similar: ${close.join('; ')}` : ''}`);
  }
  if (candidates.length === 1) return { node: candidates[0], ambiguous: 0 };
  if (near) {
    const dist = distances(t, near.roots, near.allocated);
    candidates.sort((a, b) => (dist.get(a.id) ?? Infinity) - (dist.get(b.id) ?? Infinity) || a.id - b.id);
  } else candidates.sort((a, b) => a.id - b.id);
  return { node: candidates[0], ambiguous: candidates.length };
}

function canTraverse(from, to, fromDist) {
  if (from.type === 'mastery') return false;
  if (to.type === 'class_start' || to.type === 'ascendancy_start') return false;
  if (to.proxy || to.blighted || to.group == null) return false;
  if (to.eligibility === 'historical' || to.eligibility === 'unconfirmed') return false;
  return from.ascendancy === to.ascendancy || (fromDist === 0 && !to.ascendancy && from.type !== 'class_start' && from.ascendancy === 'Ascendant');
}

// Multi-source 0-1 BFS: allocated nodes cost 0, each unallocated node costs 1 point.
function search(t, roots, allocated) {
  const dist = new Map(), parent = new Map(), deque = [];
  for (const id of roots) { dist.set(id, 0); parent.set(id, null); deque.push(id); }
  let head = 0;
  while (head < deque.length) {
    const id = deque[head++];
    const node = t.nodes.get(id), d = dist.get(id);
    for (const otherId of node.links) {
      const other = t.nodes.get(otherId);
      if (!canTraverse(node, other, d)) continue;
      const w = allocated.has(otherId) ? 0 : 1, nd = d + w;
      if (nd < (dist.get(otherId) ?? Infinity)) {
        dist.set(otherId, nd); parent.set(otherId, id);
        if (w === 0) deque.splice(head, 0, otherId); else deque.push(otherId);
      }
    }
  }
  return { dist, parent };
}
function distances(t, roots, allocated) { return search(t, roots, allocated).dist; }

function rootsFor(t, cls, allocated, ascendancy) {
  // Roots: class start plus every allocated node connected to it (only connected nodes can grow paths).
  if (ascendancy) {
    const start = t.ascStarts.get(ascendancy);
    if (start == null) throw new Error(`No ascendancy start for ${ascendancy}`);
    return [start, ...[...allocated].filter(id => t.nodes.get(id)?.ascendancy === ascendancy)];
  }
  const connected = connectedSet(t, cls.start, allocated);
  return [cls.start, ...[...connected].filter(id => id !== cls.start)];
}

export function connectedSet(t, start, allocated) {
  const seen = new Set([start]), queue = [start];
  while (queue.length) {
    const id = queue.shift(), node = t.nodes.get(id);
    for (const o of node.links) {
      if (seen.has(o) || !allocated.has(o)) continue;
      if (!canTraverse(node, t.nodes.get(o), 1)) continue;
      seen.add(o); queue.push(o);
    }
  }
  return seen;
}

function pathTo(t, parent, target) {
  const nodes = [];
  for (let id = target; id != null; id = parent.get(id)) nodes.push(id);
  return nodes.reverse();
}

function connectOne(t, cls, allocated, target, ascendancy) {
  const roots = rootsFor(t, cls, allocated, ascendancy);
  const { dist, parent } = search(t, roots, allocated);
  if (!dist.has(target)) return null;
  const added = pathTo(t, parent, target).filter(id => !allocated.has(id) && t.nodes.get(id).type !== 'class_start' && t.nodes.get(id).type !== 'ascendancy_start');
  return { cost: dist.get(target), added };
}

function permutations(list) {
  if (list.length <= 1) return [list];
  const out = [];
  list.forEach((x, i) => { for (const p of permutations([...list.slice(0, i), ...list.slice(i + 1)])) out.push([x, ...p]); });
  return out;
}

function planOrder(t, cls, allocated, order, ascendancy) {
  const current = new Set(allocated), steps = [];
  for (const target of order) {
    if (current.has(target)) { steps.push({ target, cost: 0, added: [] }); continue; }
    const step = connectOne(t, cls, current, target, ascendancy);
    if (!step) return null;
    step.added.forEach(id => current.add(id));
    steps.push({ target, ...step });
  }
  return { steps, total: steps.reduce((s, x) => s + x.added.length, 0), allocated: current };
}

function greedy(t, cls, allocated, targets, ascendancy) {
  const current = new Set(allocated), remaining = [...targets], order = [];
  while (remaining.length) {
    const roots = rootsFor(t, cls, current, ascendancy);
    const dist = distances(t, roots, current);
    remaining.sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity) || a - b);
    const next = remaining.shift();
    if (!dist.has(next)) return null;
    order.push(next);
    const step = connectOne(t, cls, current, next, ascendancy);
    step.added.forEach(id => current.add(id));
  }
  return planOrder(t, cls, allocated, order, ascendancy);
}

function parseList(value) {
  if (value == null) return [];
  return String(value).split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

export function readXmlSpec(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text.startsWith('<')) throw new Error('Plain PoB XML required for --xml (decode share codes with pob tools first)');
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(text);
  const tree = doc?.PathOfBuilding?.Tree;
  if (!tree) throw new Error('No <Tree> section in XML');
  const specs = [].concat(tree.Spec ?? []);
  const active = specs[Number(tree.activeSpec ?? 1) - 1] ?? specs[0];
  if (!active) throw new Error('No <Spec> in XML');
  return {
    treeVersion: active.treeVersion ?? null, classId: active.classId != null ? Number(active.classId) : null,
    ascendClassId: active.ascendClassId != null ? Number(active.ascendClassId) : null,
    nodes: parseList(active.nodes).map(Number), title: active.title ?? null
  };
}

function allocationInput(t, options) {
  let fromValue = options.from, allocated = parseList(options.allocated);
  let xml = null;
  if (options.xml) {
    xml = readXmlSpec(path.resolve(options.xml));
    if (xml.treeVersion && xml.treeVersion !== '3_30') throw new Error(`XML tree ${xml.treeVersion} is not 3_30; migrate it first (pob migrate)`);
    if (!fromValue && xml.classId != null) fromValue = t.classes[xml.classId]?.name;
    allocated = [...allocated, ...xml.nodes.map(String)];
  }
  const { class: cls, ascendancy } = resolveClass(fromValue, t);
  const set = new Set();
  for (const ref of allocated) set.add(resolveNode(ref, t).node.id);
  set.add(cls.start);
  return { cls, ascendancy, allocated: set, xml };
}

export function treePath(options, t = loadTree()) {
  const { cls, ascendancy, allocated } = allocationInput(t, options);
  const refs = parseList(options.to);
  if (!refs.length) throw new Error('--to <node[,node...]> required');
  const near = { roots: rootsFor(t, cls, allocated, null), allocated };
  const resolved = refs.map(ref => ({ ref, ...resolveNode(ref, t, { near }) }));
  const notes = [];
  const groups = new Map();
  for (const r of resolved) {
    if (r.ambiguous) notes.push(`"${r.ref}" matches ${r.ambiguous} nodes; nearest chosen: ${r.node.id}`);
    const asc = r.node.ascendancy;
    if (asc) {
      const owner = t.ascToClass.get(asc);
      if (owner && owner.class !== cls.name) throw new Error(`${r.node.name} belongs to ${asc} (${owner.class}), not ${cls.name}`);
      if (ascendancy && !t.nodes.get(r.node.id).bloodline && asc !== ascendancy) throw new Error(`${r.node.name} belongs to ${asc}, but --from selects ${ascendancy}`);
    }
    if (r.node.type === 'class_start') throw new Error(`${r.node.name} is a class start, not a target`);
    const key = asc ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.node.id);
  }
  const result = { from: { class: cls.name, ascendancy: ascendancy ?? null, start: cls.start }, targets: resolved.map(r => brief(r.node, r.ambiguous ? { ambiguous_candidates: r.ambiguous } : {})), sections: [] };
  let mainAllocate = [], ascAllocate = [];
  for (const [asc, targets] of groups) {
    const ascendancyName = asc || null;
    let best = null, method;
    if (targets.length <= 6) {
      method = targets.length > 1 ? 'exhaustive_order' : 'shortest_path';
      for (const order of permutations(targets)) {
        const plan = planOrder(t, cls, allocated, order, ascendancyName);
        if (plan && (!best || plan.total < best.total)) best = plan;
      }
    } else { method = 'greedy_nearest'; best = greedy(t, cls, allocated, targets, ascendancyName); }
    if (!best) throw new Error(`No legal path to ${targets.map(id => t.nodes.get(id).name).join(', ')} from ${cls.name}${ascendancyName ? ` (${ascendancyName})` : ''}`);
    const added = best.steps.flatMap(s => s.added);
    const section = {
      scope: ascendancyName ? (t.bloodlines.has(ascendancyName) ? 'bloodline' : 'ascendancy') : 'main_tree',
      ascendancy: ascendancyName, method, points: added.length,
      steps: best.steps.map(s => ({ target: s.target, name: t.nodes.get(s.target).name, points: s.added.length })),
      nodes: added.map(id => brief(t.nodes.get(id))), allocate: added
    };
    const masteries = added.map(id => t.nodes.get(id)).filter(n => n.type === 'mastery');
    if (masteries.length) section.mastery_choices_required = masteries.map(n => ({ node: n.id, name: n.name, options: (n.mastery_effects ?? []).map(e => ({ effect: e.effect, stats: e.stats })) }));
    if (ascendancyName) ascAllocate.push(...added); else mainAllocate.push(...added);
    result.sections.push(section);
  }
  result.points = { main_tree: mainAllocate.length, ascendancy: ascAllocate.length, already_allocated: allocated.size - 1 };
  result.allocate = [...mainAllocate, ...ascAllocate];
  result.notes = [...notes,
    'Points count every new node, including masteries and jewel sockets. Class/ascendancy starts are free.',
    'Multiple targets: minimum over target orders of sequential shortest paths; not a proven Steiner optimum for 7+ targets (greedy).',
    'Path legality only. Requirements, budget level and value of nodes are not evaluated.'];
  result.source = { tree: '3.30.0', url: t.source, sha256: t.sha256, rules: 'PoB 2.68.1 PassiveSpec traversal' };
  return result;
}

export function treeCost(options, t = loadTree()) {
  const { cls, ascendancy, allocated, xml } = allocationInput(t, options);
  const connected = connectedSet(t, cls.start, allocated);
  const main = [], asc = [], disconnected = [];
  const ascByName = new Map();
  for (const id of allocated) {
    const n = t.nodes.get(id);
    if (n.type === 'class_start') continue;
    if (n.ascendancy) {
      if (n.type === 'ascendancy_start') continue;
      asc.push(id);
      if (!ascByName.has(n.ascendancy)) ascByName.set(n.ascendancy, []);
      ascByName.get(n.ascendancy).push(id);
      continue;
    }
    main.push(id);
    if (!connected.has(id)) disconnected.push(brief(n));
  }
  const ascChecks = [...ascByName].map(([name, ids]) => {
    const start = t.ascStarts.get(name);
    const set = new Set([start, ...ids]);
    const seen = new Set([start]), queue = [start];
    while (queue.length) { const id = queue.shift(); for (const o of t.nodes.get(id).links) if (set.has(o) && !seen.has(o) && t.nodes.get(o).ascendancy === name) { seen.add(o); queue.push(o); } }
    const owner = t.ascToClass.get(name);
    return { ascendancy: name, bloodline: t.bloodlines.has(name), points: ids.length, disconnected: ids.filter(id => !seen.has(id)).map(id => brief(t.nodes.get(id))),
      class_mismatch: owner && owner.class !== cls.name ? owner.class : null };
  });
  const masteries = main.map(id => t.nodes.get(id)).filter(n => n.type === 'mastery');
  const granted = main.reduce((s, id) => s + (t.nodes.get(id).granted_points || 0), 0);
  const ascPoints = asc.length;
  return {
    class: cls.name, ascendancy: ascendancy ?? (xml?.ascendClassId ? cls.ascendancies[xml.ascendClassId - 1]?.id ?? null : null),
    points: { main_tree: main.length, ascendancy_total: ascPoints, masteries: masteries.length, keystones: main.filter(id => t.nodes.get(id).type === 'keystone').length,
      notables: main.filter(id => t.nodes.get(id).type === 'notable').length, jewel_sockets: main.filter(id => t.nodes.get(id).type === 'jewel_socket').length, granted_extra_points: granted },
    budget: { main_tree_max_from_quests_and_levels: t.points.totalPoints, ascendancy_max: t.points.ascendancyPoints,
      main_tree_ok: main.length <= t.points.totalPoints + granted, ascendancy_ok: ascPoints <= t.points.ascendancyPoints },
    connected: disconnected.length === 0 && ascChecks.every(a => a.disconnected.length === 0 && !a.class_mismatch),
    disconnected, ascendancies: ascChecks,
    notes: ['Main tree budget: 123 points = level 100 (99) + 24 quest points per GGG tree "points"; bloodline nodes share the ascendancy budget (bloodline_subset is part of ascendancy_total).',
      'Level needed for N main-tree points with all quest points: N - 23 (minimum level 1); quest availability is not checked here.'],
    level_needed_with_all_quest_points: Math.max(1, main.length - granted - 23),
    source: { tree: '3.30.0', sha256: t.sha256 }
  };
}

export function treeNear(options, t = loadTree()) {
  const ref = options.node;
  if (!ref) throw new Error('tree near <node> required');
  const { node } = resolveNode(ref, t);
  if (node.x == null) throw new Error(`${node.name} has no tree position`);
  const radiusKey = String(options.radius ?? 'large').toLowerCase();
  const radius = JEWEL_RADII[radiusKey] ?? Number(radiusKey);
  if (!Number.isFinite(radius) || radius <= 0) throw new Error(`Radius must be one of ${Object.keys(JEWEL_RADII).join(', ')} or a positive number`);
  const typeFilter = options.type ? new Set(parseList(options.type)) : null;
  const rows = [];
  for (const n of t.nodes.values()) {
    if (n === node || n.x == null || n.proxy || n.blighted || n.ascendancy || n.type === 'mastery' || n.type === 'class_start') continue;
    const d = Math.hypot(n.x - node.x, n.y - node.y);
    if (d > radius) continue;
    if (typeFilter && !typeFilter.has(n.type)) continue;
    rows.push(brief(n, { distance: Math.round(d), stats: n.stats }));
  }
  rows.sort((a, b) => a.distance - b.distance);
  const counts = rows.reduce((m, r) => (m[r.type] = (m[r.type] ?? 0) + 1, m), {});
  const limit = Number(options.limit ?? 200);
  return { center: brief(node), radius: { value: radius, name: JEWEL_RADII[radiusKey] ? radiusKey : 'custom' }, total: rows.length, counts,
    results: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit),
    notes: ['Radius check follows PoB (distance from socket centre to node centre, masteries/proxies/ascendancy excluded).',
      'Timeless jewels use the large radius (1800); Timeless node transforms require the seed LUT (see setup-pob --timeless).',
      node.type !== 'jewel_socket' ? 'Centre is not a jewel socket: result is a geometric neighbourhood only.' : null].filter(Boolean),
    source: { tree: '3.30.0', sha256: t.sha256, radii: 'PoB data.jewelRadii 3_16' } };
}

export function treeSearch(options, t = loadTree()) {
  const text = norm(options.stat ?? options.text ?? '');
  if (!text) throw new Error('tree search --stat <text> (or a positional text) required');
  const typeFilter = options.type ? new Set(parseList(options.type)) : null;
  const scope = options.scope ?? 'main';
  const terms = text.split(/\s+/);
  const rows = [];
  for (const n of t.nodes.values()) {
    if (!options['include-historical'] && n.eligibility !== 'tree_defined') continue;
    if (n.group == null || n.proxy) continue;
    if (scope === 'main' && n.ascendancy) continue;
    if (scope === 'ascendancy' && !n.ascendancy) continue;
    if (typeFilter && !typeFilter.has(n.type)) continue;
    const effects = n.type === 'mastery' ? (n.mastery_effects ?? []).map(e => e.stats.join(' / ')) : [];
    const hay = norm([n.name, ...n.stats, ...effects].join('\n'));
    if (!terms.every(term => hay.includes(term))) continue;
    const matchedStats = n.type === 'mastery' ? effects.filter(e => terms.every(term => norm(e).includes(term) || norm(n.name).includes(term))) : n.stats;
    rows.push(brief(n, { stats: matchedStats }));
  }
  const rank = { keystone: 0, notable: 1, mastery: 2, jewel_socket: 3, normal: 4, ascendancy_start: 5 };
  rows.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || a.name.localeCompare(b.name) || a.id - b.id);
  let distanceFrom = null;
  if (options.from) {
    const { class: cls } = resolveClass(options.from, t);
    const dist = distances(t, [cls.start], new Set([cls.start]));
    distanceFrom = cls.name;
    for (const r of rows) r.points_from_start = r.ascendancy ? null : dist.get(r.id) ?? null;
    rows.sort((a, b) => (a.points_from_start ?? 1e9) - (b.points_from_start ?? 1e9));
  }
  const limit = Number(options.limit ?? 20);
  return { query: text, scope, total: rows.length, distance_from: distanceFrom, results: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit), source: { tree: '3.30.0', sha256: t.sha256 } };
}

export function treeNode(ref, t = loadTree()) {
  const { node, ambiguous } = resolveNode(ref, t, { includeHistorical: true });
  const out = brief(node, { stats: node.stats, group: node.group, position: node.x == null ? null : { x: Math.round(node.x), y: Math.round(node.y) },
    links: [...node.links].map(id => brief(t.nodes.get(id))) });
  if (ambiguous) out.ambiguous_candidates = ambiguous;
  if (node.mastery_effects) out.mastery_effects = node.mastery_effects;
  if (node.expansion) out.cluster_socket = { size: ['small', 'medium', 'large'][node.expansion.size] ?? node.expansion.size, index: node.expansion.index, parent: node.expansion.parent ? Number(node.expansion.parent) : null, proxy: node.expansion.proxy ? Number(node.expansion.proxy) : null };
  if (node.reminder) out.reminder = node.reminder;
  if (node.bloodline) out.bloodline = true;
  return out;
}

export function treeCommand(args) {
  const [operation, ...rest] = args;
  const { positional, options } = flags(rest, ['from', 'to', 'allocated', 'xml', 'radius', 'type', 'limit', 'stat', 'scope'], ['include-historical']);
  const t = loadTree();
  if (operation === 'path') return treePath(options, t);
  if (operation === 'cost') return treeCost(options, t);
  if (operation === 'near') return treeNear({ ...options, node: positional.join(' ') || options.from }, t);
  if (operation === 'search') return treeSearch({ ...options, stat: options.stat ?? positional.join(' ') }, t);
  if (operation === 'node') { if (!positional.length) throw new Error('tree node <id|name> required'); return treeNode(positional.join(' '), t); }
  if (operation === 'classes') return { classes: t.classes.map(c => ({ name: c.name, start: c.start, ascendancies: c.ascendancies })), points: t.points, source: { tree: '3.30.0', sha256: t.sha256 } };
  throw new Error('Use tree path|cost|near|search|node|classes');
}

// Building blocks for incremental allocation (design generator): roots, 0-1 BFS distances and one shortest connection.
export { rootsFor, distances, connectOne };
