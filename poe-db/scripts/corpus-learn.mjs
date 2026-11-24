// Learning from the corpus by local code (3A.2-3A.4): ablate every corpus build with PoB, then count how often each
// kind of component is core / major / minor / negligible. The result is (1) an empirical tier model used as a
// benchmark baseline and (2) "build basics" statistics: which supports, uniques, node types and assumptions tend to
// carry builds. Counts are evidence for hypotheses, not principles: popularity and frequency do not prove causality,
// and the corpus is small and partly migrated from 3.29.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicJson, flags } from './workspace.mjs';
import { analyzeAblation } from './analysis-ablation.mjs';
import { corpusDirectory } from './corpus.mjs';
import { cardDirectory } from './build-card.mjs';

export const ablationDirectory = () => path.join(corpusDirectory(), 'ablation');
const tiers = ['core', 'major', 'minor', 'negligible', 'removal_improves'];
const finite = v => typeof v === 'number' && Number.isFinite(v);

// Feature keys of one component, most specific first; shared by training rows and benchmark components.
export function componentKeys(c) {
  const t = c.target ?? {};
  const name = String(c.label ?? '').replace(/ \((?:[^()]*)\)$/, '');
  if (c.kind === 'supports') return [`support:${c.label}`, 'supports'];
  if (c.kind === 'skills') {
    const gems = String(c.label ?? '').replace(/^[^:]*: /, '').replace(/ \[[^\]]*\]$/, '').split(' + ').map(s => s.trim()).filter(Boolean);
    return [`skill:${gems.join('+')}`, ...(gems[0] ? [`skill_first:${gems[0]}`] : []), 'skills'];
  }
  if (c.kind === 'items') {
    const slot = String(t.slot ?? '').replace(/ \d+$/, '').replace(/^Jewel \d+$/, 'Jewel');
    const rarity = String(t.rarity ?? '').toUpperCase();
    return [...(rarity === 'UNIQUE' ? [`unique:${name}`] : []), `item:${slot}:${rarity}`, `item:${slot}`, 'items'];
  }
  if (c.kind === 'tree') return [`node:${name}`, `tree:${t.ascendancy ? 'ascendancy_' : ''}${t.type ?? 'node'}`, 'tree'];
  if (c.kind === 'config') return [`config:${t.key}`, 'config'];
  return [c.kind ?? 'unknown'];
}

// rows: [{build, kind, label, target, tier, offense_loss_pct, defense_loss_pct}]
export function trainTierModel(rows, { minSupport = 3 } = {}) {
  const stats = new Map();
  for (const r of rows) {
    if (!tiers.includes(r.tier)) continue;
    for (const k of componentKeys(r)) {
      const s = stats.get(k) ?? { n: 0, builds: new Set(), tiers: {}, offense: [], defense: [] };
      s.n++; s.builds.add(r.build); s.tiers[r.tier] = (s.tiers[r.tier] ?? 0) + 1;
      if (finite(r.offense_loss_pct)) s.offense.push(r.offense_loss_pct);
      if (finite(r.defense_loss_pct)) s.defense.push(r.defense_loss_pct);
      stats.set(k, s);
    }
  }
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)] * 100) / 100; };
  const keys = Object.fromEntries([...stats].map(([k, s]) => [k, { n: s.n, builds: s.builds.size, tiers: s.tiers, mode: Object.entries(s.tiers).sort((a, b) => b[1] - a[1] || tiers.indexOf(a[0]) - tiers.indexOf(b[0]))[0][0],
    median_dps_loss_pct: median(s.offense), median_defense_loss_pct: median(s.defense) }]));
  return { kind: 'tier_model', min_support: minSupport, rows: rows.length, builds: new Set(rows.map(r => r.build)).size, keys };
}
// Most specific key with enough support (and seen in >= 2 builds for specific keys) decides; backoff to the kind.
export function predictTier(model, c) {
  const keys = componentKeys(c);
  for (const [i, k] of keys.entries()) {
    const s = model.keys[k];
    if (!s) continue;
    const last = i === keys.length - 1;
    if (last || (s.n >= model.min_support && s.builds >= 2)) return { tier: s.mode, key: k, n: s.n };
  }
  return { tier: 'minor', key: null, n: 0 };
}

