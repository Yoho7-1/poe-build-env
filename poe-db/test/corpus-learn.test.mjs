import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { componentKeys, trainTierModel, predictTier, corpusInsights, qualityFilter, loadAblationRows, ablateCorpus, qualityAblationRows } from '../scripts/corpus-learn.mjs';
import { rescoreBaselines, empiricalBaseline } from '../scripts/lab-bench.mjs';
import { createRecord, getRecord } from '../scripts/lab.mjs';
import { rawUrl } from '../scripts/corpus.mjs';

test('component keys go from specific to general for every kind', () => {
  assert.deepEqual(componentKeys({ kind: 'supports', label: 'Empower' }), ['support:Empower', 'supports']);
  assert.deepEqual(componentKeys({ kind: 'items', label: 'Ancestral Vision, Viridian Jewel (Viridian Jewel)', target: { slot: 'Jewel 61834', rarity: 'RARE' } }), ['item:Jewel:RARE', 'item:Jewel', 'items']);
  assert.deepEqual(componentKeys({ kind: 'items', label: "Crown of the Inward Eye (Prophet Crown)", target: { slot: 'Helmet', rarity: 'UNIQUE' } })[0], 'unique:Crown of the Inward Eye');
  assert.deepEqual(componentKeys({ kind: 'tree', label: 'Void Beacon (ascendancy notable)', target: { type: 'notable', ascendancy: 'Occultist' } }), ['node:Void Beacon', 'tree:ascendancy_notable', 'tree']);
  assert.deepEqual(componentKeys({ kind: 'skills', label: 'Aura: Malevolence + Enlighten [Weapon 2]' }), ['skill:Malevolence+Enlighten', 'skill_first:Malevolence', 'skills']);
  assert.deepEqual(componentKeys({ kind: 'config', target: { key: 'useFrenzyCharges' } }), ['config:useFrenzyCharges', 'config']);
});

const rows = [
  ...['a', 'b', 'c'].map(build => ({ build, kind: 'supports', label: 'Empower', tier: 'core', offense_loss_pct: 30 })),
  { build: 'a', kind: 'supports', label: 'Efficacy', tier: 'major', offense_loss_pct: 15 },
  { build: 'a', kind: 'supports', label: 'Arcane Surge', tier: 'minor' },
  ...['a', 'b'].map(build => ({ build, kind: 'tree', label: 'X (mastery)', target: { type: 'mastery' }, tier: 'negligible' })),
  { build: 'c', kind: 'tree', label: 'Y (mastery)', target: { type: 'mastery' }, tier: 'negligible' }
];

test('tier model backs off from rare specific keys to the kind', () => {
  const m = trainTierModel(rows);
  assert.equal(m.builds, 3);
  assert.deepEqual(predictTier(m, { kind: 'supports', label: 'Empower' }), { tier: 'core', key: 'support:Empower', n: 3 });
  assert.equal(predictTier(m, { kind: 'supports', label: 'Efficacy' }).key, 'supports'); // one observation: not enough
  assert.equal(predictTier(m, { kind: 'supports', label: 'Unseen' }).tier, 'core');
  assert.equal(predictTier(m, { kind: 'tree', label: 'Z (mastery)', target: { type: 'mastery' } }).tier, 'negligible');
  assert.equal(predictTier(m, { kind: 'items', label: 'x', target: {} }).key, null);
  assert.equal(m.keys['support:Empower'].median_dps_loss_pct, 30);
  const ins = corpusInsights(m, { minBuilds: 2 });
  assert.equal(ins.supports_that_carry[0].key, 'support:Empower');
  assert.match(ins.caveat, /hypothesis/);
});

