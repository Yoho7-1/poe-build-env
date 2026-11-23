// Upgrade candidate files: validation and combination of single changes into packages. Pure logic.
//
// File format (candidates.json):
// { "candidates": [ { "id": "ring-life", "label": "...", "changes": { ...pob --changes object... },
//                     "price": { "name": "Mageblood", "variant": "4 Flasks" } | null, "cost": { "points": 0 } } ],
//   "packages":   [ { "id": "ring-plus-belt", "members": ["ring-life", "belt-x"] } ] }
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const arrayKeys = ['replace_items', 'gem_levels'];

export function validateCandidateFile(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.candidates) || !data.candidates.length) throw new Error('candidates[] required');
  const ids = new Set();
  for (const c of data.candidates) {
    if (!idPattern.test(c.id ?? '')) throw new Error(`Invalid candidate id: ${c.id}`);
    if (ids.has(c.id)) throw new Error(`Duplicate candidate id: ${c.id}`);
    ids.add(c.id);
    if (!c.changes || typeof c.changes !== 'object' || Array.isArray(c.changes) || !Object.keys(c.changes).length) throw new Error(`Candidate ${c.id} needs a non-empty changes object`);
    if (c.price != null && (typeof c.price.name !== 'string' || !c.price.name)) throw new Error(`Candidate ${c.id}: price.name required`);
  }
  for (const p of data.packages ?? []) {
    if (!idPattern.test(p.id ?? '') || ids.has(p.id)) throw new Error(`Invalid or duplicate package id: ${p.id}`);
    if (!Array.isArray(p.members) || p.members.length < 2) throw new Error(`Package ${p.id} needs 2+ members`);
    for (const m of p.members) if (!ids.has(m)) throw new Error(`Package ${p.id}: unknown member ${m}`);
    ids.add(p.id);
  }
  return data;
}

// Merge changes; conflicting writes (same item slot, same config key with different values, same gem) are fatal.
export function mergeChanges(list) {
  const out = {};
  const slots = new Map(), gems = new Map();
  for (const { id, changes } of list) {
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'config') {
        out.config ??= {};
        for (const [k, v] of Object.entries(value)) {
          if (k in out.config && out.config[k] !== v) throw new Error(`Conflict on config.${k} (${id})`);
          out.config[k] = v;
        }
      } else if (key === 'custom_mods' || key === 'add_support') {
        out[key] = [out[key], value].filter(Boolean).join('\n');
      } else if (arrayKeys.includes(key)) {
        for (const entry of value) {
          const tag = key === 'replace_items' ? `slot:${entry.slot}` : `gem:${entry.group}/${entry.gem}`;
          const seen = key === 'replace_items' ? slots : gems;
          if (seen.has(tag)) throw new Error(`Conflict on ${tag} between ${seen.get(tag)} and ${id}`);
          seen.set(tag, id);
          (out[key] ??= []).push(entry);
        }
      } else if (key === 'tree') {
        out.tree ??= {};
        for (const [op, ids] of Object.entries(value)) {
          if (!Array.isArray(ids)) { if (op in out.tree && JSON.stringify(out.tree[op]) !== JSON.stringify(ids)) throw new Error(`Conflict on tree.${op} (${id})`); out.tree[op] = ids; continue; }
          out.tree[op] = [...new Set([...(out.tree[op] ?? []), ...ids])];
        }
      } else {
        if (key in out && JSON.stringify(out[key]) !== JSON.stringify(value)) throw new Error(`Conflict on ${key} (${id})`);
        out[key] = value;
      }
    }
  }
  if (out.tree?.allocate && out.tree?.deallocate) {
    const both = out.tree.allocate.filter(n => out.tree.deallocate.includes(n));
    if (both.length) throw new Error(`Package allocates and deallocates the same nodes: ${both.join(',')}`);
  }
  return out;
}

export function expandCandidates(data) {
  validateCandidateFile(data);
  const byId = new Map(data.candidates.map(c => [c.id, c]));
  const singles = data.candidates.map(c => ({ id: c.id, label: c.label ?? c.id, changes: c.changes, cost: c.cost ?? null, price: c.price ?? null, meta: { type: 'single' } }));
  const packages = (data.packages ?? []).map(p => {
    const members = p.members.map(m => byId.get(m));
    const points = members.reduce((s, m) => s + (m.cost?.points ?? 0), 0);
    return { id: p.id, label: p.label ?? p.members.join(' + '), changes: mergeChanges(members), cost: { points }, price: null,
      meta: { type: 'package', members: p.members, member_prices: members.map(m => m.price).filter(Boolean) } };
  });
  return [...singles, ...packages];
}

// Interaction of a package: actual package gain versus the sum of member gains (non-additivity is expected).
export function packageInteraction(rows, metric = 'dps') {
  const byId = new Map(rows.map(r => [r.id, r]));
  return rows.filter(r => r.meta?.type === 'package' && r.deltas?.[metric]?.pct != null).map(r => {
    const parts = r.meta.members.map(m => byId.get(m)?.deltas?.[metric]?.pct);
    const sum = parts.every(v => typeof v === 'number') ? parts.reduce((s, v) => s + v, 0) : null;
    return { id: r.id, metric, package_pct: r.deltas[metric].pct, sum_of_members_pct: sum, interaction_pct: sum == null ? null : r.deltas[metric].pct - sum };
  });
}
