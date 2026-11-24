// WP11 items 2 and 4: one variant model for `design generate`, `design optimize` and `analyze candidates|upgrades`.
//
// A variant is one choice on one resource, compared with the best alternative on the same resource:
//   resource   {kind: points|slot|socket|currency, key, amount}   (key makes variants on one resource exclusive)
//   gain       {dps_pct, ehp_pct, total} against `alternative`   (from the PoB probe that decided it; null = not probed)
//   components what has to be bought (prices-model component specs) -> price: exact / estimated / unknown, never merged
// selectInBudget() picks by gain per unit price inside the request budget and names the next investment tier. A request
// without a budget gets an explicitly unpriced comparison. Nothing here touches the network or decides for the user.
import { quoteComponent, quoteNamed, priceContext, openPriceDb, DEFAULT_PLATFORM } from './prices-model.mjs';

export const RESOURCE_KINDS = ['points', 'slot', 'socket', 'currency'];
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const lines = text => String(text ?? '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);

export function makeVariant({ id, source, label = id, resource, gain = null, alternative = null, decided_by = null, taken = true, components = [], required = false, prior = null, notes = [] }) {
  if (!id) throw new Error('variant id required');
  if (!resource || !RESOURCE_KINDS.includes(resource.kind)) throw new Error(`variant ${id}: resource.kind must be ${RESOURCE_KINDS.join('|')}`);
  return { id, source, label, resource: { key: resource.key ?? resource.kind, amount: resource.amount ?? null, ...resource }, gain, alternative, decided_by, taken, required,
    components, ...(prior ? { prior } : {}), ...(notes.length ? { notes } : {}) };
}
export const gainOf = (dps_pct, ehp_pct) => (dps_pct == null && ehp_pct == null ? null : { dps_pct: round(dps_pct ?? 0, 1), ehp_pct: round(ehp_pct ?? 0, 1), total: round((dps_pct ?? 0) + (ehp_pct ?? 0), 2) });

// ---------- components from PoB item text / gems ----------
// Rare/magic/normal: base price x affix band (always `estimated`); unique: by name; eldritch implicits and anoints:
// no feed prices the currency attempts behind them -> explicit `unknown` components.
export function componentsFromItem(slot, text) {
  const l = lines(text);
  if (!l.length) return [];
  const rarity = /^Rarity:\s*(\w+)/i.exec(l[0])?.[1]?.toUpperCase() ?? null;
  const name = rarity ? l[1] : l[0];
  if (rarity === 'UNIQUE') return [{ kind: 'unique', name, slot }];
  const base = rarity === 'RARE' ? l[2] : rarity === 'MAGIC' || rarity === 'NORMAL' ? null : l[1];
  const iImpl = l.findIndex(x => /^Implicits:\s*\d+/.test(x));
  const nImpl = iImpl >= 0 ? Number(/\d+/.exec(l[iImpl])[0]) : 0;
  const implicits = iImpl >= 0 ? l.slice(iImpl + 1, iImpl + 1 + nImpl) : [];
  const explicit = iImpl >= 0 ? l.slice(iImpl + 1 + nImpl) : [];
  const crafted = explicit.filter(x => /^\{crafted\}/.test(x));
  const anoint = [...implicits, ...explicit].map(x => /^(?:\{[^}]*\})*Allocates (.+)$/.exec(x)?.[1]).find(Boolean);
  const natural = explicit.filter(x => !/^\{crafted\}/.test(x));
  const out = [];
  if (/Cluster Jewel$/.test(base ?? '')) {
    const passives = Number(l.find(x => /^Cluster Jewel Node Count:/.test(x))?.split(':')[1]) || Number(/Adds (\d+) Passive Skills/.exec(text)?.[1]) || null;
    const enchant = [...implicits, ...explicit].map(x => x.replace(/^(?:\{[^}]*\})+/, '')).find(x => /^Added Small Passive Skills grant: /.test(x));
    out.push({ kind: 'cluster', size: base, passives, enchant: enchant?.replace(/^Added Small Passive Skills grant: /, '') ?? null, slot });
    return out;
  }
  // Magic flasks and normal bases price as base + band; the band of a magic item is its affix count (cheap band).
  const magic = rarity === 'MAGIC';
  const flaskBase = magic ? (l[1].match(/([A-Z][a-z]+ (?:Life|Mana|Hybrid) Flask|[A-Z][a-z]+ Flask)\b/)?.[1] ?? l[1]) : null;
  out.push({ kind: 'rare', base: base ?? flaskBase ?? name, slot, rarity: rarity?.toLowerCase() ?? null, item_level: Number(l.find(x => /^Item Level:/.test(x))?.split(':')[1]) || null,
    affixes: { count: magic ? Math.min(2, natural.length || 2) : natural.filter(x => !/^\{(?:exarch|eater)\}/.test(x)).length, crafted: crafted.filter(x => !/Allocates /.test(x)).length } });
  const eld = implicits.filter(x => /^\{(?:exarch|eater)\}/.test(x));
  if (eld.length) out.push({ kind: 'eldritch', name: `eldritch implicits (${eld.length})`, slot, unpriced: 'eldritch ember/ichor attempts to a chosen tier: no feed prices the outcome' });
  if (anoint) out.push({ kind: 'anoint', name: `anoint ${anoint}`, slot, unpriced: 'oil combinations are not in the allowed poe.ninja categories' });
  return out;
}
export function componentsFromGems(groups = [], { isSupport = () => false } = {}) {
  return groups.flatMap(g => (g.gems ?? []).filter(x => x.enabled !== false && x.name).map(x => ({ kind: 'gem', name: x.name, support: !!isSupport(x), gem_level: x.level ?? null, gem_quality: x.quality ?? null, group: g.label || null })));
}