// Quality filter for training (default on; --all disables): drop low-level builds (< 80: leveling/drafts), builds without
// an ascendancy (mercenary or unfinished trees) and structural duplicates (same signature: the highest level, then a
// build not migrated by this project, then an author 3.30 build, then the file name is kept). Cards are matched to XML/ablation files by identity.file.
export function readCards(directory = cardDirectory()) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(f => f.endsWith('.json')).sort().map(f => ({ ...readJson(path.join(directory, f)), _card: f }));
}
const stem = f => String(f ?? '').replace(/\.(xml|json)$/i, '');
const cardStem = c => stem(c.identity?.file ?? c._card);
export function qualityFilter(cards, { minLevel = 80 } = {}) {
  const excluded = [], passing = [];
  const row = (c, reasons) => ({ file: cardStem(c), card: c._card ?? null, level: c.identity?.level ?? null, ascendancy: c.features?.ascendancy ?? null, main_skill: c.features?.main_skill ?? null, reasons });
  for (const c of cards) {
    const level = c.identity?.level ?? null, ascendancy = c.features?.ascendancy ?? c.identity?.ascendancy ?? null, reasons = [];
    if (!(typeof level === 'number' && level >= minLevel)) reasons.push(`level ${level ?? 'unknown'} < ${minLevel}`);
    if (!ascendancy || ascendancy === 'None') reasons.push('no ascendancy');
    if (reasons.length) excluded.push(row(c, reasons)); else passing.push(c);
  }
  const native = c => (c.identity?.origin?.migration ? 0 : 2) + ((c.identity?.origin?.origin_patch ?? c.identity?.patch) === '3.30' ? 1 : 0);
  const rank = (a, b) => (b.identity.level - a.identity.level) || (native(b) - native(a)) || cardStem(a).localeCompare(cardStem(b));
  const bySig = new Map();
  for (const c of passing) { const k = c.signature ?? cardStem(c); if (!bySig.has(k)) bySig.set(k, []); bySig.get(k).push(c); }
  const kept = [];
  for (const group of bySig.values()) {
    const [best, ...rest] = group.sort(rank);
    kept.push(best);
    for (const c of rest) excluded.push(row(c, [`duplicate signature of ${cardStem(best)}`]));
  }
  return { min_level: minLevel, cards: cards.length, kept: kept.length, keep: new Set(kept.map(cardStem)), excluded: excluded.sort((a, b) => a.file.localeCompare(b.file)) };
}
export const filterReport = q => ({ min_level: q.min_level, cards: q.cards, kept: q.kept, excluded: q.excluded.length, excluded_builds: q.excluded });

// keep: Set of corpus file stems (XML name without extension) to train on; null = every stored ablation.
export function loadAblationRows({ directory = ablationDirectory(), excludeSha = null, keep = null } = {}) {
  if (!fs.existsSync(directory)) return [];
  const rows = [];
  for (const f of fs.readdirSync(directory).filter(f => f.endsWith('.json')).sort()) {
    if (keep && !keep.has(stem(f))) continue;
    const r = readJson(path.join(directory, f));
    const sha = r.contract?.input_sha256 ?? null;
    if (excludeSha && sha === excludeSha) continue;
    for (const x of r.rows ?? []) if (!x.error) rows.push({ build: sha ?? f, kind: x.kind, label: x.label, target: x.target, tier: x.tier, offense_loss_pct: x.offense_loss_pct, defense_loss_pct: x.defense_loss_pct });
  }
  return rows;
}

// Default training rows: stored ablations of the builds that pass the quality filter.
export function qualityAblationRows({ cards = cardDirectory(), minLevel = 80, ...options } = {}) { return loadAblationRows({ ...options, keep: qualityFilter(readCards(cards), { minLevel }).keep }); }

// Ablate every corpus XML that has no stored ablation yet (resumable; PoB does the work). Without all=true only builds
// whose card passes the quality filter are ablated (an XML without a card is skipped: nothing to judge it by).
export function ablateCorpus({ limit = null, concurrency, scenario = 'sustained', all = false, minLevel = 80, cards = cardDirectory(), directory = corpusDirectory(), analyze = analyzeAblation } = {}) {
  const xmlDir = path.join(directory, 'xml');
  const out = path.join(directory, 'ablation');
  const cardList = all ? [] : readCards(cards);
  const quality = all ? null : qualityFilter(cardList, { minLevel });
  const withCard = new Set(cardList.map(cardStem)), withoutCard = [];
  fs.mkdirSync(out, { recursive: true });
  const files = fs.existsSync(xmlDir) ? fs.readdirSync(xmlDir).filter(f => f.endsWith('.xml')).sort() : [];
  const done = [], failed = [], skipped = [];
  for (const f of files) {
    const target = path.join(out, f.replace(/\.xml$/, '.json'));
    if (quality && !quality.keep.has(stem(f))) { if (!withCard.has(stem(f))) withoutCard.push({ file: stem(f), reasons: ['no card'] }); continue; }
    if (fs.existsSync(target)) { skipped.push(f); continue; }
    if (limit != null && done.length >= limit) break;
    try {
      const r = analyze({ file: path.join(xmlDir, f), scenario, ...(concurrency ? { concurrency } : {}) });
      atomicJson(target, { ...r, rows: r.rows.map(({ deltas, ...x }) => x) });
      done.push({ file: f, components: r.rows.length, core: r.summary.core.length });
    } catch (e) { failed.push({ file: f, error: e.message.slice(0, 300) }); }
  }
  const report = quality ? filterReport({ ...quality, excluded: [...quality.excluded, ...withoutCard] }) : 'off (--all)';
  return { ablated: done.length, already: skipped.length, failed, done, quality_filter: report };
}

