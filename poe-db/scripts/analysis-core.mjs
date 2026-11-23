// Shared analysis primitives: metrics, one calculation contract per batch, deterministic cache keys.
// No engine calls here; the runner is injected so logic stays testable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dbRoot, readJson, atomicJson } from './workspace.mjs';

export const maxHitStats = ['PhysicalMaximumHitTaken', 'FireMaximumHitTaken', 'ColdMaximumHitTaken', 'LightningMaximumHitTaken', 'ChaosMaximumHitTaken'];
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;

export const metrics = {
  dps: { label: 'CombinedDPS of the selected main skill', read: o => num(o.CombinedDPS) },
  fulldps: { label: 'FullDPS (only skills included in FullDPS)', read: o => num(o.FullDPS) },
  ehp: { label: 'TotalEHP under the configured enemy', read: o => num(o.TotalEHP) },
  maxhit: { label: 'Smallest typed maximum hit taken', read: o => { const v = maxHitStats.map(k => num(o[k])).filter(v => v != null); return v.length === maxHitStats.length ? Math.min(...v) : null; } },
  life: { label: 'Maximum life', read: o => num(o.Life) },
  es: { label: 'Maximum energy shield', read: o => num(o.EnergyShield) },
  mana_sustain: { label: 'Mana recovery minus mana spent per second (positive = sustained)', read: o => {
    const regen = num(o.ManaRegenRecovery) ?? num(o.ManaRegen), leech = num(o.ManaLeechGainRate) ?? 0, cost = num(o.ManaPerSecondCost);
    return regen == null || cost == null ? null : regen + leech - cost; } }
};

export function readMetric(result, metric, scope = 'player') {
  const definition = metrics[metric];
  if (!definition) throw new Error(`Unknown metric: ${metric}; use ${Object.keys(metrics).join('/')}`);
  const output = scope === 'minion' ? result.minion_output : result.output;
  if (!output) return null;
  return definition.read(output);
}

export function delta(before, after) {
  if (before == null || after == null) return { before, after, abs: null, pct: null };
  // Percent change is defined only for a positive baseline; signed metrics (mana_sustain) use the absolute delta.
  return { before, after, abs: after - before, pct: before > 0 ? (after / before - 1) * 100 : null };
}

// Stable JSON for hashing: object keys sorted recursively, arrays kept in order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = text => createHash('sha256').update(text).digest('hex');

export function contractOf(result) {
  return { input_sha256: result.input_sha256 ?? null, calculation_contract_sha256: result.calculation_contract_sha256 ?? null,
    engine_commit: result.engine?.commit ?? null, scenario: result.scenario ?? null };
}
export function assertOneContract(baseline, results) {
  const want = contractOf(baseline);
  if (!want.calculation_contract_sha256) throw new Error('Baseline has no calculation contract; recompute it');
  for (const r of results) {
    const got = contractOf(r);
    for (const key of Object.keys(want)) if (got[key] !== want[key]) throw new Error(`Result ${r.calculation_id ?? '?'} differs in ${key}; one batch requires one baseline and calculation contract`);
  }
  return want;
}

export function analysisKey({ contract, kind, change }) {
  if (!contract?.calculation_contract_sha256 || !contract?.input_sha256) throw new Error('Analysis key requires baseline input and calculation contract');
  return sha256(canonicalJson({ v: 2, kind, contract, change }));
}

export class AnalysisCache {
  constructor(directory = path.join(dbRoot, 'cache/analysis')) { this.directory = directory; this.hits = 0; this.misses = 0; }
  file(key) { if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid analysis cache key'); return path.join(this.directory, key.slice(0, 2), `${key}.json`); }
  get(key) { const f = this.file(key); if (fs.existsSync(f)) { this.hits++; return readJson(f); } this.misses++; return null; }
  set(key, value) { atomicJson(this.file(key), value); return value; }
  stats() { return { hits: this.hits, misses: this.misses, directory: this.directory }; }
}

// Evaluate a list of candidate changes against one baseline with an injected runner(changes) -> calculation result.
// Every result must share the baseline contract; cached entries are reused only for the same contract and change.
export function evaluateCandidates({ baseline, candidates, runner, metricsWanted = ['dps', 'ehp', 'maxhit'], cache = null, kind = 'candidate', scope = 'player', onProgress = null, extract = null }) {
  const contract = assertOneContract(baseline, []);
  const base = Object.fromEntries(metricsWanted.map(m => [m, readMetric(baseline, m, scope)]));
  const rows = [];
  const started = Date.now();
  for (const [index, candidate] of candidates.entries()) {
    const key = analysisKey({ contract, kind, change: candidate.changes });
    let row = cache?.get(key);
    if (!row) {
      let result, error = null;
      try { result = runner(candidate.changes); assertOneContract(baseline, [result]); }
      catch (e) { error = e.message; }
      row = error ? { error } : {
        calculation_id: result.calculation_id,
        // All metrics are stored so a cached row serves any later --metric.
        values: Object.fromEntries(Object.keys(metrics).map(m => [m, readMetric(result, m, scope)])),
        engine_warnings: result.engine_warnings ?? [], unparsed_item_modifiers: result.unparsed_item_modifiers ?? [],
        skill_disabled_reason: result.skill_disabled_reason ?? null,
        extra: extract ? extract(result) : undefined
      };
      if (!error && cache) cache.set(key, row);
    }
    if (!row.error && metricsWanted.some(m => !(m in row.values))) throw new Error('Cached analysis row lacks a metric; clear cache/analysis');
    rows.push({ id: candidate.id, label: candidate.label, cost: candidate.cost ?? null, meta: candidate.meta,
      ...(row.error ? { error: row.error } : { calculation_id: row.calculation_id, deltas: Object.fromEntries(metricsWanted.map(m => [m, delta(base[m], row.values[m])])),
        engine_warnings: row.engine_warnings, unparsed_item_modifiers: row.unparsed_item_modifiers, skill_disabled_reason: row.skill_disabled_reason, extra: row.extra }) });
    onProgress?.(index + 1, candidates.length);
  }
  return { contract, baseline_values: base, rows, elapsed_ms: Date.now() - started, cache: cache?.stats() ?? null };
}

// Candidates whose analysis row is not cached yet (only these need engine runs).
export function cacheMisses({ baseline, candidates, cache, kind = 'candidate' }) {
  if (!cache) return candidates;
  const contract = contractOf(baseline);
  return candidates.filter(c => !fs.existsSync(cache.file(analysisKey({ contract, kind, change: c.changes }))));
}
