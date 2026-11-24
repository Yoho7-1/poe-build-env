// WP7: principle candidates from the corpus (master prompt 3A.4). The tier model counts how often a component carries
// builds overall; a principle is conditional: "component K carries builds in context C (attack builds, DoT builds, life
// pool, mana by leech...) and rarely outside it". Local statistics over stored corpus ablations x BuildCard features;
// every candidate keeps its supporting builds and counterexamples. Candidates become lab hypotheses (verification
// 'hypothesis'); status only moves through lab gates after a test (ablation on a held-out build or transfer).
import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicJson, flags } from './workspace.mjs';
import { readCards, qualityFilter, componentKeys, ablationDirectory } from './corpus-learn.mjs';
import { corpusDirectory } from './corpus.mjs';

const stem = f => String(f ?? '').replace(/\.(xml|json)$/i, '');
const CARRY = new Set(['core', 'major']);
const DOT = new Set(['skill_dot', 'ignite', 'poison', 'bleed']);

// Context features of a build (BuildCard + foundation). Unknown values are left out (no context, no claim).
export function contextsOf(card) {
  const tags = new Set(card.skills?.main?.tags ?? []);
  const out = {};
  out.family = card.damage?.scope === 'minion' || tags.has('minion') ? 'minion' : tags.has('attack') ? 'attack' : tags.has('spell') ? 'spell' : null;
  const f = card.damage?.primary_form;
  out.form = f === 'hit' ? 'hit' : DOT.has(f) ? 'dot' : null;
  out.type = card.features?.primary_type ?? null;
  out.pool = card.features?.defense_pool ?? null;
  out.mana = card.foundation?.mana?.applies ? card.foundation.mana.primary : null;
  out.ascendancy = card.features?.ascendancy ?? null;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null && v !== 'None'));
}

// rows: [{build, keys:[...], tier}] one per component; per build a key keeps its strongest tier (carries if any row carries).
export function buildKeyTable(rows) {
  const table = new Map();
  for (const r of rows) for (const k of r.keys) {
    if (!table.has(k)) table.set(k, new Map());
    const m = table.get(k);
    m.set(r.build, (m.get(r.build) ?? false) || CARRY.has(r.tier));
  }
  return table;
}

