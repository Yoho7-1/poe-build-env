// WP7: principle candidates from the corpus (master prompt 3A.4). The tier model counts how often a component carries
// builds overall; a principle is conditional: "component K carries builds in context C (attack builds, DoT builds, life
// pool, mana by leech...) and rarely outside it". Local statistics over stored corpus ablations x BuildCard features;
// every candidate keeps its supporting builds and counterexamples. Candidates become lab hypotheses (verification
// 'hypothesis'); status only moves through lab gates after a test (ablation on a held-out build or transfer).
import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicJson, flags, dbRoot } from './workspace.mjs';
import { readCards, qualityFilter, componentKeys, ablationDirectory } from './corpus-learn.mjs';
import { corpusDirectory, heldOutDirectory, heldOutCards } from './corpus.mjs';
import { analyzeAblation } from './analysis-ablation.mjs';
import { backfillFoundations } from './corpus-norms.mjs';

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

// Config tautologies. A config flag is a calculation setting (the guide author's assumption), not a build component.
// Some flags are tied by definition to a context value: "enemy is Shocked" only adds damage to builds that shock
// (Lightning), "Withered stacks" scale Chaos, "Leeching" is true when mana comes from leech, an ascendancy whose own
// notables read the condition (Gladiator: "if you've Blocked Recently") carries it because the ascendancy defines it.
// Such a candidate restates the configuration or the context definition, so it is moved out of the ranked list with
// the reason. Domains: damage type / form / mana / family are fixed below; ascendancies come from the tree (nodes
// whose stats match the flag's text). Kinds: definitional (carries in a linked value), complement (weak in another
// value of a linked dimension: Shocked is weak in Cold builds), ascendancy_defines (an ascendancy's nodes read it).
export const CONFIG_DOMAINS = [
  { flags: /^(conditionEnemyShocked|conditionShockEffect|conditionShockedEnemyRecently|conditionEnemyLightningExposure)$/, type: ['Lightning'], text: /\bShock|Lightning Exposure/i },
  { flags: /^(conditionEnemyIgnited|conditionEnemyBurning)$/, type: ['Fire'], form: ['dot'], text: /Ignit|Burning/i },
  { flags: /^conditionEnemyFireExposure$/, type: ['Fire'], text: /Fire Exposure/i },
  { flags: /^(conditionEnemyChilled|conditionEnemyChilledEffect|conditionEnemyFrozen|conditionEnemyBrittle)$/, type: ['Cold'], text: /Chill|Frozen|Freez|Cold Ailment/i },
  { flags: /^conditionEnemyColdExposure$/, type: ['Cold'], text: /Cold Exposure/i },
  { flags: /^(conditionEnemyPoisoned|multiplierPoisonOnEnemy)$/, type: ['Chaos'], form: ['dot'], text: /Poison/i },
  { flags: /^multiplierWitheredStackCount$/, type: ['Chaos'], text: /Wither/i },
  { flags: /^conditionEnemyBleeding$/, type: ['Physical'], form: ['dot'], text: /Bleed/i },
  { flags: /^conditionLeeching$/, mana: ['leech'], text: /while Leeching/i },
  { flags: /^conditionBlockedRecently$/, text: /Blocked Recently/i },
  { flags: /^conditionStationary$/, text: /Stationary/i },
  { flags: /^conditionCritRecently$/, text: /Critical Strike Recently/i },
  { flags: /^multiplierRage$/, text: /\bRage\b/i },
  { flags: /^(conditionOnConsecratedGround|conditionEnemyOnConsecratedGround)$/, text: /Consecrated Ground/i },
  { flags: /^buffFortification$/, text: /Fortif/i },
  { flags: /^conditionEnemyUnnerved$/, text: /Unnerve/i },
  { flags: /^conditionEnemyIntimidated$/, text: /Intimidat/i },
  { flags: /^useEnduranceCharges$/, text: /Endurance Charge/i },
  { flags: /^useFrenzyCharges$/, text: /Frenzy Charge/i },
  { flags: /^usePowerCharges$/, text: /Power Charge/i },
  { flags: /^(conditionUsedWarcryRecently|multiplierWarcryUsedRecently)$/, text: /Warcry/i },
  { flags: /^(multiplierSummonedMinion|conditionUsedMinionSkillRecently)$/, family: ['minion'], text: /Minion/i },
];

let ascCache = null;
// ascendancy -> stat lines of its nodes (passive_nodes.jsonl, GGG tree). Missing data: no ascendancy links (no claim).
export function ascendancyStats(file = path.join(dbRoot, 'data', 'knowledge', 'passive_nodes.jsonl')) {
  if (ascCache?.file === file) return ascCache.map;
  const map = new Map();
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const d = JSON.parse(line).data;
    if (!d?.ascendancyName) continue;
    if (!map.has(d.ascendancyName)) map.set(d.ascendancyName, []);
    map.get(d.ascendancyName).push(...(d.stats ?? []));
  }
  ascCache = { file, map };
  return map;
}

