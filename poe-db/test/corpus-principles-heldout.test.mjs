import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heldOutCheck } from '../scripts/corpus.mjs';
import { parseFeedHtml } from '../scripts/corpus-discover.mjs';

test('held-out check: level, ascendancy and leakage from the training corpus', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldout-'));
  const card = (sha, sig, level = 95, asc = 'Elementalist') => ({ signature: sig, identity: { pob_sha256: sha, file: `${sha}.xml`, level }, features: { ascendancy: asc, class: 'Witch', main_skill: 'X' }, damage: {}, defense: {} });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(card('aaa', 'sig-a')));
  assert.equal(heldOutCheck(card('bbb', 'sig-b'), { training: dir }), null);
  assert.match(heldOutCheck(card('bbb', 'sig-b', 85), { training: dir }), /level 85 < 90/);
  assert.match(heldOutCheck(card('bbb', 'sig-b', 95, 'None'), { training: dir }), /no ascendancy/);
  assert.match(heldOutCheck(card('aaa', 'sig-x'), { training: dir }), /same XML/);
  assert.match(heldOutCheck(card('ccc', 'sig-a'), { training: dir }), /same signature/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('feed parser keeps untagged cards only with untagged, marked version_unverified', () => {
  const card = (id, ver) => `<div class="build-series"><a href="/poe1/build/${id}"></a><span class="build-card-title" title="T ${id}"></span>${ver ? `<span class="build-card-tag--version">${ver}</span>` : ''}</div>`;
  const html = card('a', '3.30 Covens') + card('b', '') + card('c', '3.29 Keepers');
  assert.deepEqual(parseFeedHtml(html, { version: '3.30' }).map(c => c.id), ['a']);
  const u = parseFeedHtml(html, { version: '3.30', untagged: true });
  assert.deepEqual(u.map(c => c.id), ['a', 'b']);
  assert.equal(u[1].version_unverified, true);
  assert.equal(u[0].version_unverified, undefined);
});
