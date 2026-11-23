// Node Power candidates and stat-weight probes. The passive graph is injected (adjacency + node info),
// so this module does not depend on a particular tree loader; the CLI wires the 3.30 graph in.

// Breadth-first search from every allocated node; returns each reachable unallocated node within `radius`
// steps with the shortest list of nodes to allocate (path cost = number of new points, ascendancy excluded).
export function nodeCandidates({ allocated, adjacency, nodes = new Map(), radius = 3, include = info => true, limit = Infinity }) {
  const taken = new Set([...allocated].map(String));
  if (!taken.size) throw new Error('Allocated set is empty; choose a class start first');
  const parent = new Map(), depth = new Map();
  const queue = [];
  for (const id of taken) { depth.set(id, 0); queue.push(id); }
  const blocked = id => { const info = nodes.get(id); return info && (info.ascendancy || info.is_class_start || info.is_mastery || info.blocked); };
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i], d = depth.get(current);
    if (d >= radius) continue;
    for (const next of adjacency.get(current) ?? []) {
      const n = String(next);
      if (depth.has(n) || blocked(n)) continue;
      depth.set(n, d + 1); parent.set(n, current); queue.push(n);
    }
  }
  const out = [];
  for (const [id, d] of depth) {
    if (taken.has(id)) continue;
    const info = nodes.get(id) ?? {};
    if (!include(info, id)) continue;
    const pathIds = [];
    for (let cur = id; !taken.has(cur); cur = parent.get(cur)) pathIds.unshift(cur);
    out.push({ id, name: info.name ?? null, kind: info.kind ?? null, cost: { points: d }, path: pathIds });
  }
  out.sort((a, b) => a.cost.points - b.cost.points || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return out.slice(0, limit);
}

// Default selection: notables and keystones are the meaningful targets; small nodes appear as path steps.
export const notableOrKeystone = info => info.kind === 'notable' || info.kind === 'keystone';

// The tree edit operation is provided by the engine session; the change object is built in one place.
export function allocateChange(candidate, base = {}) {
  return { ...base, tree: { ...(base.tree ?? {}), allocate: [...(base.tree?.allocate ?? []), ...candidate.path.map(Number)] } };
}

// Stat-weight probes: +1 unit through PoB custom modifiers. These are synthetic bonuses (experiment), not items.
export const statProbes = [
  { id: 'inc-damage', mod: '1% increased Damage', unit: '1% increased Damage' },
  { id: 'more-damage', mod: '1% more Damage', unit: '1% more Damage' },
  { id: 'attack-speed', mod: '1% increased Attack Speed', unit: '1% increased Attack Speed' },
  { id: 'cast-speed', mod: '1% increased Cast Speed', unit: '1% increased Cast Speed' },
  { id: 'crit-chance', mod: '10% increased Critical Strike Chance', unit: '10% increased Critical Strike Chance' },
  { id: 'crit-multi', mod: '+1% to Critical Strike Multiplier', unit: '+1% Critical Strike Multiplier' },
  { id: 'pen-all', mod: 'Damage Penetrates 1% Elemental Resistances', unit: '1% elemental penetration' },
  { id: 'flat-life', mod: '+10 to maximum Life', unit: '+10 maximum Life' },
  { id: 'inc-life', mod: '1% increased maximum Life', unit: '1% increased maximum Life' },
  { id: 'flat-es', mod: '+10 to maximum Energy Shield', unit: '+10 maximum Energy Shield' },
  { id: 'inc-armour', mod: '10% increased Armour', unit: '10% increased Armour' },
  { id: 'inc-evasion', mod: '10% increased Evasion Rating', unit: '10% increased Evasion Rating' },
  { id: 'all-res', mod: '+1% to all Elemental Resistances', unit: '+1% all elemental resistances' },
  { id: 'chaos-res', mod: '+1% to Chaos Resistance', unit: '+1% chaos resistance' },
  { id: 'phys-reduction', mod: '1% additional Physical Damage Reduction', unit: '1% physical damage reduction' }
];
export function statChanges(probe, base = {}) {
  const custom = [base.custom_mods, probe.mod].filter(Boolean).join('\n');
  return { ...base, custom_mods: custom };
}
export function statCandidates(ids = null, base = {}) {
  const chosen = ids ? ids.map(id => { const p = statProbes.find(s => s.id === id); if (!p) throw new Error(`Unknown stat probe: ${id}`); return p; }) : statProbes;
  return chosen.map(p => ({ id: p.id, label: p.unit, cost: null, changes: statChanges(p, base), meta: { experiment: 'custom_mods', mod: p.mod } }));
}
