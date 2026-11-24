// Persistent PoB hosts (pob-pool.mjs, pob-host-server.ps1, pob-worker.lua persistent mode): the same numbers as the
// single-shot path, isolation between consecutive builds on one host, host failures falling back, and the flask
// slot activation of replace_items.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPob, resolvePowerShellHost } from '../scripts/pob.mjs';
import { runPersistent, listHosts, poolStats } from '../scripts/pob-pool.mjs';
import { dbRoot } from '../scripts/workspace.mjs';

const fixture = name => fs.readFileSync(path.join(dbRoot, 'fixtures', name), 'utf8');
// Everything a calculation returns except bookkeeping of this particular run.
const comparable = r => {
  const { computed_at, cache_hit, ...rest } = r;
  return { ...rest, equipped_items: [...(rest.equipped_items ?? [])].sort((a, b) => a.slot.localeCompare(b.slot)) };
};
const flask = (slot, active) => ({ slot, text: 'Rarity: MAGIC\nGranite Flask', ...(active == null ? {} : { active }) });

test('A, then B, then A again on one persistent host: A is identical to the single-shot path', () => {
  const saved = process.env.POB_HOSTS;
  process.env.POB_HOSTS = '1';
  try {
    const a = { input: fixture('fireball-control.xml'), scenario: 'sustained', full: true, noCache: true };
    // B changes as much PoB state as the adapter can: another build, edits, enemy mods, custom mods, flasks, config.
    const b = { input: fixture('fireball-life-control.xml'), scenario: 'unbuffed', full: true, noCache: true, changes: {
      config: { enemyIsBoss: 'Pinnacle', conditionLowLife: true }, custom_mods: '20% increased Armour', enemy_mods: [{ name: 'PhysicalDamageReduction', type: 'BASE', value: 30 }],
      replace_items: [flask('Flask 1', true)], gem_levels: [{ group: 1, gem: 1, level: 21 }] } };
    const reference = runPob({ ...a, persistent: false });
    const first = runPob({ ...a, persistent: true });
    const other = runPob({ ...b, persistent: true });
    const again = runPob({ ...a, persistent: true });
    assert.deepEqual(comparable(first), comparable(reference));
    assert.deepEqual(comparable(again), comparable(reference));
    assert.notDeepEqual(other.output, reference.output);
    // B on a host that has served other builds equals B in a fresh process too.
    assert.deepEqual(comparable(runPob({ ...b, persistent: false })), comparable(other));
    assert.equal(first.calculation_contract_sha256, reference.calculation_contract_sha256);
  } finally {
    if (saved == null) delete process.env.POB_HOSTS; else process.env.POB_HOSTS = saved;
  }
});

test('a failed request does not leak into the next one on the same host', () => {
  const a = { input: fixture('fireball-control.xml'), scenario: 'sustained', noCache: true, persistent: true };
  const before = runPob(a);
  assert.throws(() => runPob({ ...a, changes: { remove_nodes: [{ node: 1 }] } }), /Change error/);
  assert.throws(() => runPob({ ...a, changes: { replace_items: [{ slot: 'Helmet', text: 'Rarity: MAGIC\nGranite Flask' }] } }), /Invalid item for requested slot/);
  assert.deepEqual(runPob(a).output, before.output);
});

test('replace_items.active switches a flask on: Granite Flask raises Armour only when active', () => {
  const base = { input: fixture('fireball-control.xml'), scenario: 'imported' };
  const none = runPob(base).output.Armour;
  const inactive = runPob({ ...base, changes: { replace_items: [flask('Flask 1', false)] } }).output.Armour;
  const active = runPob({ ...base, changes: { replace_items: [flask('Flask 1', true)] } });
  assert.equal(inactive, none);
  assert.ok(active.output.Armour > none + 1000, `Armour ${none} -> ${active.output.Armour}`);
  assert.equal(active.equipped_items.find(i => i.slot === 'Flask 1')?.active, true);
  assert.throws(() => runPob({ ...base, changes: { replace_items: [{ ...flask('Flask 1'), active: 'yes' }] } }), /active must be boolean/);
  assert.throws(() => runPob({ ...base, changes: { replace_items: [{ slot: 'Helmet', text: 'Rarity: NORMAL\nIron Hat', active: true }] } }), /flask slots/);
});