// "Build basics": statistics a model or person can read without rerunning anything.
export function corpusInsights(model, { minBuilds = 2, top = 15 } = {}) {
  const entries = Object.entries(model.keys);
  const share = (s, t) => (s.tiers[t] ?? 0) / s.n;
  const pick = (prefix, sort, filter = () => true) => entries.filter(([k, s]) => k.startsWith(prefix) && s.builds >= minBuilds && filter(s, k)).sort(sort).slice(0, top)
    .map(([k, s]) => ({ key: k, n: s.n, builds: s.builds, core_or_major: Math.round((share(s, 'core') + share(s, 'major')) * 100) / 100, tiers: s.tiers, median_dps_loss_pct: s.median_dps_loss_pct, median_defense_loss_pct: s.median_defense_loss_pct }));
  const carries = s => share(s, 'core') + share(s, 'major') >= 0.5;
  const replaceable = s => share(s, 'negligible') + share(s, 'removal_improves') >= 1 / 3;
  const strength = ([, a], [, b]) => (share(b, 'core') + share(b, 'major')) - (share(a, 'core') + share(a, 'major')) || b.n - a.n;
  const weakness = ([, a], [, b]) => (share(b, 'negligible') + share(b, 'removal_improves')) - (share(a, 'negligible') + share(a, 'removal_improves')) || b.n - a.n;
  const byKind = Object.fromEntries(['supports', 'skills', 'items', 'tree', 'config'].filter(k => model.keys[k]).map(k => [k, { n: model.keys[k].n, tiers: model.keys[k].tiers }]));
  return { builds: model.builds, components: model.rows, by_kind: byKind,
    supports_that_carry: pick('support:', strength, carries), supports_often_replaceable: pick('support:', weakness, replaceable),
    uniques_that_carry: pick('unique:', strength, carries), node_types: pick('tree:', strength),
    item_slots: pick('item:', strength, (s, k) => k.split(':').length === 2),
    skills_that_carry: pick('skill_first:', strength, carries), skills_often_replaceable: pick('skill_first:', weakness, replaceable),
    assumptions_that_matter: pick('config:', strength, carries), assumptions_rarely_matter: pick('config:', weakness, replaceable),
    caveat: 'Frequencies over a small, partly migrated (3.29 -> 3.30) corpus; PoB numbers only. A frequent core component is a hypothesis about why builds work, to be tested by ablation/transfer, not a rule.' };
}

export function learnCommand(args) {
  const { positional, options } = flags(args, ['limit', 'concurrency', 'min-builds', 'top', 'out', 'min-level'], ['all']);
  const minLevel = Number(options['min-level'] ?? 80);
  const [op] = positional;
  if (op === 'ablate-all') return ablateCorpus({ limit: options.limit ? Number(options.limit) : null, concurrency: options.concurrency ? Number(options.concurrency) : undefined, all: !!options.all, minLevel });
  if (op === 'learn' || op === 'insights') {
    const quality = options.all ? null : qualityFilter(readCards(), { minLevel });
    const model = { ...trainTierModel(loadAblationRows({ keep: quality?.keep ?? null })), quality_filter: quality ? { min_level: minLevel, kept: quality.kept, excluded: quality.excluded.length } : 'off (--all)' };
    const file = path.join(corpusDirectory(), 'tier-model.json');
    atomicJson(file, model);
    const result = { ...(op === 'learn' ? { model_file: file, builds: model.builds, components: model.rows, keys: Object.keys(model.keys).length }
      : corpusInsights(model, { minBuilds: Number(options['min-builds'] ?? 2), top: Number(options.top ?? 15) })), quality_filter: quality ? filterReport(quality) : 'off (--all)' };
    if (options.out) atomicJson(path.resolve(options.out), result);
    return result;
  }
  throw new Error('Use corpus ablate-all [--limit N] [--all] | corpus learn [--all] | corpus insights [--min-builds 2] [--top 15] [--all] [--min-level 80]');
}
export const learnHelp = {
  'corpus ablate-all [--limit N] | corpus learn | corpus insights [--min-builds 2] [--top 15] [--out f.json] [--min-level 80] [--all]':
    'Ablate every corpus build with PoB (resumable), train the empirical tier model (research/lab/corpus/tier-model.json), read build-basics statistics: supports/uniques/node types/assumptions that carry builds or are replaceable. Quality filter by default (level >= 80, an ascendancy, one card per signature; excluded builds listed with reasons); --all disables it'
};
