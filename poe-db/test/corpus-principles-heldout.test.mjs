import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heldOutCheck } from '../scripts/corpus.mjs';
import { parseFeedHtml } from '../scripts/corpus-discover.mjs';
import { heldOutMatches } from '../scripts/corpus-principles.mjs';

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

test('held-out test selection splits builds by context and never reads a tier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldout-match-'));
  const cards = path.join(dir, 'cards'), xml = path.join(dir, 'xml');
  fs.mkdirSync(cards); fs.mkdirSync(xml);
  // A card file may be named by the migrated hash, so identity.file is what links it to the XML.
  const card = (file, { mana = null, tags = ['spell'], asc = 'Elementalist' } = {}) => ({ identity: { file }, skills: { main: { name: 'X', tags } },
    damage: { primary_form: 'hit', scope: 'player' }, features: { ascendancy: asc, defense_pool: 'life', primary_type: 'Cold' },
    ...(mana ? { foundation: { mana: { applies: true, primary: mana } } } : {}) });
  fs.writeFileSync(path.join(cards, 'renamed-1.json'), JSON.stringify(card('in.xml', { mana: 'leech' })));
  fs.writeFileSync(path.join(cards, 'renamed-2.json'), JSON.stringify(card('out.xml', { mana: 'regen' })));
  fs.writeFileSync(path.join(cards, 'renamed-3.json'), JSON.stringify(card('nomana.xml')));
  for (const f of ['in.xml', 'out.xml', 'nomana.xml', 'without.xml']) fs.writeFileSync(path.join(xml, f), '<x/>');
  try {
    const planner = ({ file }) => ({ components: path.basename(file) === 'without.xml' ? [{ id: 'node:1', kind: 'tree', label: 'Other (mastery)', target: { type: 'mastery' } }]
      : [{ id: 'node:7', kind: 'tree', label: 'Evasion Mastery (mastery)', target: { type: 'mastery' } }] });
    const r = heldOutMatches({ key: 'node:Evasion Mastery', context: { mana: 'leech' }, xmlDir: xml, cardsDir: cards, planner });
    assert.deepEqual(r.inside.map(x => x.build), ['in']);
    assert.deepEqual(r.outside.map(x => x.build), ['out']);
    assert.deepEqual(r.unknown.map(x => x.build), ['nomana']); // mana does not apply: neither side, so no claim
    assert.equal(r.held_out_builds, 3);
    assert.equal(r.inside[0].components[0].id, 'node:7');
    assert.equal('tier' in r.inside[0], false); // the truth stays uncomputed until analyze ablate runs
    // Without a context every matching build is listed; a build without the component never appears.
    const all = heldOutMatches({ key: 'node:Evasion Mastery', xmlDir: xml, cardsDir: cards, planner });
    assert.deepEqual(all.inside.map(x => x.build).sort(), ['in', 'nomana', 'out']);
    assert.deepEqual([all.outside, all.unknown], [[], []]);
    // A planner failure is reported, not thrown.
    const failing = heldOutMatches({ key: 'node:Evasion Mastery', xmlDir: xml, cardsDir: cards, planner: () => { throw new Error('bad xml'); } });
    assert.equal(failing.failed.length, 4);
    assert.throws(() => heldOutMatches({ xmlDir: xml, cardsDir: cards, planner }), /--match/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