// A generator cluster choice (design-cluster candidate, optionally with .nested) as price components.
export function clusterParts(c, text = null) {
  if (!c) return null;
  const one = (x, t) => ({ size: `${x.size} Cluster Jewel`, passives: Number(/Adds (\d+) Passive Skills/.exec(t ?? '')?.[1]) || null,
    enchant: (x.enchant ?? []).map(l => l.replace(/^Added Small Passive Skills grant: /, ''))[0] ?? null });
  return { ...one(c, text?.(c)), nested: c.nested ? one(c.nested, text?.(c.nested)) : null };
}

// ---------- pricing ----------
// Unpriced kinds (eldritch, anoint) are `unknown` by rule. Gems: PoB spells supports without " Support", the feed with it.
export function quoteAny(component, ctx) {
  if (!ctx) return { component, cost_class: 'unknown', chaos: null, method: 'no_price_db', warnings: [{ code: 'no_price_data', detail: 'price database unavailable' }] };
  if (['eldritch', 'anoint', 'unpriced'].includes(component.kind)) return { component, cost_class: 'unknown', chaos: null, method: 'not_in_feed', warnings: [{ code: 'no_price_data', detail: component.unpriced }] };
  if (component.kind === 'gem') {
    const q = quoteNamed({ ...component, name: component.support && !/ Support$/.test(component.name) ? `${component.name} Support` : component.name }, ctx);
    return q.cost_class === 'unknown' && component.support ? quoteNamed(component, ctx) : q;
  }
  if (component.kind === 'any') {
    for (const kind of ['unique', 'gem', 'currency']) { const q = quoteAny({ ...component, kind }, ctx); if (q.cost_class !== 'unknown') return q; }
    return quoteNamed({ ...component, kind: 'unique' }, ctx);
  }
  return quoteComponent(component, ctx);
}
const nameOf = c => c.name ?? c.enchant ?? c.base ?? c.kind;
// Price of one variant: exact chaos and the estimated range are kept apart, unknown components are listed, not zeroed.
export function priceVariant(v, ctx) {
  const quotes = v.components.map(c => quoteAny(c, ctx));
  const exact = quotes.filter(q => q.cost_class === 'exact'), est = quotes.filter(q => q.cost_class === 'estimated'), unk = quotes.filter(q => q.cost_class === 'unknown');
  const sum = (list, f) => round(list.reduce((n, q) => n + (f(q) ?? 0), 0));
  const cost_class = !quotes.length ? 'none' : unk.length ? 'unknown' : est.length ? 'estimated' : 'exact';
  const conflicted = [...new Set(quotes.map(q => q.category).filter(c => c && ctx?.inconsistent_categories?.has(c)))];
  const dates = quotes.map(q => q.date).filter(Boolean).sort();
  return { ...v, price: { cost_class, exact_chaos: exact.length ? sum(exact, q => q.chaos) : null,
    estimated_chaos: est.length ? sum(est, q => q.chaos) : null, estimated_range: est.length ? [sum(est, q => q.chaos_range?.[0] ?? q.chaos), sum(est, q => q.chaos_range?.[1] ?? q.chaos)] : null,
    unknown: unk.map(q => `${nameOf(q.component)}${q.warnings?.[0]?.detail ? `: ${q.warnings[0].detail}` : ''}`),
    quotes: quotes.map(q => ({ component: nameOf(q.component), kind: q.component.kind, cost_class: q.cost_class, chaos: q.chaos ?? null, range: q.chaos_range ?? null, method: q.method, date: q.date ?? null, source: q.source ?? null })),
    snapshot_dates: dates.length ? [dates[0], dates.at(-1)] : null, conversion: conflicted.length ? { code: 'inconsistent_currency_conversion', categories: conflicted } : null } };
}