test('empirical baseline excludes the benchmarked build and rescore keeps agent predictions', () => {
  const loader = ({ excludeSha }) => rows.filter(r => r.build !== excludeSha);
  assert.equal(empiricalBaseline('a', loader).trained_on.builds, 2);
  assert.equal(empiricalBaseline(null, () => []), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-learn-'));
  const ledger = path.join(dir, 'l.jsonl');
  try {
    const components = [{ id: 's1', kind: 'supports', label: 'Empower' }, { id: 't1', kind: 'tree', label: 'Q (mastery)', target: { type: 'mastery' } }];
    const b = createRecord({ type: 'benchmark', title: 'T', data: { task: { kind: 'ablation_tiers', components }, predictions: { tiers: { s1: 'major', t1: 'minor' } },
      score: { truth: { s1: 'core', t1: 'negligible' }, input_sha256: 'c', agent: { exact: 0 }, baselines: {} } } }, { file: ledger });
    const r = rescoreBaselines(b.id, 1, { ledger, rowsLoader: loader });
    assert.equal(r.data.score.baselines.empirical.exact, 1);
    assert.equal(r.data.score.empirical_training.excluded_input_sha256, 'c');
    assert.deepEqual(getRecord(b.id, { file: ledger }).data.predictions.tiers, { s1: 'major', t1: 'minor' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('share links map to the raw paste PoB imports; other hosts are refused', () => {
  assert.equal(rawUrl('https://pobb.in/fw66mh2PgIPK'), 'https://pobb.in/fw66mh2PgIPK/raw');
  assert.equal(rawUrl('https://pobb.in/fw66mh2PgIPK/raw'), 'https://pobb.in/fw66mh2PgIPK/raw');
  assert.equal(rawUrl('https://pastebin.com/abcd'), 'https://pastebin.com/raw/abcd');
  assert.equal(rawUrl('https://pob.codes/b/AbC123'), 'https://api.pob.codes/AbC123/raw');
  assert.equal(rawUrl('https://pob.codes/b/AbC123/?x=1'), 'https://api.pob.codes/AbC123/raw');
  assert.equal(rawUrl('https://api.pob.codes/AbC123/raw'), 'https://api.pob.codes/AbC123/raw');
  assert.throws(() => rawUrl('https://pob.codes/'), /no build id/);
  assert.throws(() => rawUrl('https://maxroll.gg/poe/build-guides/x'), /Unsupported host/);
});

const qcard = (file, level, asc, sig, origin = { origin_patch: '3.30', migration: null }) => ({ signature: sig, identity: { file: `${file}.xml`, level, origin }, features: { ascendancy: asc, main_skill: 'X' } });

test('quality filter drops low level, missing ascendancy and duplicate signatures with reasons', () => {
  const q = qualityFilter([qcard('lvl1', 1, 'None', 's1'), qcard('merc', 95, null, 's2'), qcard('lvl79', 79, 'Slayer', 's3'),
    qcard('mig', 100, 'Necromancer', 'dup', { origin_patch: '3.29', migration: { from: '3_29' } }), qcard('nat', 100, 'Necromancer', 'dup', { origin_patch: '3.29', migration: null }),
    qcard('low', 92, 'Necromancer', 'dup'), qcard('ok', 85, 'Deadeye', 's4')]);
  assert.deepEqual([...q.keep].sort(), ['nat', 'ok']);
  const why = Object.fromEntries(q.excluded.map(e => [e.file, e.reasons]));
  assert.deepEqual(why.lvl1, ['level 1 < 80', 'no ascendancy']);
  assert.deepEqual(why.merc, ['no ascendancy']);
  assert.deepEqual(why.lvl79, ['level 79 < 80']);
  assert.deepEqual(why.mig, ['duplicate signature of nat']); // same level: the build not migrated here wins
  assert.deepEqual(why.low, ['duplicate signature of nat']); // highest level first
  assert.equal(qualityFilter([qcard('lvl79', 79, 'Slayer', 's3')], { minLevel: 70 }).kept, 1);
});

test('training rows and corpus ablation follow the quality filter; all=true disables it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-quality-'));
  const cards = path.join(dir, 'cards'), corpus = path.join(dir, 'corpus');
  try {
    for (const d of [cards, path.join(corpus, 'xml'), path.join(corpus, 'ablation')]) fs.mkdirSync(d, { recursive: true });
    for (const [f, lvl] of [['good', 95], ['bad', 14]]) {
      fs.writeFileSync(path.join(cards, `${f}.json`), JSON.stringify(qcard(f, lvl, lvl > 50 ? 'Slayer' : 'None', f)));
      fs.writeFileSync(path.join(corpus, 'xml', `${f}.xml`), '<PathOfBuilding/>');
    }
    fs.writeFileSync(path.join(corpus, 'xml', 'orphan.xml'), '<PathOfBuilding/>');
    const calls = [];
    const analyze = ({ file }) => { calls.push(path.basename(file)); return { contract: { input_sha256: path.basename(file) }, rows: [{ kind: 'supports', label: 'Empower', tier: 'core', deltas: {} }], summary: { core: [1] } }; };
    const r = ablateCorpus({ cards, directory: corpus, analyze });
    assert.deepEqual(calls, ['good.xml']);
    assert.equal(r.quality_filter.kept, 1);
    assert.deepEqual(r.quality_filter.excluded_builds.map(e => [e.file, e.reasons[0]]), [['bad', 'level 14 < 80'], ['orphan', 'no card']]);
    const all = ablateCorpus({ cards, directory: corpus, analyze, all: true });
    assert.deepEqual(calls, ['good.xml', 'bad.xml', 'orphan.xml']);
    assert.equal(all.already, 1); assert.equal(all.quality_filter, 'off (--all)');
    const ablation = path.join(corpus, 'ablation');
    assert.equal(new Set(loadAblationRows({ directory: ablation }).map(x => x.build)).size, 3);
    assert.deepEqual(qualityAblationRows({ directory: ablation, cards }).map(x => x.build), ['good.xml']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
