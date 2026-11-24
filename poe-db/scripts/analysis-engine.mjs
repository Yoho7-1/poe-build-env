// Engine batch runner for analysis: many `pob run` calculations against one baseline in parallel processes.
// Each calculation is an ordinary `agent.mjs pob run` (own job directory, engine cache, calculation contract),
// so this module does not change the engine; it only schedules runs. agent() stays synchronous: the pool runs
// in a child Node process and the parent waits for it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dbRoot, readJson, atomicJson } from './workspace.mjs';
import { canonicalJson, sha256 } from './analysis-core.mjs';

const agentScript = path.join(dbRoot, 'scripts/agent.mjs');
const selfScript = fileURLToPath(import.meta.url);
export const defaultConcurrency = Math.max(1, Math.min(8, os.cpus().length - 2));

// Parent side: run every `changes` object against `file`; returns Map(canonical changes -> result | {error}).
export function runBatch({ file, scenario = 'sustained', changesList, concurrency = defaultConcurrency, timeoutPerRun = 240000, full = false }) {
  const unique = new Map();
  for (const changes of changesList) unique.set(canonicalJson(changes), changes);
  const dir = path.join(os.tmpdir(), `poe-analysis-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const jobs = [...unique].map(([key, changes]) => {
      const id = sha256(key).slice(0, 24);
      atomicJson(path.join(dir, `${id}.changes.json`), changes);
      return { id, key };
    });
    atomicJson(path.join(dir, 'batch.json'), { file: path.resolve(file), scenario, concurrency, timeoutPerRun, full, jobs: jobs.map(j => j.id) });
    const started = Date.now();
    const child = spawnSync(process.execPath, [selfScript, path.join(dir, 'batch.json')], { encoding: 'utf8', windowsHide: true, timeout: timeoutPerRun * Math.ceil(jobs.length / concurrency + 1), maxBuffer: 16 * 1024 * 1024 });
    if (child.error || child.status !== 0) throw new Error(`Analysis batch failed: ${child.error?.message ?? ''} ${child.stderr ?? ''}`.slice(0, 4000));
    const results = new Map();
    for (const job of jobs) {
      const out = path.join(dir, `${job.id}.out.json`), err = path.join(dir, `${job.id}.err.txt`);
      if (fs.existsSync(out)) results.set(job.key, readJson(out));
      else results.set(job.key, { error: fs.existsSync(err) ? parseError(fs.readFileSync(err, 'utf8')) : 'no result' });
    }
    return { results, elapsed_ms: Date.now() - started, runs: jobs.length, concurrency };
  } finally {
    if (path.basename(dir).startsWith('poe-analysis-')) fs.rmSync(dir, { recursive: true, force: true });
  }
}
const parseError = text => { try { return JSON.parse(text.trim().split('\n').pop()).error; } catch { return text.trim().slice(0, 2000) || 'unknown error'; } };

// Output keys returned per PoB comparison variant: everything the analysis metrics and side-effect checks read.
export const variantKeys = ['FullDPS', 'CombinedDPS', 'TotalDPS', 'TotalDot', 'TotalDotDPS', 'AverageDamage', 'Speed', 'TotalIgniteDPS', 'IgniteDPS', 'TotalPoisonDPS', 'PoisonDPS', 'BleedDPS', 'DecayDPS',
  'Life', 'EnergyShield', 'Mana', 'Ward', 'TotalEHP', 'PhysicalMaximumHitTaken', 'FireMaximumHitTaken', 'ColdMaximumHitTaken', 'LightningMaximumHitTaken', 'ChaosMaximumHitTaken',
  'ManaRegenRecovery', 'ManaRegen', 'ManaLeechGainRate', 'ManaPerSecondCost', 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist', 'EffectiveMovementSpeedMod',
  'Str', 'Dex', 'Int', 'ReqStr', 'ReqDex', 'ReqInt'];

// PoB comparison variants (calculator removeNodes/addNodes) computed in a few processes instead of one process per
// variant: the variants are split into `concurrency` chunks, each chunk is one ordinary `pob run`. Optional
// node_power lets PoB enumerate unallocated nodes by its own pathDist (shards across the chunks).
// Returns Map(variant id -> result shaped like a pob run result: contract fields of the chunk + variant output).
export function runVariants({ file, scenario = 'sustained', base = {}, variants = [], nodePower = null, concurrency = defaultConcurrency }) {
  const chunks = Math.max(1, Math.min(concurrency, nodePower ? concurrency : Math.ceil(variants.length / 8)));
  const changesList = Array.from({ length: chunks }, (_, i) => {
    const part = variants.filter((_, k) => k % chunks === i);
    const c = { ...base, variant_keys: variantKeys };
    if (part.length) c.variants = part;
    if (nodePower) c.node_power = { ...nodePower, shard: { index: i, count: chunks } };
    return c;
  }).filter(c => c.variants || c.node_power);
  const batch = runBatch({ file, scenario, changesList, concurrency });
  const out = new Map();
  for (const changes of changesList) {
    const r = batch.results.get(canonicalJson(changes));
    if (!r || r.error) throw new Error(`Variant batch failed: ${r?.error ?? 'no result'}`);
    for (const [id, v] of Object.entries(r.variants ?? {})) {
      out.set(id, v.skipped ? { skipped: v.skipped, removed_nodes: v.removed_nodes } : {
        input_sha256: r.input_sha256, calculation_contract_sha256: r.calculation_contract_sha256, engine: r.engine, scenario: r.scenario,
        calculation_id: `${r.calculation_id}#${id}`, output: v.output ?? {}, minion_output: v.minion_output, removed_nodes: v.removed_nodes ? { method: 'pob_misc_calculator_removeNodes', nodes: v.removed_nodes } : undefined,
        added_nodes: v.added_nodes, points: v.points, engine_warnings: r.engine_warnings ?? [], unparsed_item_modifiers: r.unparsed_item_modifiers ?? [], skill_disabled_reason: r.skill_disabled_reason ?? null, variant: true });
    }
  }
  return { results: out, runs: batch.runs, elapsed_ms: batch.elapsed_ms, variants: out.size };
}
// Runner for evaluateCandidates over variants: candidate.changes = { variant: <id> }.
export const variantRunner = vr => changes => {
  const r = vr.results.get(changes.variant);
  if (!r) throw new Error(`Variant ${changes.variant} was not computed`);
  if (r.skipped) throw new Error(`Variant ${changes.variant} skipped: ${r.skipped}`);
  return r;
};

