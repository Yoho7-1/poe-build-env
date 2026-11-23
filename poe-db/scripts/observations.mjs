// In-game observations next to predictions (stage 7, calibration loop). Append-only JSONL per build:
// builds/<id>/observations.jsonl (local, git-ignored). `observe compare` matches observations with
// `analyze encounter|report|mapmod-sweep` JSON and lists agreements and contradictions. A calibration aid, not proof.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot, readJson, hashFile, flags, safeId } from './workspace.mjs';
import { loadBuild } from './build-store.mjs';

export const kinds = ['death', 'boss_kill', 'map_clear', 'sustain_issue', 'note'];
export const damageTypes = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'];
export const bossTiers = ['normal', 'pinnacle', 'uber'];
const defaultDir = () => path.join(projectRoot, 'builds');
const fileOf = (id, directory) => path.join(directory, safeId(id), 'observations.jsonl');

// ---------- Validation ----------
const str = (v, name, max = 300) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new Error(`${name} must be a string up to ${max} characters`);
  return v.trim() || null;
};
const numIn = (v, name, min, max, integer = false) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} in ${min}..${max}`);
  return n;
};
const oneOf = (v, name, list) => {
  if (v == null || v === '') return null;
  const hit = list.find(x => x.toLowerCase() === String(v).toLowerCase());
  if (!hit) throw new Error(`${name} must be one of ${list.join('|')}`);
  return hit;
};
const list = (v, name) => {
  if (v == null || v === '') return [];
  const arr = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(arr) || arr.some(x => typeof x !== 'string')) throw new Error(`${name} must be a list of strings`);
  return [...new Set(arr.map(x => x.trim()).filter(Boolean))];
};
const date = v => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d\d:?\d\d)?)?$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('date must be ISO (YYYY-MM-DD or full timestamp)');
  if (Date.parse(v) > Date.now() + 86400000) throw new Error('date is in the future');
  return v;
};

// Accepts nested ({content:{...},outcome:{...},snapshot:{...}}) or flat field names; unknown values stay null.
export function normalizeObservation(input, buildId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Observation must be an object');
  const c = { ...input, ...(input.content ?? {}) }, o = { ...input, ...(input.outcome ?? {}) }, s = { ...input, ...(input.snapshot ?? {}) };
  const known = new Set(['kind', 'date', 'notes', 'content', 'outcome', 'snapshot', 'map_tier', 'map_mods', 'boss', 'boss_tier', 'enemy', 'area', 'killed_by', 'damage_type',
    'time_to_kill_s', 'deaths', 'calculation_id', 'pob_sha256']);
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error(`Unknown observation field ${key}`);
  const nested = { content: ['map_tier', 'map_mods', 'boss', 'boss_tier', 'enemy', 'area'], outcome: ['killed_by', 'damage_type', 'time_to_kill_s', 'deaths'], snapshot: ['calculation_id', 'pob_sha256'] };
  for (const [part, keys] of Object.entries(nested)) {
    if (input[part] == null) continue;
    if (typeof input[part] !== 'object' || Array.isArray(input[part])) throw new Error(`${part} must be an object`);
    for (const key of Object.keys(input[part])) if (!keys.includes(key)) throw new Error(`Unknown observation field ${part}.${key}`);
  }
  const kind = oneOf(input.kind, 'kind', kinds);
  if (!kind) throw new Error(`kind is required: ${kinds.join('|')}`);
  const pob = str(s.pob_sha256, 'pob_sha256', 64);
  if (pob != null && !/^[a-f0-9]{64}$/.test(pob)) throw new Error('pob_sha256 must be 64 lowercase hex characters');
  const value = {
    schema_version: 1, id: randomUUID(), build_id: safeId(buildId), kind, date: date(input.date), recorded_at: new Date().toISOString(),
    content: { map_tier: numIn(c.map_tier, 'map_tier', 1, 17, true), map_mods: list(c.map_mods, 'map_mods'), boss: str(c.boss, 'boss', 100),
      boss_tier: oneOf(c.boss_tier, 'boss_tier', bossTiers), enemy: str(c.enemy, 'enemy', 100), area: str(c.area, 'area', 100) },
    outcome: { killed_by: str(o.killed_by, 'killed_by', 100), damage_type: oneOf(o.damage_type, 'damage_type', damageTypes),
      time_to_kill_s: numIn(o.time_to_kill_s, 'time_to_kill_s', 0, 86400), deaths: numIn(o.deaths, 'deaths', 0, 1000, true) },
    snapshot: { calculation_id: str(s.calculation_id, 'calculation_id', 128), pob_sha256: pob },
    notes: str(input.notes, 'notes', 2000)
  };
  if (kind === 'death' && value.outcome.deaths == null) value.outcome.deaths = 1;
  if (kind === 'boss_kill' && !value.content.boss && !value.content.enemy) throw new Error('boss_kill needs --boss or --enemy');
  if (kind === 'note' && !value.notes) throw new Error('note needs --notes');
  return value;
}

// ---------- Store ----------
export function addObservation(buildId, input, directory = defaultDir()) {
  loadBuild(buildId, directory); // the build must exist and be valid
  const value = normalizeObservation(input, buildId);
  fs.appendFileSync(fileOf(buildId, directory), JSON.stringify(value) + '\n', { flag: 'a' });
  return value;
}
export function listObservations(buildId, directory = defaultDir(), { kind = null } = {}) {
  loadBuild(buildId, directory);
  const file = fileOf(buildId, directory);
  if (!fs.existsSync(file)) return [];
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`observations.jsonl line ${i + 1} is not valid JSON`); }
  });
  return kind ? rows.filter(r => r.kind === kind) : rows;
}

// ---------- Predictions from analyze output ----------
const lc = v => String(v ?? '').toLowerCase().trim();
function rowPrediction(source, row, extra = {}) {
  const e = row.enemy ?? {};
  return { source, label: row.label ?? null, enemy_kind: e.kind ?? null, boss: e.boss ?? null, skill: e.skill ?? null, archetype: e.archetype ?? null,
    tier: row.map?.tier ?? extra.tier ?? null, mods: (row.modifiers ?? []).filter(m => !m.status || m.status === 'applied').map(m => ({ id: m.id ?? null, name: m.name ?? null })),
    verdict: row.defence?.verdict ?? null, hits_to_die: row.defence?.hits_to_die ?? null, dominant_type: row.defence?.dominant_type ?? null,
    time_to_kill_s: row.damage?.time_to_kill_s ?? null, calculation_id: row.calculation_id ?? null, ...extra };
}
function sweepPredictions(sweep) {
  return (sweep.mods ?? []).map(m => ({ source: 'mapmod_sweep', label: `${m.name ?? m.id} (T${sweep.tier} vs ${m.compared_against ?? sweep.enemy})`, enemy_kind: 'map_mod', mod_id: m.id, mod_name: m.name,
    tier: sweep.tier ?? null, band: sweep.band ?? null, verdict: m.verdict, verdict_hit: m.verdict_hit ?? null, reasons: m.reasons ?? [] }));
}
export function predictionsOf(report) {
  if (!report || typeof report !== 'object') throw new Error('Analysis report must be a JSON object');
  if (report.analysis === 'encounter') return [rowPrediction('encounter', report)];
  if (report.analysis === 'map_mod_sweep') return sweepPredictions(report);
  if (report.analysis === 'survival_damage_report') return [...(report.matrix ?? []).map(r => rowPrediction('report_matrix', r)), ...(report.sweeps ?? []).flatMap(sweepPredictions)];
  throw new Error('Unsupported analysis JSON: expected analyze encounter, mapmod-sweep or report output (field analysis)');
}

// ---------- Matching ----------
const nameMatch = (a, b) => { const x = lc(a).replace(/^the /, ''), y = lc(b).replace(/^the /, ''); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
const survives = new Set(['survives_hit', 'sustains_degen', 'degen_survivable']);
const lethal = new Set(['one_shot', 'dangerous', 'degen_dangerous']);
function bossOf(obs) {
  if (obs.content.boss) return { boss: obs.content.boss, skill: obs.outcome.killed_by };
  const m = obs.content.enemy?.match(/^boss:([^:]+)(?::(.+))?$/i);
  return m ? { boss: m[1], skill: m[2] ?? obs.outcome.killed_by } : null;
}
function matches(obs, p) {
  const b = bossOf(obs);
  if (p.enemy_kind === 'boss') {
    if (!b || !(nameMatch(b.boss, p.boss) || nameMatch(b.boss, p.label?.split(' / ')[0]))) return null;
    if (b.skill && p.skill) return nameMatch(b.skill, p.skill) ? 'boss_skill' : null;
    return 'boss';
  }
  if (p.enemy_kind === 'map_mod') {
    if (obs.content.map_tier != null && p.tier != null && obs.content.map_tier !== p.tier) return null;
    return obs.content.map_mods.some(m => lc(m) === lc(p.mod_id) || nameMatch(m, p.mod_name)) ? 'map_mod' : null;
  }
  if (p.enemy_kind === 'archetype') {
    const want = obs.content.enemy && !/^boss:/i.test(obs.content.enemy) ? lc(obs.content.enemy).replace(/[- ]/g, '_') : null;
    if (b && !want) return ['map_boss', 'pinnacle', 'uber'].includes(p.archetype) && nameMatch(b.boss, p.archetype) ? 'archetype' : null;
    if (want && want !== p.archetype) return null;
    if (!want && obs.content.map_tier == null) return null;
    if (obs.content.map_tier != null && p.tier != null && obs.content.map_tier !== p.tier) return null;
    if (p.mods.length && !p.mods.every(m => obs.content.map_mods.some(o => lc(o) === lc(m.id) || nameMatch(o, m.name)))) return null;
    return 'archetype';
  }
  return null;
}
function assess(obs, p, level) {
  const out = [], died = obs.kind === 'death' || obs.outcome.deaths > 0;
  const push = (check, status, predicted, observed, note, strength = 'strong') => out.push({ observation_id: obs.id, kind: obs.kind, prediction: p.label, source: p.source, match: level, check, status, strength, predicted, observed, note });
  if (p.enemy_kind === 'map_mod') {
    if (died) push('map_mod_danger', p.verdict === 'ok' ? 'contradiction' : ['avoid', 'caution'].includes(p.verdict) ? 'agreement' : 'inconclusive', p.verdict, 'death on a map with this mod',
      'Death on a multi-mod map does not prove that this one mod caused it.', 'weak');
    else if (obs.kind === 'map_clear') push('map_mod_danger', p.verdict === 'avoid' ? 'contradiction' : 'agreement', p.verdict, 'map cleared without recorded death',
      'Surviving one map does not prove the mod is safe; avoid is a model threshold.', 'weak');
    return out;
  }
  if (died) {
    const strength = level === 'boss_skill' ? 'strong' : 'weak';
    push('survival', survives.has(p.verdict) ? 'contradiction' : lethal.has(p.verdict) ? 'agreement' : 'inconclusive', p.verdict, `death${obs.outcome.killed_by ? ` to ${obs.outcome.killed_by}` : ''}`,
      survives.has(p.verdict) ? 'Model predicted surviving the configured hit/degen; check stacking hits, ailments, curses, map mods, lower actual gear or a different skill.' : null, strength);
    if (obs.outcome.damage_type && p.dominant_type) push('damage_type', obs.outcome.damage_type === p.dominant_type ? 'agreement' : 'contradiction', p.dominant_type, obs.outcome.damage_type,
      'Dominant damage type of the modelled hit vs damage type seen on the death recap.', strength);
  } else if (['boss_kill', 'map_clear'].includes(obs.kind) && obs.outcome.deaths === 0 && lethal.has(p.verdict))
    push('survival', 'inconclusive', p.verdict, 'no death', 'A predicted one-shot can be avoided by dodging; not a contradiction by itself.', 'weak');
  if (obs.outcome.time_to_kill_s != null && p.time_to_kill_s != null && p.time_to_kill_s > 0) {
    const ratio = Math.round((obs.outcome.time_to_kill_s / p.time_to_kill_s) * 100) / 100;
    push('time_to_kill', ratio >= 0.67 && ratio <= 1.5 ? 'agreement' : 'contradiction', p.time_to_kill_s, obs.outcome.time_to_kill_s,
      `observed/predicted = ${ratio}. Predicted TTK ignores phases, immunity, travel and uptime, so observed is usually longer.`, ratio > 1.5 && ratio <= 3 ? 'weak' : 'strong');
  } else if (obs.outcome.time_to_kill_s != null && p.time_to_kill_s == null && level !== 'archetype')
    push('time_to_kill', 'inconclusive', null, obs.outcome.time_to_kill_s, 'No predicted TTK (boss life is not in local data; rerun analyze with --enemy-life).', 'weak');
  return out;
}

export function compareObservations(observations, report) {
  const predictions = predictionsOf(report);
  const findings = [], unmatched = [], snapshotWarnings = [];
  const calcIds = new Set(predictions.map(p => p.calculation_id).filter(Boolean));
  for (const obs of observations) {
    if (obs.kind === 'note') continue;
    let hits = predictions.map(p => ({ p, level: matches(obs, p) })).filter(x => x.level);
    // A boss observation with a known skill: prefer exact skill rows over the whole boss.
    if (hits.some(h => h.level === 'boss_skill')) hits = hits.filter(h => h.level === 'boss_skill');
    if (!hits.length) { unmatched.push({ observation_id: obs.id, kind: obs.kind, content: obs.content, killed_by: obs.outcome.killed_by }); continue; }
    if (obs.snapshot?.calculation_id && calcIds.size && !calcIds.has(obs.snapshot.calculation_id))
      snapshotWarnings.push({ observation_id: obs.id, warning: 'different_character_snapshot', observed_calculation_id: obs.snapshot.calculation_id });
    for (const { p, level } of hits) findings.push(...assess(obs, p, level));
  }
  const by = s => findings.filter(f => f.status === s);
  return { report: { analysis: report.analysis, build_file: report.build_file ?? null, scenario: report.scenario ?? null }, predictions: predictions.length, observations: observations.length,
    counts: { agreement: by('agreement').length, contradiction: by('contradiction').length, inconclusive: by('inconclusive').length, unmatched: unmatched.length },
    contradictions: by('contradiction'), agreements: by('agreement'), inconclusive: by('inconclusive'), unmatched_observations: unmatched, snapshot_warnings: snapshotWarnings,
    report_without_calculation_ids: !calcIds.size,
    disclaimer: 'Calibration aid, not proof: one game event is one sample; the model has explicit thresholds and unmodelled effects. Check snapshot_warnings when the character changed between the calculation and the game.' };
}

// ---------- CLI ----------
const flagFields = { kind: 'kind', date: 'date', notes: 'notes', 'map-tier': 'map_tier', mods: 'map_mods', boss: 'boss', 'boss-tier': 'boss_tier', enemy: 'enemy', area: 'area',
  'killed-by': 'killed_by', 'damage-type': 'damage_type', ttk: 'time_to_kill_s', deaths: 'deaths', 'calculation-id': 'calculation_id', 'pob-sha256': 'pob_sha256' };
export function observeCommand(rest, { directory = defaultDir() } = {}) {
  const [operation, ...args] = rest;
  const { positional, options } = flags(args, ['file', 'report', 'pob-file', ...Object.keys(flagFields)], []);
  const id = positional[0];
  if (!id) throw new Error('Build id required: observe add|list|compare <build-id>');
  if (operation === 'add') {
    const input = options.file ? readJson(path.resolve(options.file)) : {};
    for (const [flag, field] of Object.entries(flagFields)) if (options[flag] != null) input[field] = options[flag];
    if (options['pob-file']) input.pob_sha256 = hashFile(path.resolve(options['pob-file']));
    return { added: addObservation(id, input, directory), file: path.relative(projectRoot, fileOf(id, directory)).replaceAll('\\', '/') };
  }
  if (operation === 'list') { const rows = listObservations(id, directory, { kind: options.kind ? oneOf(options.kind, 'kind', kinds) : null }); return { build_id: id, count: rows.length, observations: rows }; }
  if (operation === 'compare') {
    if (!options.report) throw new Error('--report <analysis.json> required (analyze encounter|report|mapmod-sweep output)');
    return { build_id: id, ...compareObservations(listObservations(id, directory), readJson(path.resolve(options.report))) };
  }
  throw new Error('Use observe add <build-id> --file obs.json | flags; observe list <build-id> [--kind K]; observe compare <build-id> --report analysis.json');
}
export const observeHelp = {
  'observe add <build-id> [--file obs.json] [--kind death|boss_kill|map_clear|sustain_issue|note] [--map-tier N] [--mods a,b] [--boss X] [--boss-tier pinnacle|uber] [--enemy spec] [--killed-by skill] [--damage-type T] [--ttk s] [--deaths N] [--calculation-id id] [--pob-sha256 h|--pob-file f] [--date YYYY-MM-DD] [--notes text]':
    'Append an in-game fact to builds/<id>/observations.jsonl (local); unknown fields stay null',
  'observe list <build-id> [--kind K]': 'Stored observations, oldest first',
  'observe compare <build-id> --report analysis.json': 'Match observations with analyze encounter|report|mapmod-sweep predictions: agreements, contradictions, unmatched; calibration aid, not proof'
};