// null, or {kind, reason} for a config tautology. asc: Map ascendancy -> stat lines.
export function configTautology(c, asc = ascendancyStats()) {
  const m = /^config:(.+)$/.exec(c.key);
  if (!m) return null;
  const flag = m[1], dom = CONFIG_DOMAINS.find(d => d.flags.test(flag));
  if (!dom) return null;
  const [d, v] = Object.entries(c.context)[0];
  const linked = dom[d];
  if (linked && c.direction === 'carries_in_context' && linked.includes(v))
    return { kind: 'definitional', reason: `config flag ${flag} only affects ${d}=${linked.join('/')} builds by definition; carrying there restates the calculation setting` };
  if (linked && c.direction === 'weak_in_context' && !linked.includes(v))
    return { kind: 'complement', reason: `config flag ${flag} is tied to ${d}=${linked.join('/')}; being weak in ${d}=${v} is the complement of that definition` };
  if (d === 'ascendancy' && c.direction === 'carries_in_context' && dom.text) {
    const hit = (asc.get(v) ?? []).find(t => dom.text.test(t));
    if (hit) return { kind: 'ascendancy_defines', reason: `${v} ascendancy nodes read the condition ("${hit}"); the flag carries because the context grants it` };
  }
  return null;
}

// Splits candidates into kept and filtered (each filtered one keeps 'filtered' {kind, reason}). keepTautologies leaves
// them ranked with a 'tautology' field; noConfig also filters every other config flag (a calculation assumption). Other
// config candidates stay ranked with config_assumption: true.
export function filterCandidates(cands, { keepTautologies = false, noConfig = false, asc } = {}) {
  const kept = [], filtered = [];
  for (const c of cands) {
    const t = configTautology(c, asc);
    if (t && keepTautologies) { kept.push({ ...c, tautology: t }); continue; }
    if (t) { filtered.push({ ...c, filtered: t }); continue; }
    if (noConfig && c.key.startsWith('config:')) { filtered.push({ ...c, filtered: { kind: 'config_assumption', reason: 'config flag: a calculation setting of the source build, not a component (--no-config)' } }); continue; }
    kept.push(c.key.startsWith('config:') ? { ...c, config_assumption: true } : c);
  }
  return { kept, filtered };
}

export function corpusPrinciples({ minLevel = 80, minIn = 3, minShare = 0.6, minLift = 0.4, top = 30, cards = null, ablations = ablationDirectory(), keepTautologies = false, noConfig = false, asc } = {}) {
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
  const all = principleCandidates({ table: buildKeyTable(rows), contexts, minIn, minShare, minLift });
  const { kept: cands, filtered } = filterCandidates(all, { keepTautologies, noConfig, asc });
  const byKind = {};
  for (const f of filtered) byKind[f.filtered.kind] = (byKind[f.filtered.kind] ?? 0) + 1;
  return { schema: 'corpus-principles/1', builds: builds.size, components: rows.length, thresholds: { min_level: minLevel, min_in: minIn, min_share: minShare, min_lift: minLift },
    candidates: cands.slice(0, top), total_candidates: cands.length,
    filtered: { total: filtered.length, by_kind: byKind, note: 'config tautologies: restate the calculation setting or the context definition; --keep-tautologies keeps them ranked with a tautology field',
      items: filtered.map(f => ({ key: f.key, context: f.context, direction: f.direction, score: f.score, ...f.filtered })) },
    caveat: 'Conditional frequencies over a small corpus biased to popular guides; PoB numbers only. Each candidate is a hypothesis: test by ablation of a held-out build in the context and of one outside it (lab gates), not a rule.' };
}

