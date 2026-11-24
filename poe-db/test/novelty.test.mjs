import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noveltyVector, cardDistance, noveltyScore, loadNoveltyCorpus, noveltyCommand, noveltyWeights } from '../scripts/novelty.mjs';

// Minimal BuildCard fixtures: only the fields the novelty vector reads.
function card(id, o = {}) {
  return {
    kind: 'build_card', signature: o.signature ?? `sig-${id}`, _card: `${id}.json`,
    identity: { file: `${id}.xml`, pob_sha256: `sha-${id}`, level: o.level ?? 95, source: null },
    features: { class: o.class ?? 'Witch', ascendancy: o.ascendancy ?? 'Occultist', main_skill: o.skill ?? 'Vortex', damage_scope: o.scope ?? 'player',
      primary_form: o.form ?? 'skill_dot', primary_type: o.type ?? 'Cold', defense_pool: o.pool ?? 'es',
      defense_layers: o.layers ?? ['energy_shield', 'spell_suppression', 'freeze_immunity'], keystones: o.keystones ?? ['Eldritch Battery'],
      uniques: o.uniques ?? ["Atziri's Disfavour", 'Badge of the Brotherhood', 'Cospri\'s Malice', 'Watcher\'s Eye'] },
    skills: { main: { name: o.skill ?? 'Vortex', tags: o.tags ?? ['spell', 'area', 'duration', 'cold', 'intelligence'], supports: o.supports ?? ['Controlled Destruction', 'Efficacy', 'Swift Affliction', 'Elemental Focus'] } },
    damage: { parts: o.parts ?? { hit: 0.1, skill_dot: 0.9 }, types: o.typesShare ?? { Cold: 1 }, scope: o.scope ?? 'player' },
    resources: { sustained: o.sustained ?? true }
  };
}
const base = card('base');
const archetype = card('slam', { class: 'Marauder', ascendancy: 'Chieftain', skill: 'Earthquake', form: 'hit', type: 'Physical', pool: 'life', parts: { hit: 1 }, typesShare: { Physical: 0.7, Fire: 0.3 },
  layers: ['armour', 'life_regen', 'attack_block'], keystones: ['Resolute Technique'], uniques: ['Kaom\'s Heart', 'Starforge'], tags: ['attack', 'melee', 'area', 'slam', 'physical'],
  supports: ['Melee Physical Damage', 'Fist of War', 'Brutality'], sustained: false });

test('vector splits sustain from mitigation layers and keeps delivery tags only', () => {
  const v = noveltyVector(base);
  assert.deepEqual(v.delivery, ['area', 'duration', 'spell']);
  assert.deepEqual(v.defense_layers, ['freeze_immunity', 'spell_suppression']);
  assert.deepEqual(v.sustain, ['energy_shield', 'mana_sustained']);
  assert.equal(v.damage_form.skill_dot, 0.9);
});

test('distance: duplicate 0, one swapped unique small, other archetype large', () => {
  assert.equal(cardDistance(base, card('dup')).distance, 0);
  const swap = card('swap', { uniques: ["Atziri's Disfavour", 'Badge of the Brotherhood', 'Cospri\'s Malice', 'Bottled Faith'] });
  const d = cardDistance(base, swap);
  assert.ok(d.distance > 0 && d.distance < 0.05, `swap distance ${d.distance}`);
  assert.equal(d.groups.uniques, 0.4);
  const far = cardDistance(base, archetype).distance;
  assert.ok(far > 0.8, `archetype distance ${far}`);
  // Same class, other ascendancy is closer than another class.
  assert.ok(cardDistance(base, card('elem', { ascendancy: 'Elementalist' })).groups.ascendancy < cardDistance(base, card('sab', { class: 'Shadow', ascendancy: 'Saboteur' })).groups.ascendancy);
  // Unknown is half a difference, not equality.
  const nopool = card('nopool'); nopool.features.defense_pool = null;
  assert.equal(cardDistance(base, nopool).groups.defense_pool, 0.5);
});

test('noveltyScore: nearest neighbour, differences, self skipped, bands', () => {
  const corpus = [base, archetype, card('elem', { ascendancy: 'Elementalist', uniques: ['Ashes of the Stars'] })];
  const self = noveltyScore(base, corpus, { top: 2 });
  assert.deepEqual(self.skipped_self, ['base.json']);
  assert.equal(self.compared, 2);
  assert.equal(self.nearest[0].card, 'elem.json');
  assert.ok(self.nearest[0].differences.some(x => x.group === 'uniques' && x.added.includes('Cospri\'s Malice') && x.removed.includes('Ashes of the Stars')));
  const swap = card('swap', { uniques: ["Atziri's Disfavour", 'Badge of the Brotherhood', 'Cospri\'s Malice', 'Bottled Faith'] });
  const s = noveltyScore(swap, corpus);
  assert.equal(s.nearest[0].card, 'base.json'); assert.equal(s.band, 'duplicate');
  const dup = noveltyScore(card('copy', { signature: 'sig-base' }), corpus);
  assert.equal(dup.novelty, 0); assert.equal(dup.nearest[0].same_signature, true);
  const novel = noveltyScore(card('rf', { class: 'Templar', ascendancy: 'Inquisitor', skill: 'Righteous Fire', form: 'skill_dot', type: 'Fire', typesShare: { Fire: 1 }, pool: 'life', layers: ['life_regen', 'spell_block'], keystones: [], uniques: [], supports: [], tags: ['spell', 'area'] }), corpus);
  assert.equal(novel.band, 'novel');
  assert.equal(noveltyScore(base, []).novelty, null);
  assert.ok(Object.values(noveltyWeights).every(w => w > 0));
});

test('corpus loading applies the quality filter; CLI reads a card JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelty-'));
  try {
    const write = c => { const { _card, ...rest } = c; fs.writeFileSync(path.join(dir, _card), JSON.stringify(rest)); };
    write(base); write(archetype); write(card('low', { level: 40 })); write(card('dupsig', { signature: 'sig-base', level: 90 }));
    const { cards, filter } = loadNoveltyCorpus({ directory: dir });
    assert.deepEqual(cards.map(c => c._card).sort(), ['base.json', 'slam.json']);
    assert.equal(filter.excluded, 2);
    assert.equal(loadNoveltyCorpus({ directory: dir, all: true }).cards.length, 4);
    const inDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelty-in-'));
    const inFile = path.join(inDir, 'in.json');
    fs.writeFileSync(inFile, JSON.stringify(card('in', { uniques: ['Ashes of the Stars'] })));
    const out = await noveltyCommand(['novelty', inFile, '--dir', dir, '--top', '1']);
    assert.equal(out.analysis, 'novelty'); assert.equal(out.nearest.length, 1); assert.equal(out.nearest[0].card, 'base.json');
    assert.equal(out.corpus.quality_filter.kept, 2);
    assert.ok(out.novelty > 0 && out.novelty < 0.2);
    await assert.rejects(() => noveltyCommand(['novelty', path.join(dir, 'base.json').replace('base', 'missing')]), /not found/);
    fs.rmSync(inDir, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
