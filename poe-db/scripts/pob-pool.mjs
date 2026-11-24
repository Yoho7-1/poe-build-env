// Pool of persistent PoB hosts (pob-host-server.ps1 + pob-worker.lua in persistent mode), shared by every Node
// process and worker thread on this computer. A host loads PoB and its data once (~6-7 s) and then calculates one
// request at a time (~0.1-1 s), returning to PoB's start-up state between requests (AGENT_RESET in pob-worker.lua).
// runPob stays synchronous: the client talks to a host through files in the host directory and waits with
// Atomics.wait. Hosts live in the pinned PoB source directory as `.agent-host-<contract>-<id>` (relative paths keep
// Lua file access ASCII), are keyed by the calculation contract, and exit after POB_HOST_IDLE_S seconds without work.
// Any host-level failure (cannot start, crash, hang, protocol error) kills that host, prints a warning and the
// calculation falls back to the single-shot path (one PoB process per calculation). PoB/Lua errors of a request are
// ordinary calculation errors, as in the single-shot path.
// Environment: POB_PERSISTENT=0 disables the pool; POB_HOSTS = maximum hosts (default min(8, CPUs - 2));
// POB_HOST_IDLE_S = idle seconds before a host exits (default 600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { dbRoot } from './workspace.mjs';

const sourceDirectory = path.join(dbRoot, 'vendor/pob/src');
const runtimeDirectory = path.join(dbRoot, 'vendor/pob/runtime');
const serverScript = path.join(dbRoot, 'scripts/pob-host-server.ps1');
const prefix = '.agent-host-';
const HEARTBEAT_STALE_MS = 20000; // the host touches its heartbeat every second, also while calculating
const START_GRACE_MS = 60000;     // a new host may take this long to create its heartbeat
const START_TIMEOUT_MS = 240000;  // PoB data load under heavy load
const LOCK_MAX_MS = 60 * 60000;   // a lock older than this is abandoned whatever its owner

export const persistentEnabled = () => process.env.POB_PERSISTENT !== '0';
export const maxHosts = () => {
  const n = Number(process.env.POB_HOSTS);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 32) : Math.max(1, Math.min(8, os.cpus().length - 2));
};
const idleSeconds = () => {
  const n = Number(process.env.POB_HOST_IDLE_S);
  return Number.isInteger(n) && n >= 5 ? n : 600;
};
export const poolStats = { requests: 0, started: 0, fallbacks: 0, warnings: [] };

const ticker = new Int32Array(new SharedArrayBuffer(4));
const sleep = ms => Atomics.wait(ticker, 0, 0, ms);
const pidAlive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const mtime = file => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };
const unlink = file => { try { fs.unlinkSync(file); } catch {} };
class HostFailure extends Error {}