// ---------- held-out test selection (WP7 gates) ----------
// A principle is tested on builds the corpus statistics never saw: `corpus principles --match <key> --context d=v`
// lists held-out builds that actually contain the component, split into inside and outside the context, so a test has
// both sides. Presence comes from the ablation PLAN (component ids and labels, no engine run), so no tier - and no
// truth - exists before `analyze ablate` is run on the chosen build. A key with no builds on one side means the
// principle cannot be tested yet on this split, not that it holds.
// The mana dimension comes from BuildCard.foundation, which older cards do not carry: without it a build lands in
// `unknown` and the control side of a mana principle looks empty although the builds exist. Backfilling the held-out
// cards (one cached PoB run each) fills that side from PoB output instead of a guess.
export function backfillHeldOut({ cards = heldOutCards(), directory = heldOutDirectory(), limit = null, refresh = false } = {}) {
  return backfillFoundations({ cards, directory, limit, refresh });
}
export function heldOutContexts({ dir = heldOutCards() } = {}) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const card = readJson(path.join(dir, f));
    out.set(stem(card.identity?.file ?? f), { context: contextsOf(card), level: card.features?.level ?? null, ascendancy: card.features?.ascendancy ?? null, skill: card.skills?.main?.name ?? null, card: f });
  }
  return out;
}
export function heldOutMatches({ key, context = null, xmlDir = path.join(heldOutDirectory(), 'xml'), cardsDir = heldOutCards(), scenario = 'sustained', planner = analyzeAblation, backfill = false }) {
  if (!key) throw new Error('--match <component key> required, e.g. "node:Iron Will" or "item:Belt:RARE"');
  const backfilled = backfill ? backfillHeldOut({ cards: cardsDir }) : null;
  const contexts = heldOutContexts({ dir: cardsDir });
  const dim = context ? Object.keys(context)[0] : null, want = context ? Object.values(context)[0] : null;
  const inside = [], outside = [], unknown = [], failed = [];
  for (const file of (fs.existsSync(xmlDir) ? fs.readdirSync(xmlDir).filter(f => f.endsWith('.xml')).sort() : [])) {
    const build = stem(file), info = contexts.get(build);
    let components;
    try { components = planner({ file: path.join(xmlDir, file), scenario, plan: true }).components ?? []; }
    catch (e) { failed.push({ build, error: String(e.message ?? e) }); continue; }
    const hits = components.filter(c => componentKeys(c).includes(key)).map(c => ({ id: c.id, kind: c.kind, label: c.label }));
    if (!hits.length) continue;
    const row = { build, file: path.join(xmlDir, file), components: hits, context: info?.context ?? null, level: info?.level ?? null, ascendancy: info?.ascendancy ?? null, skill: info?.skill ?? null };
    if (!dim) { inside.push(row); continue; }
    const v = info?.context?.[dim] ?? null;
    (v === want ? inside : v == null ? unknown : outside).push(row);
  }
  return { key, context, scenario, held_out_builds: contexts.size, ...(backfilled ? { backfilled } : {}),
    inside, outside, unknown, ...(failed.length ? { failed } : {}),
    note: 'Presence from the ablation plan only; run analyze ablate --only <component id> on a chosen build to get its tier. Predict the tier in the lab ledger before the run.' };
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
  const { positional, options } = flags(args, ['min-level', 'min-in', 'min-share', 'min-lift', 'top', 'out', 'record', 'match', 'context', 'scenario'], ['keep-tautologies', 'no-config', 'backfill']);
  if (positional[0] !== 'principles') throw new Error('Use corpus principles [--min-in 3] [--min-share 0.6] [--min-lift 0.4] [--top 30] [--keep-tautologies] [--no-config] [--record N] [--match key --context d=v] [--out f.json]');
  if (options.match) {
    let context = null;
    if (options.context) {
      const [d, v] = String(options.context).split('=').map(s => s.trim());
      if (!d || !v) throw new Error('--context expects dimension=value, e.g. pool=life or family=attack');
      context = { [d]: v };
    }
    const r = heldOutMatches({ key: options.match, context, scenario: options.scenario ?? 'sustained', backfill: !!options.backfill });
    if (options.out) atomicJson(path.resolve(options.out), r);
    return r;
  }
  const r = corpusPrinciples({ minLevel: Number(options['min-level'] ?? 80), minIn: Number(options['min-in'] ?? 3), minShare: Number(options['min-share'] ?? 0.6), minLift: Number(options['min-lift'] ?? 0.4), top: Number(options.top ?? 30), keepTautologies: !!options['keep-tautologies'], noConfig: !!options['no-config'] });
  if (options.out) atomicJson(path.resolve(options.out), r);
  if (options.record) return recordPrinciples(r, { limit: Number(options.record) }).then(rec => ({ ...r, lab: rec }));
  return r;
}
export const principlesHelp = {
  'corpus principles --match <component key> [--context dim=value] [--backfill] [--out f.json]': 'WP7 test selection: held-out builds that contain the component, split into inside / outside the context (dimensions: family, form, type, pool, mana, ascendancy; `unknown` = the dimension is not known for that build; --backfill computes the missing BuildCard.foundation of held-out cards first, one cached PoB run each, so the mana dimension and with it the control side are known). Presence from the ablation plan only, no tier until analyze ablate runs - predict in the lab ledger first',
  'corpus principles [--min-in 3] [--min-share 0.6] [--min-lift 0.4] [--top 30] [--keep-tautologies] [--no-config] [--record N] [--out f.json]': 'WP7: conditional principle candidates from corpus ablations x BuildCard contexts (skill family, hit/DoT, damage type, defense pool, mana source, ascendancy): component carries builds in a context and rarely outside it (or the reverse), with supporting builds and counterexamples; config tautologies (flag tied by definition to the context: Shocked x Lightning, Withered x Chaos, an ascendancy whose nodes read the condition) move to filtered with kind and reason, --keep-tautologies keeps them ranked and flagged, --no-config filters every config flag; --record N writes the top N as lab hypotheses (verification hypothesis)'
};