test('custom_mods reach the calculation, also when the build already has its own custom mod block', () => {
  const plain = fixture('fireball-control.xml');
  // A build saved with custom mods: PoB moves them into a customModsList block on load.
  const withOwn = plain.replace('<ConfigSet id="1">', '<ConfigSet id="1">\n\t\t\t<Input name="customMods" string="+10 to Strength"/>');
  for (const input of [plain, withOwn]) {
    const base = runPob({ input, scenario: 'imported', noCache: true }).output.Life;
    const r = runPob({ input, scenario: 'imported', noCache: true, changes: { custom_mods: '+1000 to maximum Life' } });
    assert.ok(r.output.Life > base + 900, `Life ${base} -> ${r.output.Life}`);
    assert.deepEqual(r.unparsed_custom_mods, []);
  }
});

// Host failures, with tiny fake workers instead of PoB (fast) and a stub for the single-shot fallback.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-pob-pool-'));
test.after(() => {
  assert.ok(path.basename(temp).startsWith('poe-pob-pool-'));
  fs.rmSync(temp, { recursive: true, force: true });
});
const fakeWorker = (name, body) => { const file = path.join(temp, `${name}.lua`); fs.writeFileSync(file, body); return file; };
const fake = (workerFile, timeout = 20000) => {
  const contract = `test${randomUUID().replaceAll('-', '')}`;
  let fellBack = 0;
  const run = () => runPersistent({ contract, powershell: resolvePowerShellHost().file, workerFile, requestPath: 'none.json', timeout, legacy: () => { fellBack++; return { status: 0, stdout: 'legacy', stderr: '' }; } });
  return { run, contract, fellBack: () => fellBack };
};
const quiet = fn => { const write = process.stderr.write; process.stderr.write = () => true; try { return fn(); } finally { process.stderr.write = write; } };

test('host failures fall back to one process per calculation, with a warning; a crashed host is replaced', () => {
  const ok = fake(fakeWorker('ok', 'function AGENT_SERVE(p) end\nfunction AGENT_RESET() end\n'));
  assert.equal(ok.run().persistent, true);
  assert.equal(ok.run().persistent, true);
  assert.equal(ok.fellBack(), 0);

  const lua = fake(fakeWorker('lua-error', "function AGENT_SERVE(p) error('Change error: test') end\nfunction AGENT_RESET() end\n"));
  const failed = lua.run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Change error: test/);
  assert.equal(lua.fellBack(), 0, 'a Lua error is a calculation error, not a host failure');

  const warnings = poolStats.warnings.length;
  const broken = fake(fakeWorker('broken', "error('cannot load')\n"));
  assert.equal(quiet(broken.run).stdout, 'legacy');
  assert.equal(broken.fellBack(), 1);
  assert.match(poolStats.warnings.at(-1), /start-up failed: start-up: .*cannot load/);

  const crash = fake(fakeWorker('crash', 'function AGENT_SERVE(p) os.exit(3) end\nfunction AGENT_RESET() end\n'));
  assert.equal(quiet(crash.run).stdout, 'legacy');
  assert.match(poolStats.warnings.at(-1), /exited during the calculation/);
  assert.equal(quiet(crash.run).stdout, 'legacy', 'the next request starts a new host');
  assert.equal(crash.fellBack(), 2);

  const hang = fake(fakeWorker('hang', 'function AGENT_SERVE(p) while true do end end\nfunction AGENT_RESET() end\n'), 3000);
  const started = Date.now();
  assert.equal(quiet(hang.run).stdout, 'legacy');
  assert.ok(Date.now() - started < 60000);
  assert.match(poolStats.warnings.at(-1), /timeout after 3000 ms/);
  assert.ok(poolStats.warnings.length >= warnings + 4);
  for (const f of [ok, lua, broken, crash, hang]) for (const h of listHosts({ contract: f.contract })) if (h.state !== 'dead') fs.writeFileSync(path.join(h.dir, 'stop'), '');
});
