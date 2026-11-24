import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOverrides, checkResolveOverrides, hosts } from '../scripts/source-cache.mjs';

test('resolve overrides merge the local network file with the env variable (env wins)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-net-'));
  const file = path.join(dir, 'network.json');
  try {
    assert.deepEqual(resolveOverrides({ file: path.join(dir, 'missing.json'), env: '' }), {});
    fs.writeFileSync(file, JSON.stringify({ resolve: { 'pobb.in': '104.21.0.1', 'pastebin.com': '1.2.3.4' } }));
    assert.deepEqual(resolveOverrides({ file, env: undefined }), { 'pobb.in': '104.21.0.1', 'pastebin.com': '1.2.3.4' });
    assert.deepEqual(resolveOverrides({ file, env: ' pobb.in = 104.21.0.2 , api.pob.codes=2606:4700::1,broken, =x' }),
      { 'pobb.in': '104.21.0.2', 'pastebin.com': '1.2.3.4', 'api.pob.codes': '2606:4700::1' });
    assert.deepEqual(resolveOverrides({ file: null, env: 'pobb.in=104.21.0.1' }), { 'pobb.in': '104.21.0.1' });
    assert.equal(checkResolveOverrides({ file, env: '' }).count, 2);
    assert.throws(() => checkResolveOverrides({ file: null, env: 'evil.example=1.2.3.4' }), /not approved/);
    assert.throws(() => checkResolveOverrides({ file: null, env: 'pobb.in=not-an-ip' }), /not an IP address/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('approved hosts include the corpus link sources', () => {
  for (const h of ['pobb.in', 'api.pob.codes', 'pastebin.com', 'www.poebuilds.cc']) assert.ok(hosts.has(h), h);
});
