import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceMap, corpusSummary, corpusCommand, addToCorpus, addFromList, corpusSources } from '../scripts/corpus.mjs';

test('source map reads [name, url] lists and {id, pob} build lists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-corpus-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([['rf', 'https://pobb.in/x'], ['dsa', 'https://pobb.in/y']]));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ builds: [{ id: 'shrapnel', pob: 'https://pobb.in/z' }, { name: 'no id' }] }));
    const m = sourceMap([path.join(dir, 'a.json'), path.join(dir, 'b.json')]);
    assert.equal(m.get('rf'), 'https://pobb.in/x'); assert.equal(m.get('shrapnel'), 'https://pobb.in/z'); assert.equal(m.size, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corpus summary counts coverage and structural duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-corpus-'));
  try {
    const card = (sha, sig, asc, skill) => ({ signature: sig, identity: { pob_sha256: sha.repeat(64).slice(0, 64), file: `${sha}.xml` },
      features: { class: 'Witch', ascendancy: asc, main_skill: skill, primary_form: 'hit', primary_type: 'Cold', defense_pool: 'life' }, damage: { effective_dps: 1 }, defense: { ehp: 1 } });
    for (const [i, c] of [card('a', 's1', 'Occultist', 'Vortex'), card('b', 's1', 'Occultist', 'Vortex'), card('c', 's2', 'Elementalist', 'Arc')].entries()) fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(c));
    const s = corpusSummary(dir);
    assert.equal(s.cards, 3); assert.deepEqual(s.by_ascendancy, { Occultist: 2, Elementalist: 1 }); assert.equal(s.duplicates.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corpus CLI validates before touching the engine', () => {
  assert.throws(() => corpusCommand(['add']), /Use corpus add/);
  assert.throws(() => corpusCommand(['import-dir']), /Use corpus import-dir/);
  assert.throws(() => corpusCommand(['zzz']), /Use corpus add/);
  assert.throws(() => addToCorpus({ file: 'x.xml', trust: 'maybe' }), /--trust/);
});

test('add-list skips links already in the corpus and writes a resumable failure list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-corpus-'));
  const cards = path.join(dir, 'cards'); fs.mkdirSync(cards);
  try {
    fs.writeFileSync(path.join(cards, 'a.json'), JSON.stringify({ identity: { source: 'https://pobb.in/AAA (Slayer | guide)' } }));
    fs.writeFileSync(path.join(cards, 'b.json'), JSON.stringify({ identity: { source: 'lightning-arrow.xml' } }));
    assert.deepEqual([...corpusSources(cards)], ['https://pobb.in/AAA/raw']);
    const list = path.join(dir, 'links.txt');
    fs.writeFileSync(list, ['# comment', 'https://pobb.in/AAA/raw\tsame build, raw form', 'https://pobb.in/BBB\tSlayer | x', 'https://pobb.in/BBB/', 'https://pastebin.com/CCC', 'https://maxroll.gg/x'].join('\n'));
    const fetched = [];
    const fetchSource = async url => { fetched.push(url); throw new Error('fetch failed'); };
    const r = await addFromList({ file: list, delayMs: 0, fetchSource, directory: path.join(dir, 'corpus'), cards });
    assert.equal(r.added, 0);
    assert.equal(r.skipped_already_in_corpus, 2); // AAA (in corpus) and the second BBB (same raw address)
    assert.deepEqual(fetched, ['https://pobb.in/BBB/raw', 'https://pastebin.com/raw/CCC']);
    assert.deepEqual(r.failed.map(f => f.url), ['https://pobb.in/BBB', 'https://pastebin.com/CCC', 'https://maxroll.gg/x']);
    assert.match(r.failed[0].error, /unreachable/);
    const failedText = fs.readFileSync(r.failed_file, 'utf8');
    assert.equal(r.failed_file, path.join(dir, 'links.failed.txt'));
    assert.deepEqual(failedText.split('\n').filter(l => l && !l.startsWith('#')), ['https://pobb.in/BBB\tSlayer | x', 'https://pastebin.com/CCC', 'https://maxroll.gg/x']);
    // A rerun of the failure list where nothing fails removes the stale failure file of that list.
    const empty = path.join(dir, 'empty.txt'); fs.writeFileSync(empty, 'https://pobb.in/AAA\n'); fs.writeFileSync(path.join(dir, 'empty.failed.txt'), 'old');
    const again = await addFromList({ file: empty, delayMs: 0, fetchSource, cards });
    assert.equal(again.skipped_already_in_corpus, 1); assert.equal(again.failed_file, null); assert.ok(!fs.existsSync(path.join(dir, 'empty.failed.txt')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