// Candidates: key K, context d=v with >= minIn builds having K in context, carry share in context >= minShare and
// at least minLift above the share outside the context (>= minOut builds outside). Also the reverse ("does not carry
// in v though it carries elsewhere"). Score = lift x sqrt(n_in).
export function principleCandidates({ table, contexts, minIn = 3, minOut = 3, minShare = 0.6, minLift = 0.4, skipGeneric = true }) {
  const out = [];
  for (const [key, builds] of table) {
    if (skipGeneric && !key.includes(':')) continue;
    if (/^tree:|^item:[^:]+$/.test(key)) continue; // node types and bare slots are covered by insights
    const dims = new Map();
    for (const b of builds.keys()) for (const [d, v] of Object.entries(contexts.get(b) ?? {})) { if (!dims.has(d)) dims.set(d, new Set()); dims.get(d).add(v); }
    for (const [d, values] of dims) for (const v of values) {
      const inB = [...builds].filter(([b]) => contexts.get(b)?.[d] === v), outB = [...builds].filter(([b]) => contexts.get(b)?.[d] != null && contexts.get(b)[d] !== v);
      if (inB.length < minIn || outB.length < minOut) continue;
      const sIn = inB.filter(([, c]) => c).length / inB.length, sOut = outB.filter(([, c]) => c).length / outB.length;
      const lift = sIn - sOut;
      const dir = sIn >= minShare && lift >= minLift ? 'carries_in_context' : sOut >= minShare && -lift >= minLift ? 'weak_in_context' : null;
      if (!dir) continue;
      const support = dir === 'carries_in_context' ? inB.filter(([, c]) => c) : inB.filter(([, c]) => !c);
      const counter = dir === 'carries_in_context' ? inB.filter(([, c]) => !c) : inB.filter(([, c]) => c);
      out.push({ key, context: { [d]: v }, direction: dir, n_in: inB.length, n_out: outB.length, share_in: r2(sIn), share_out: r2(sOut), lift: r2(lift),
        score: r2(Math.abs(lift) * Math.sqrt(inB.length)), support: support.map(([b]) => b), counterexamples: counter.map(([b]) => b) });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
const r2 = v => Math.round(v * 100) / 100;

export function corpusPrinciples({ minLevel = 80, minIn = 3, minShare = 0.6, minLift = 0.4, top = 30, cards = null, ablations = ablationDirectory() } = {}) {
  const list = cards ?? readCards();
  const q = qualityFilter(list, { minLevel });
  const contexts = new Map(list.filter(c => q.keep.has(stem(c.identity?.file ?? c._card))).map(c => [stem(c.identity.file), contextsOf(c)]));
  const rows = [];
  if (fs.existsSync(ablations)) for (const f of fs.readdirSync(ablations).filter(f => f.endsWith('.json'))) {
    const b = stem(f);
    if (!contexts.has(b)) continue;
    for (const r of readJson(path.join(ablations, f)).rows ?? []) if (!r.error && r.tier) rows.push({ build: b, keys: componentKeys(r).filter(k => k.includes(':')), tier: r.tier });
  }
  const builds = new Set(rows.map(r => r.build));
  const cands = principleCandidates({ table: buildKeyTable(rows), contexts, minIn, minShare, minLift });
  return { schema: 'corpus-principles/1', builds: builds.size, components: rows.length, thresholds: { min_level: minLevel, min_in: minIn, min_share: minShare, min_lift: minLift },
    candidates: cands.slice(0, top), total_candidates: cands.length,
    caveat: 'Conditional frequencies over a small corpus biased to popular guides; PoB numbers only. Each candidate is a hypothesis: test by ablation of a held-out build in the context and of one outside it (lab gates), not a rule.' };
}

const describe = c => {
  const [d, v] = Object.entries(c.context)[0];
  const what = c.key.replace(/^(\w+):/, '$1 ');
  return c.direction === 'carries_in_context'
    ? `${what} carries (core/major) ${Math.round(c.share_in * 100)}% of ${d}=${v} builds vs ${Math.round(c.share_out * 100)}% elsewhere`
    : `${what} rarely carries in ${d}=${v} builds (${Math.round(c.share_in * 100)}%) though it does elsewhere (${Math.round(c.share_out * 100)}%)`;
};
// Writes the top candidates as lab hypotheses (skips titles already in the ledger).
export async function recordPrinciples(result, { limit = 10, ledger } = {}) {
  const lab = await import('./lab.mjs');
  const existing = new Set([...lab.loadLedger(ledger).values()].map(r => r.title));
  const created = [], skipped = [];
  for (const c of result.candidates.slice(0, limit)) {
    const title = `Corpus principle: ${describe(c)}`.slice(0, 200);
    if (existing.has(title)) { skipped.push(title); continue; }
    const r = lab.createRecord({ type: 'hypothesis', title, confidence: 'low', tags: ['wp7', 'corpus-principle', c.direction, ...Object.keys(c.context)],
      statement: `${describe(c)} (n_in=${c.n_in}, n_out=${c.n_out}, lift ${c.lift}).`,
      mechanism: 'Unknown: a conditional frequency from corpus ablations. To explain from mechanics before promotion.',
      builds: c.support.slice(0, 20), counterexamples: c.counterexamples.slice(0, 20),
      test_plan: 'Ablate the component on a held-out build inside the context and on one outside it (analyze ablate); predict the tier first (lab predict). Promotion only through lab gates.',
      evidence: [{ kind: 'ablation', ref: 'research/lab/corpus/ablation', summary: `corpus ablations: ${c.n_in} builds in context, ${c.n_out} outside; share in ${c.share_in}, outside ${c.share_out}`, data: { key: c.key, context: c.context } }] }, { file: ledger });
    created.push(r.id);
  }
  return { created, skipped };
}

export function principlesCommand(args) {
  const { positional, options } = flags(args, ['min-level', 'min-in', 'min-share', 'min-lift', 'top', 'out', 'record'], []);
  if (positional[0] !== 'principles') throw new Error('Use corpus principles [--min-in 3] [--min-share 0.6] [--min-lift 0.4] [--top 30] [--record N] [--out f.json]');
  const r = corpusPrinciples({ minLevel: Number(options['min-level'] ?? 80), minIn: Number(options['min-in'] ?? 3), minShare: Number(options['min-share'] ?? 0.6), minLift: Number(options['min-lift'] ?? 0.4), top: Number(options.top ?? 30) });
  if (options.out) atomicJson(path.resolve(options.out), r);
  if (options.record) return recordPrinciples(r, { limit: Number(options.record) }).then(rec => ({ ...r, lab: rec }));
  return r;
}
export const principlesHelp = {
  'corpus principles [--min-in 3] [--min-share 0.6] [--min-lift 0.4] [--top 30] [--record N] [--out f.json]': 'WP7: conditional principle candidates from corpus ablations x BuildCard contexts (skill family, hit/DoT, damage type, defense pool, mana source, ascendancy): component carries builds in a context and rarely outside it (or the reverse), with supporting builds and counterexamples; --record N writes the top N as lab hypotheses (verification hypothesis)'
};
