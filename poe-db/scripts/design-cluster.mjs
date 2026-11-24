// Cluster jewels for design prototypes (WP5b item 5). The whole legal space comes from the pinned PoB data, not from
// a hand-written list: Data/ClusterJewels.lua gives every size and every enchant ("Added Small Passive Skills grant",
// tag), Data/ModJewelCluster.lua gives every notable with its side (prefix/suffix) and spawn weight per enchant tag;
// a notable is legal on an enchant when its weight for that tag is > 0 and its size multiplier is not 0. Shapes follow
// the corpus norm of rare clusters (Large 8 passives, 2 sockets, 2 prefix + 1 suffix notables: 146 of 231; Medium
// 5 passives, 1 socket, 2 prefix notables; Small 3 passives, 1 prefix notable). Candidates are ranked by the
// generator's axis value of the enchant and notable stats (cluster notables exist in the tree data); PoB then probes
// the best candidates in reachable outer sockets. Rare affixes besides notables ("also grant", small passive effect)
// are left out: the kit is a common yardstick, not a crafted item.
import fs from 'node:fs';
import path from 'node:path';
import { dbRoot } from './workspace.mjs';
import { parseLuaTable } from './lua-table.mjs';

export const CLUSTER_SHAPE = {
  Large: { nodes: 8, sockets: 2, prefix: 2, suffix: 1, level: 54 },
  Medium: { nodes: 5, sockets: 1, prefix: 2, suffix: 0, level: 54 },
  Small: { nodes: 3, sockets: 0, prefix: 1, suffix: 0, level: 40 }
};
const luaFile = name => {
  const text = fs.readFileSync(path.join(dbRoot, 'vendor/pob/src/Data', name), 'utf8');
  return parseLuaTable(text.slice(text.indexOf('{')));
};
const list = x => x == null ? [] : Array.isArray(x) ? x : Object.keys(x).sort((a, b) => Number(a) - Number(b)).map(k => x[k]);

let cached;
// { enchants: [{size, tag, name, stats, enchant}], notables: [{name, side, level, weights:{tag:w}, sizes:{Large:bool,...}}] }
export function clusterData() {
  if (cached) return cached;
  const jewels = luaFile('ClusterJewels.lua').jewels;
  const enchants = [];
  for (const [base, j] of Object.entries(jewels)) {
    const size = j.size ?? base.split(' ')[0];
    for (const [tag, s] of Object.entries(j.skills ?? {}))
      enchants.push({ size, tag, name: s.name, stats: list(s.stats), enchant: list(s.enchant).length ? list(s.enchant) : list(s.stats).map(x => `Added Small Passive Skills grant: ${x}`) });
  }
  const mods = luaFile('ModJewelCluster.lua');
  const notables = [];
  for (const m of Object.values(mods)) {
    const line = list(m).find(x => typeof x === 'string' && /^1 Added Passive Skill is /.test(x));
    if (!line || !['Prefix', 'Suffix'].includes(m.type)) continue;
    const keys = list(m.weightKey), vals = list(m.weightVal), mk = list(m.weightMultiplierKey), mv = list(m.weightMultiplierVal);
    const weights = {}; keys.forEach((k, i) => { if (k !== 'default' && vals[i] > 0) weights[k] = vals[i]; });
    const mult = {}; mk.forEach((k, i) => { mult[k] = mv[i]; });
    const sizes = Object.fromEntries(['Large', 'Medium', 'Small'].map(s => [s, (mult[`expansion_jewel_${s.toLowerCase()}`] ?? 0) > 0]));
    notables.push({ name: line.replace('1 Added Passive Skill is ', '').trim(), side: m.type.toLowerCase(), level: m.level ?? 1, weights, sizes });
  }
  enchants.sort((a, b) => a.size.localeCompare(b.size) || a.tag.localeCompare(b.tag));
  notables.sort((a, b) => a.name.localeCompare(b.name));
  return (cached = { enchants, notables });
}

export const legalNotables = (enchant, data = clusterData()) =>
  data.notables.filter(n => n.weights[enchant.tag] > 0 && n.sizes[enchant.size] !== false && n.level <= 84);

// Pure: best notables for one enchant within the shape's prefix/suffix limits; only positively valued notables.
export function pickNotables(rows, shape) {
  const used = { prefix: 0, suffix: 0 }, out = [];
  for (const r of [...rows].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))) {
    if (!(r.value > 0) || used[r.side] >= shape[r.side]) continue;
    used[r.side]++; out.push(r);
  }
  return out;
}