// Runner adapter for evaluateCandidates: returns the precomputed result or throws its error.
export function batchRunner(batch) {
  return changes => {
    const r = batch.results.get(canonicalJson(changes));
    if (!r) throw new Error('Candidate was not part of the batch');
    if (r.error) throw new Error(r.error);
    return r;
  };
}

// Child side: async pool of `node agent.mjs pob run`.
async function childMain(batchFile) {
  const dir = path.dirname(batchFile);
  const batch = readJson(batchFile);
  const queue = [...batch.jobs];
  const runOne = id => new Promise(resolve => {
    const proc = spawn(process.execPath, [agentScript, 'pob', 'run', batch.file, '--scenario', batch.scenario, '--changes', path.join(dir, `${id}.changes.json`), '--out', path.join(dir, `${id}.out.json`), ...(batch.full ? ['--full'] : [])],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => proc.kill(), batch.timeoutPerRun);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(path.join(dir, `${id}.out.json`))) fs.writeFileSync(path.join(dir, `${id}.err.txt`), stderr || `exit ${code}`);
      resolve();
    });
  });
  const worker = async () => { while (queue.length) await runOne(queue.shift()); };
  await Promise.all(Array.from({ length: Math.min(batch.concurrency, queue.length) }, worker));
}

if (process.argv[1] && path.resolve(process.argv[1]) === selfScript) {
  childMain(process.argv[2]).catch(error => { process.stderr.write(String(error?.stack ?? error)); process.exitCode = 1; });
}