// CLI budget: "5div", "5 divine", "300c", "300chaos".
export function parseBudget(text) {
  if (text == null || text === '') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(div|divine|d|c|chaos)?\s*$/i.exec(String(text));
  if (!m) throw new Error('--budget must look like 5div or 300c');
  return { amount: Number(m[1]), currency: /^d/i.test(m[2] ?? 'c') ? 'divine' : 'chaos' };
}

// Budget in chaos. Divine is converted by the dated Currency feed; when a touched category is flagged
// inconsistent_currency_conversion the lower of the two rates is used (conservative) and both are reported.
export function budgetInChaos(budget, ctx, touched = []) {
  if (!budget || !Number.isFinite(budget.amount)) return null;
  const cur = String(budget.currency ?? 'chaos').toLowerCase();
  if (/^chaos/.test(cur)) return { amount: budget.amount, currency: 'chaos', chaos: budget.amount, rate: null, rule: 'budget given in chaos' };
  if (!/^div/.test(cur)) return { amount: budget.amount, currency: cur, chaos: null, rule: `unsupported budget currency ${cur}` };
  const div = ctx ? quoteNamed({ kind: 'currency', name: 'Divine Orb' }, ctx) : null;
  const feed = div?.cost_class === 'exact' ? div.chaos : null;
  const conflicts = (ctx?.conversion?.categories ?? []).filter(c => c.status === 'inconsistent_currency_conversion' && (!touched.length || touched.includes(c.category)));
  const implied = conflicts.map(c => c.item_implied_chaos_per_divine_median).filter(Number.isFinite);
  const rate = feed == null ? null : implied.length ? Math.min(feed, ...implied) : feed;
  return { amount: budget.amount, currency: 'divine', chaos: rate == null ? null : round(budget.amount * rate), rate: round(rate),
    rate_source: feed == null ? 'no Currency snapshot: budget not convertible' : `Currency feed Divine Orb ${round(feed)} chaos (${div.date})`,
    ...(conflicts.length ? { conversion: { code: 'inconsistent_currency_conversion', item_implied: implied.map(x => round(x)), used: 'lower rate (conservative)' } } : {}) };
}

