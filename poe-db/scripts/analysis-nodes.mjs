// Stat-weight probes for analyze stats (synthetic +1 unit through PoB custom modifiers).

// Node Power candidates come from PoB itself (pob-worker node_power: pathDist, node.path); see analysis-run.analyzeNodes.

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