function hostState(name) {
  const dir = path.join(sourceDirectory, name);
  const created = mtime(dir) == null ? null : fs.statSync(dir).birthtimeMs;
  if (created == null) return { name, dir, state: 'gone' };
  const pid = Number(readText(path.join(dir, 'pid')));
  const beat = mtime(path.join(dir, 'heartbeat'));
  const now = Date.now();
  const fresh = beat != null && now - beat < HEARTBEAT_STALE_MS;
  const failed = fs.existsSync(path.join(dir, 'failed'));
  let state;
  if (pid > 0 && !pidAlive(pid)) state = 'dead';
  else if (failed && !(fresh && pidAlive(pid))) state = 'dead';
  else if (failed) state = 'failing';
  else if (fresh) state = fs.existsSync(path.join(dir, 'ready')) ? 'ready' : 'starting';
  else if (beat == null && now - created < START_GRACE_MS) state = 'starting';
  else state = pidAlive(pid) && beat != null && now - beat < HEARTBEAT_STALE_MS * 3 ? 'stalled' : 'dead';
  return { name, dir, pid, state, created };
}
export function listHosts({ contract = null } = {}) {
  let names = [];
  try { names = fs.readdirSync(sourceDirectory).filter(n => n.startsWith(prefix)); } catch { return []; }
  return names.filter(n => !contract || n.startsWith(`${prefix}${contract.slice(0, 12)}-`)).map(hostState);
}
function removeHost(host) {
  if (path.dirname(host.dir) !== sourceDirectory || !path.basename(host.dir).startsWith(prefix)) throw new Error('Invalid PoB host directory');
  try { fs.rmSync(host.dir, { recursive: true, force: true }); } catch {}
}
function killHost(host, reason) {
  // Only a host whose heartbeat is fresh is killed: its pid is then certainly this host, not a reused pid.
  const beat = mtime(path.join(host.dir, 'heartbeat'));
  try { fs.writeFileSync(path.join(host.dir, 'failed'), `client: ${reason}`); } catch {}
  if (beat != null && Date.now() - beat < HEARTBEAT_STALE_MS && pidAlive(host.pid)) { try { process.kill(host.pid); } catch {} }
}
const lockOwner = () => `${process.pid}:${threadId}:${Date.now()}`;
function tryLock(host) {
  const file = path.join(host.dir, 'lock');
  try { fs.writeFileSync(file, lockOwner(), { flag: 'wx' }); return true; }
  catch (error) {
    if (error.code !== 'EEXIST') return false;
    const [pid, , since] = (readText(file) ?? '').split(':').map(Number);
    // An empty lock is the host retiring itself; a client lock is abandoned when its process is gone.
    if (pid && (!pidAlive(pid) || Date.now() - since > LOCK_MAX_MS)) { unlink(file); try { fs.writeFileSync(file, lockOwner(), { flag: 'wx' }); return true; } catch {} }
    return false;
  }
}
const release = host => unlink(path.join(host.dir, 'lock'));