// ---------- selection ----------
const midCost = p => (p.exact_chaos ?? 0) + (p.estimated_chaos ?? 0);
const highCost = p => (p.exact_chaos ?? 0) + (p.estimated_range?.[1] ?? p.estimated_chaos ?? 0);
const spentOf = list => {
  const ex = list.reduce((n, v) => n + (v.price.exact_chaos ?? 0), 0), em = list.reduce((n, v) => n + (v.price.estimated_chaos ?? 0), 0);
  const lo = list.reduce((n, v) => n + (v.price.estimated_range?.[0] ?? v.price.estimated_chaos ?? 0), 0), hi = list.reduce((n, v) => n + (v.price.estimated_range?.[1] ?? v.price.estimated_chaos ?? 0), 0);
  return { exact_chaos: round(ex), estimated_chaos: round(em), estimated_range: em ? [round(lo), round(hi)] : null, binding_chaos: round(ex + em) };
};
// Variants must be priced (priceVariant). Required variants (base kit, main gem) are paid first; optional ones
// (gain > 0, taken by their probe) by gain per chaos. Exclusive resource keys keep the best ratio only. Unknown price:
// never chosen as if free, listed under needs_price. Gains are against each variant's own alternative: the sum is a
// ranking aid, not an additive prediction.
export function selectInBudget(variants, { budget = null, ctx = null, archetype = null, order = null } = {}) {
  const priced = variants.filter(v => v.price);
  const touched = [...new Set(priced.flatMap(v => v.price.conversion?.categories ?? []))];
  // Kept without a positive measured gain (a guard, the author's build, no probe budget) but with parts to buy: paid
  // like the base, never dropped from the cost.
  const isRequired = v => v.required || (v.taken && !((v.gain?.total ?? 0) > 0) && v.components.length > 0);
  const required = priced.filter(isRequired);
  const optional = priced.filter(v => !isRequired(v) && v.taken && (v.gain?.total ?? 0) > 0);
  const needs_price = [...required, ...optional].filter(v => v.price.cost_class === 'unknown').map(v => ({ id: v.id, label: v.label, unknown: v.price.unknown }));
  const known = optional.filter(v => v.price.cost_class !== 'unknown');
  const free = known.filter(v => v.price.cost_class === 'none' || midCost(v.price) === 0);
  const ratio = v => v.gain.total / Math.max(1e-6, midCost(v.price));
  const best = new Map();
  for (const v of known.filter(x => !free.includes(x)).sort((a, b) => ratio(b) - ratio(a) || a.id.localeCompare(b.id))) if (!best.has(v.resource.key)) best.set(v.resource.key, v);
  const candidates = [...best.values()];
  const base = required.filter(v => v.price.cost_class !== 'unknown');
  const brief = v => ({ id: v.id, label: v.label, resource: v.resource.key, gain_total: v.gain?.total ?? null, cost_class: v.price.cost_class, chaos: round(midCost(v.price)), chaos_high: round(highCost(v.price)), gain_per_100c: midCost(v.price) > 0 && v.gain ? round(v.gain.total / midCost(v.price) * 100) : null, ...(v.prior ? { prior: v.prior } : {}) });
  if (!budget) {
    return { mode: 'unpriced_comparison', budget_applied: false, archetype, note: 'Request has no budget: variants are compared by gain only; prices are attached for information and do not decide anything.',
      chosen: [...optional].sort((a, b) => (b.gain?.total ?? 0) - (a.gain?.total ?? 0) || a.id.localeCompare(b.id)).map(brief), base: spentOf(base), needs_price, trim_order: order ?? undefined };
  }
  const b = budgetInChaos(budget, ctx, touched);
  if (b?.chaos == null) return { mode: 'budget_not_convertible', budget_applied: false, budget: b, archetype, chosen: [...free, ...candidates].map(brief), base: spentOf(base), needs_price,
    note: 'The budget could not be expressed in chaos from local snapshots; compared without price.' };
  const baseSpent = spentOf(base);
  let left = b.chaos - baseSpent.binding_chaos;
  const chosen = [...free], skipped = [];
  for (const v of candidates) { const c = midCost(v.price); if (c <= left) { chosen.push(v); left -= c; } else skipped.push(v); }
  const spent = spentOf([...base, ...chosen]);
  const over = baseSpent.binding_chaos > b.chaos;
  // Next tier: the smallest step up that buys the best-ratio variant still outside, and the price of taking all of them.
  const next = skipped[0] ? { adds: [brief(skipped[0])], budget_chaos: round(spent.binding_chaos + midCost(skipped[0].price)),
    budget_divine: b.rate ? round((spent.binding_chaos + midCost(skipped[0].price)) / b.rate, 1) : null, all_remaining_chaos: round(spent.binding_chaos + skipped.reduce((n, v) => n + midCost(v.price), 0)) } : null;
  return { mode: 'budget', budget_applied: true, archetype, budget: b, over_budget_base: over, base: baseSpent,
    chosen: chosen.map(brief), spent, left_chaos: round(b.chaos - spent.binding_chaos),
    fits_high_estimate: highCost({ exact_chaos: spent.exact_chaos, estimated_range: spent.estimated_range, estimated_chaos: spent.estimated_chaos }) <= b.chaos,
    not_in_budget: skipped.map(brief), next_tier: over ? { reason: 'the required base alone exceeds the budget', budget_chaos: baseSpent.binding_chaos, budget_divine: b.rate ? round(baseSpent.binding_chaos / b.rate, 1) : null, trim_order: order ?? null } : next,
    needs_price, metrics_scope: 'gains come from the probes that decided each variant; the chosen set is not re-probed as a whole',
    note: 'Exact and estimated chaos are reported apart; binding_chaos uses the estimate midpoint, fits_high_estimate the top of the rare bands. Unknown prices are not counted as free: they are listed under needs_price. Gains are each against its own alternative, not additive.' };
}