// Ranked candidates per size. valueOf(stats[]) -> number (generator axis value); notableStats(name) -> stats[] | null.
export function clusterCandidates({ valueOf, notableStats, perSize = { Large: 3, Medium: 2, Small: 1 }, data = clusterData() }) {
  const out = [];
  for (const [size, count] of Object.entries(perSize)) {
    const shape = CLUSTER_SHAPE[size];
    const rows = [];
    for (const e of data.enchants.filter(x => x.size === size)) {
      const notables = pickNotables(legalNotables(e, data).map(n => {
        const stats = notableStats(n.name);
        return stats ? { name: n.name, side: n.side, value: valueOf(stats) } : null;
      }).filter(Boolean), shape);
      if (!notables.length) continue;
      const smalls = shape.nodes - shape.sockets - notables.length;
      const small = valueOf(e.stats) * smalls;
      const value = small + notables.reduce((a, n) => a + n.value, 0);
      // Points: the socket entrance to each notable; roughly all non-socket nodes of the cluster.
      rows.push({ size, tag: e.tag, name: e.name, enchant: e.enchant, notables, value: Math.round(value * 100) / 100, points: shape.nodes - shape.sockets });
    }
    rows.sort((a, b) => b.value / b.points - a.value / a.points || a.tag.localeCompare(b.tag));
    out.push(...rows.slice(0, count));
  }
  return out;
}

export function clusterText(c) {
  const shape = CLUSTER_SHAPE[c.size];
  const implicit = [`Adds ${shape.nodes} Passive Skills`,
    ...(shape.sockets === 1 ? ['1 Added Passive Skill is a Jewel Socket'] : shape.sockets > 1 ? [`${shape.sockets} Added Passive Skills are Jewel Sockets`] : []),
    ...c.enchant];
  return ['Rarity: RARE', 'Kit Cluster', `${c.size} Cluster Jewel`, `Cluster Jewel Skill: ${c.tag}`, `Cluster Jewel Node Count: ${shape.nodes}`,
    'Item Level: 84', `LevelReq: ${shape.level}`, `Implicits: ${implicit.length}`, ...implicit.map(l => `{crafted}${l}`),
    ...c.notables.map(n => `1 Added Passive Skill is ${n.name}`)].join('\n');
}

// Outer sockets that hold any cluster size (Large expansion sockets of the main tree).
export const outerClusterSockets = t => [...t.nodes.values()].filter(n => n.expansion?.size === 2 && !n.expansion.parent).map(n => n.id).sort((a, b) => a - b);

// Nested sockets. The jewel sockets inside a cluster are real tree nodes whose expansion.parent is the socket the
// cluster sits in (PassiveSpec:BuildSubgraph -> FindClusterSocket in the proxy group); PoB fills them in the order of
// expansion.index {0, 2, 1}, and a Large cluster with a single socket uses index 1. A Large cluster's inner sockets
// are Medium-size (Medium or Small jewels), a Medium cluster's inner socket is Small-size (Small jewels).
export const INNER_SIZES = { Large: ['Medium', 'Small'], Medium: ['Small'], Small: [] };
export function innerClusterSockets(t, socketId, size) {
  const n = CLUSTER_SHAPE[size]?.sockets ?? 0;
  if (!n) return [];
  const order = size === 'Large' && n === 1 ? [1] : [0, 2, 1].slice(0, n);
  const kids = [...t.nodes.values()].filter(x => x.expansion && Number(x.expansion.parent) === Number(socketId));
  return order.map(i => kids.find(k => k.expansion.index === i)?.id).filter(id => id != null);
}
// Pure: nested pairs from ranked candidates: the best outer candidate of each size with sockets x the best candidate
// of each size its inner socket holds. Points = outer + 1 (inner socket node) + inner.
export function nestedCandidates(cands) {
  const best = size => cands.find(c => c.size === size);
  const out = [];
  for (const size of ['Large', 'Medium']) {
    const outer = best(size);
    if (!outer) continue;
    for (const s of INNER_SIZES[size]) {
      const inner = best(s);
      if (inner) out.push({ ...outer, nested: inner, points: outer.points + 1 + inner.points, value: Math.round((outer.value + inner.value) * 100) / 100 });
    }
  }
  return out;
}