function stage(dir, workerFile) {
  const name = path.basename(dir);
  fs.writeFileSync(path.join(dir, 'launch.lua'), `AGENT_SERVE_DIR = '${name}'\n${fs.readFileSync(workerFile, 'utf8')}`);
  fs.copyFileSync(path.join(dbRoot, 'scripts/pob-runtime.lua'), path.join(dir, 'runtime.lua'));
  fs.copyFileSync(path.join(dbRoot, 'scripts/pob-edit.lua'), path.join(dir, 'edit.lua'));
}
function startHost(contract, powershell, workerFile) {
  const name = `${prefix}${contract.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(sourceDirectory, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'lock'), lockOwner(), { flag: 'wx' });
  stage(dir, workerFile);
  const log = fs.openSync(path.join(dir, 'host.log'), 'a');
  let child;
  try {
    child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', serverScript, '-RuntimeDirectory', runtimeDirectory, '-HostDirectory', dir, '-IdleSeconds', String(idleSeconds())],
      { cwd: sourceDirectory, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, CI: 'true' } });
    child.on('error', () => {});
    child.unref();
  } finally { fs.closeSync(log); }
  const host = { name, dir, pid: child.pid };
  if (!child.pid) { removeHost(host); throw new HostFailure(`cannot start ${powershell}`); }
  fs.writeFileSync(path.join(dir, 'pid'), String(child.pid));
  poolStats.started++;
  const started = Date.now();
  while (!fs.existsSync(path.join(dir, 'ready'))) {
    const failed = readText(path.join(dir, 'failed'));
    if (failed != null || !pidAlive(child.pid) || Date.now() - started > START_TIMEOUT_MS) {
      const why = failed ?? (pidAlive(child.pid) ? `not ready after ${START_TIMEOUT_MS} ms` : `exited during start-up: ${(readText(path.join(dir, 'host.log')) ?? '').trim().slice(-1500)}`);
      killHost(host, 'start-up failed');
      removeHost(host);
      throw new HostFailure(`PoB host start-up failed: ${why}`);
    }
    sleep(20);
  }
  return host;
}
function acquire(contract, powershell, workerFile, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const hosts = listHosts();
    for (const h of hosts) if (h.state === 'dead') removeHost(h);
    const mine = hosts.filter(h => h.name.startsWith(`${prefix}${contract.slice(0, 12)}-`));
    for (const h of mine.filter(x => x.state === 'ready')) {
      if (!tryLock(h)) continue;
      if (hostState(h.name).state === 'ready') return h;
      release(h);
    }
    if (mine.filter(h => ['ready', 'starting', 'stalled', 'failing'].includes(h.state)).length < maxHosts()) return startHost(contract, powershell, workerFile);
    if (Date.now() > deadline) throw new HostFailure(`no free PoB host within ${waitMs} ms`);
    sleep(10);
  }
}
function request(host, requestPath, timeout) {
  const id = randomUUID();
  const responseFile = path.join(host.dir, 'response');
  unlink(responseFile);
  fs.writeFileSync(path.join(host.dir, 'request.tmp'), `${id}\n${requestPath}`);
  fs.renameSync(path.join(host.dir, 'request.tmp'), path.join(host.dir, 'request'));
  const started = Date.now();
  let checked = started;
  for (;;) {
    const text = readText(responseFile);
    if (text != null) {
      const [rid, status, ...rest] = text.split('\n');
      if (rid === id) { unlink(responseFile); return status === 'OK' ? { ok: true } : { ok: false, error: rest.join('\n') }; }
      if (rid && rid !== id) unlink(responseFile);
    }
    const now = Date.now();
    if (now - started > timeout) { killHost(host, `request timeout after ${timeout} ms`); throw new HostFailure(`timeout after ${timeout} ms`); }
    if (now - checked > 500) {
      checked = now;
      const s = hostState(host.name);
      if (s.state === 'dead' || s.state === 'gone') throw new HostFailure(`PoB host exited during the calculation${s.state === 'dead' ? `: ${(readText(path.join(host.dir, 'failed')) ?? '').slice(0, 500)}` : ''}`);
    }
    sleep(now - started < 2000 ? 2 : 10);
  }
}

// Runs one prepared job (request.json under the PoB source directory) on a pooled host. Returns a spawnSync-shaped
// result so runPob handles both paths alike; `legacy` is the single-shot path used on any host failure.
export function runPersistent({ contract, powershell, workerFile, requestPath, timeout, legacy }) {
  poolStats.requests++;
  let host = null;
  try {
    host = acquire(contract, powershell, workerFile, Math.max(timeout, 120000));
    const answer = request(host, requestPath, timeout);
    release(host);
    host = null;
    return answer.ok ? { status: 0, stdout: '', stderr: '', persistent: true } : { status: 1, stdout: '', stderr: `Lua host error: ${answer.error}`, persistent: true };
  } catch (error) {
    if (!(error instanceof HostFailure)) throw error;
    if (host) { killHost(host, error.message); release(host); host = null; }
    poolStats.fallbacks++;
    const warning = `warning: persistent PoB host failed (${error.message.slice(0, 600)}); this calculation falls back to one PoB process`;
    poolStats.warnings.push(warning);
    process.stderr.write(`${warning}\n`);
    return legacy();
  } finally {
    if (host) release(host);
  }
}

// Ask every host to exit (they retire as soon as they are idle); dead host directories are removed.
export function stopHosts({ wait = 0 } = {}) {
  for (const h of listHosts()) {
    if (h.state === 'dead') removeHost(h);
    else try { fs.writeFileSync(path.join(h.dir, 'stop'), ''); } catch {}
  }
  const until = Date.now() + wait;
  while (Date.now() < until && listHosts().some(h => h.state !== 'dead' && h.state !== 'gone')) sleep(50);
  for (const h of listHosts()) if (h.state === 'dead') removeHost(h);
  return listHosts().map(({ name, pid, state }) => ({ name, pid, state }));
}
