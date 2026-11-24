// WP11 item 4: confirmed WP7 principles as generator priors. The ledger is read only; a rule is active only while its
// record has a confirmed status. A prior may order or prune candidates (with the record id as the reason); it never
// replaces a PoB probe: every candidate it lets through is still decided by PoB against the same points.
import { getRecord, defaultLedger } from './lab.mjs';

export const CONFIRMED = ['experimentally-validated', 'generalized', 'game-verified'];
// Context thresholds come from the records' own conditions (P-004: minor below ~550 Strength).
export const PRIOR_RULES = {
  'P-004': { kind: 'keystone', node: 'Iron Will',
    plan: c => c.family !== 'spell' ? null
      : c.str == null ? { action: 'probe', reason: 'Strength unknown: probed' }
      : c.str >= 550 ? { action: 'probe', reason: `Strength ${Math.round(c.str)} >= ~550 with spell damage: may pay (P-004)` }
      : { action: 'prune', reason: `Strength ${Math.round(c.str)} < ~550: expected minor whatever the skill family (P-004)` } },
  'P-005': { kind: 'keystone', node: 'Mind Over Matter',
    plan: c => c.minion ? null
      : c.hit ? { action: 'probe', reason: `hit build: MoM is a core defence layer in hit builds (P-005)${c.unreservedMana != null && c.unreservedMana < 300 ? `; small unreserved mana ${Math.round(c.unreservedMana)} is the known counterexample` : ''}` }
      : { action: 'prune', reason: 'damage-over-time build: MoM is minor here (P-005)' } },
  // P-007: the rare belt pays in defence; when a base kit must be trimmed for budget, the belt goes last in leech builds.
  'P-007': { kind: 'slot_order', slot: 'Belt', order: c => (c.leech ? 'last' : 'neutral'),
    reason: c => (c.leech ? 'rare belt is core for EHP in leech life builds (P-007): trimmed last' : 'regen build: belt is core in only half of them (P-007): no reordering') },
};

export function loadPriors({ file = defaultLedger(), ids = Object.keys(PRIOR_RULES) } = {}) {
  return ids.map(id => {
    let rec = null;
    try { const r = getRecord(id, { file }); rec = r?.record ?? r; } catch { rec = null; }
    const active = !!rec && CONFIRMED.includes(rec.status);
    return { id, ...PRIOR_RULES[id], status: rec?.status ?? 'missing', title: rec?.title ?? null, active, revision: rec?.revision ?? null };
  });
}

// Keystone candidates the priors let through to a PoB probe, and those they prune (reported, not hidden).
export function keystonePlan(priors, context, { allocated = [] } = {}) {
  const have = new Set(allocated);
  return priors.filter(p => p.active && p.kind === 'keystone').flatMap(p => {
    if (have.has(p.node)) return [];
    const d = p.plan(context);
    return d ? [{ prior: p.id, node: p.node, ...d }] : [];
  });
}

// Order in which base-kit slots are economised first when the base exceeds the budget (pure ordering, no gain claim).
export function trimOrder(priors, slots, context) {
  const rules = priors.filter(p => p.active && p.kind === 'slot_order');
  const last = new Set(rules.filter(r => r.order(context) === 'last').map(r => r.slot));
  const ordered = [...slots.filter(s => !last.has(s)), ...slots.filter(s => last.has(s))];
  return { order: ordered, priors: rules.map(r => ({ prior: r.id, slot: r.slot, effect: r.reason(context) })) };
}