// ---------- adapters ----------
// design generate: layer records + chosen supports + the prototype's items and gems.
const LAYER_RESOURCE = { cluster: { kind: 'points', key: 'points:cluster_reserve' }, masteries: { kind: 'points', key: 'points:mastery_reserve' },
  eldritch: { kind: 'slot', key: 'implicits:armour' }, flasks: { kind: 'slot', key: 'slot:flasks' }, anoint: { kind: 'slot', key: 'anoint:Amulet' } };
export function prototypeVariants({ id, layers = [], build = null, supports = null, cluster = null, isSupport = () => false }) {
  const out = [];
  const slots = build?.slots ?? new Map();
  const items = [...slots.entries()].map(([slot, text]) => ({ slot, comps: componentsFromItem(slot, text) }));
  const comp = (slot, kinds) => items.filter(i => i.slot === slot || (slot instanceof RegExp && slot.test(i.slot))).flatMap(i => i.comps.filter(c => kinds.includes(c.kind)));
  for (const l of layers.filter(x => x?.layer)) {
    const res = LAYER_RESOURCE[l.layer] ?? (l.layer.startsWith('keystone:') ? { kind: 'points', key: `points:${l.layer}` } : { kind: 'slot', key: `layer:${l.layer}` });
    let components = [];
    if (l.layer === 'cluster' && l.taken && cluster) components = [{ kind: 'cluster', size: cluster.size, passives: cluster.passives, enchant: cluster.enchant, slot: 'jewel socket' }, ...(cluster.nested ? [{ kind: 'cluster', size: cluster.nested.size, passives: cluster.nested.passives, enchant: cluster.nested.enchant, slot: 'inner jewel socket' }] : [])];
    if (l.layer === 'eldritch' && l.taken) components = items.flatMap(i => i.comps.filter(c => c.kind === 'eldritch'));
    // Flasks: one variant per kept flask (each was probed against its slot left empty; the layer has no single gain).
    if (l.layer === 'flasks' && l.flasks?.length) {
      for (const f of l.flasks) out.push(makeVariant({ id: `${id}:flask:${f.slot}`, source: 'design_generate', label: f.flask ?? f.slot, resource: { kind: 'slot', key: `slot:${f.slot}` }, gain: f.gain ?? null,
        alternative: 'the same flask slot empty', decided_by: l.decided_by, taken: !!f.taken, components: f.taken ? comp(f.slot, ['rare']) : [] }));
      continue;
    }
    if (l.layer === 'anoint' && l.taken) components = comp('Amulet', ['anoint']);
    out.push(makeVariant({ id: `${id}:${l.layer}`, source: 'design_generate', label: l.layer, resource: res, gain: l.gain_vs_alternative ?? null, alternative: l.alternative, decided_by: l.decided_by, taken: !!l.taken, components, ...(l.prior ? { prior: l.prior } : {}) }));
  }
  // Supports: each chosen one against the link left empty (the probe's base), on the socket it occupies.
  for (const p of (supports?.probes ?? []).filter(x => (supports.chosen ?? []).includes(x.name)))
    out.push(makeVariant({ id: `${id}:support:${p.name}`, source: 'design_generate', label: `support ${p.name}`, resource: { kind: 'socket', key: `socket:main:${p.name}` }, gain: gainOf(p.gain_pct, 0),
      alternative: 'the main group without it', decided_by: 'pob_probe', components: [{ kind: 'gem', name: p.name, support: true, gem_level: 20, gem_quality: 20 }] }));
  // Required base: every item not already priced by a layer (eldritch/anoint/flask layers carry their own parts) and every gem.
  const layered = new Set(out.flatMap(v => v.components.map(c => `${c.slot}|${c.kind}`)));
  const chosenSup = new Set((supports?.chosen ?? []));
  for (const i of items) {
    const parts = i.comps.filter(c => !layered.has(`${c.slot}|${c.kind}`));
    if (parts.length) out.push(makeVariant({ id: `${id}:item:${i.slot}`, source: 'design_generate', label: i.slot, resource: { kind: 'slot', key: `slot:${i.slot}` }, required: true, decided_by: 'kit', components: parts }));
  }
  const gems = componentsFromGems(build?.groups ?? [], { isSupport }).filter(g => !chosenSup.has(g.name));
  if (gems.length) out.push(makeVariant({ id: `${id}:gems`, source: 'design_generate', label: 'gems (main skill, auras, utility)', resource: { kind: 'socket', key: 'socket:gems' }, required: true, decided_by: 'kit', components: gems }));
  return out;
}

// analyze candidates|upgrades: ranking rows (deltas against the current build) + the candidate's price spec.
export function upgradeVariants(rows, candidatesById = new Map(), { metric = 'dps', source = 'analyze_upgrades' } = {}) {
  return rows.filter(r => !r.error).map(r => {
    const c = candidatesById.get(r.id) ?? {};
    const ch = c.changes ?? {};
    const resource = ch.replace_items?.length ? { kind: 'slot', key: `slot:${ch.replace_items.map(i => i.slot).join('+')}` }
      : ch.tree || c.cost?.points ? { kind: 'points', key: `points:${r.id}`, amount: c.cost?.points ?? null }
      : ch.skills?.groups?.length ? { kind: 'socket', key: `socket:g${ch.skills.groups[0].group}:${ch.skills.groups[0].replace_gems?.[0]?.gem ?? 'free'}` }
      : ch.add_support || ch.skills || ch.gem_levels ? { kind: 'socket', key: `socket:${r.id}` } : { kind: 'slot', key: `other:${r.id}` };
    const spec = c.price ?? null;
    // Something is bought (an item or a gem) but no price variant matched: an explicit unknown, never free.
    const buys = resource.kind === 'slot' || resource.kind === 'socket';
    const components = spec ? [{ kind: spec.kind ?? 'any', name: spec.name, variant: spec.variant ?? null, ...(spec.filters ?? {}) }]
      : /anoint/i.test(r.id) ? [{ kind: 'anoint', name: r.label ?? r.id, unpriced: 'oil combinations are not in the allowed poe.ninja categories' }]
      : buys ? [{ kind: 'unpriced', name: r.label ?? r.id, unpriced: 'no price variant matched in the dated snapshot' }] : [];
    const d = r.deltas ?? {};
    return makeVariant({ id: r.id, source, label: r.label ?? r.id, resource, gain: gainOf(d.dps?.pct ?? null, d.ehp?.pct ?? null), alternative: 'the current build (baseline)', decided_by: 'pob_probe', components });
  });
}

// design optimize: applied steps (each against the state before it).
export function optimizeVariants(steps = []) {
  return steps.filter(s => s.result === 'applied').map((s, i) => makeVariant({ id: `step${i + 1}:${s.phase}`, source: 'design_optimize', label: s.label,
    resource: s.phase === 'tree' ? { kind: 'points', key: `points:step${i + 1}` } : s.phase === 'supports' ? { kind: 'socket', key: `socket:step${i + 1}` } : { kind: 'slot', key: `slot:${s.slot ?? s.kind ?? i}` },
    gain: gainOf(s.dps_pct, s.ehp_pct), alternative: 'the build before this step', decided_by: 'pob_probe', components: s.component ? [s.component] : [] }));
}

// One price context per command; null when the reference db is missing (every quote then says so).
export function withPriceContext(fn, { platform = DEFAULT_PLATFORM } = {}) {
  let db = null, ctx = null;
  try { db = openPriceDb(); ctx = priceContext({ db, platform }); } catch { ctx = null; }
  try { return fn(ctx); } finally { db?.close(); }
}
export function priceSummary(selection) {
  if (!selection) return null;
  const s = selection.spent ?? selection.base;
  return { mode: selection.mode, exact_chaos: s?.exact_chaos ?? null, estimated_chaos: s?.estimated_chaos ?? null, estimated_range: s?.estimated_range ?? null,
    unknown: selection.needs_price.flatMap(x => x.unknown), next_tier: selection.next_tier ?? null };
}
