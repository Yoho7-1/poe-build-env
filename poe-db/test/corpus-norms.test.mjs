import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normsOf, matchesGroup, corpusNorms, backfillFoundations, chooseNormGroup } from '../scripts/corpus-norms.mjs';
import { FOUNDATION_SCHEMA, foundationCheck } from '../scripts/build-foundation.mjs';

const f = ({ primary = 'leech', leech = 100, sustain = 10, slack = 50, mast = 5, eld = 2, cl = 0, auto = 2, ks = [] } = {}) => ({ schema: FOUNDATION_SCHEMA,
  mana: { applies: true, primary, leech_per_s: leech, sustain_per_s: sustain, regen_share: 0.2, reserved_pct: 70 }, life: { primary: 'leech', leech_per_s: 10, recoup_pct: 0, regen_pct: 2 },
  attributes: { requirements_known: true, omniscience: false, slack_total: slack, max_slack: slack, unmet: [] }, masteries: { count: mast, effects: [] },
  eldritch: { items: eld, slots: [] }, clusters: { large: cl, medium: 0, small: 0, total: cl }, anoint: null, flasks: { auto, manual: 0 }, keystones: ks });

test('norms count sustain sources, headroom and free power layers', () => {
  const n = normsOf([f(), f({ leech: 200 }), f({ primary: 'regen', leech: 0, sustain: -50, slack: 300, eld: 0, cl: 1, auto: 0, ks: ['Mind Over Matter'] })]);
  assert.equal(n.builds, 3);
  assert.equal(n.mana.uses_leech, 0.667); assert.equal(n.mana.regen_primary_without_leech, 0.333); assert.equal(n.mana.sustain_deficit, 0.333);
  assert.equal(n.mana.primary[0].value, 'leech'); assert.equal(n.attributes.slack_total.median, 50);
  assert.equal(n.eldritch.uses, 0.667); assert.equal(n.clusters.uses, 0.333); assert.equal(n.flasks.uses_auto, 0.667);
  assert.deepEqual(n.keystones.top[0], { value: 'Mind Over Matter', n: 1, share: 0.333 });
});

test('foundation check warns on regen-only mana, surplus attributes and missing common layers', () => {
  const norms = normsOf(Array.from({ length: 10 }, (_, i) => f({ slack: 40 + i * 5, ks: i < 5 ? ['Mind Over Matter'] : [] })));
  const proto = { ...f({ primary: 'regen', leech: 0, sustain: -235, slack: 370, eld: 0, auto: 0, mast: 1, ks: ['Iron Reflexes'] }) };
  proto.mana = { ...proto.mana, regen_per_s: 45, on_hit_per_s: 0, cost_per_s: 280 };
  const r = foundationCheck(proto, norms);
  const codes = r.warnings.map(w => w.code);
  for (const c of ['mana_sustain_deficit', 'mana_regen_without_leech', 'attribute_surplus', 'masteries_low', 'no_eldritch_implicits', 'no_auto_flasks', 'keystone_unusual']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('no_cluster_jewels'));
  assert.equal(r.status, 'warn');
  assert.equal(foundationCheck(f({ slack: 60 }), norms).status, 'ok');
  assert.equal(foundationCheck(proto, { builds: 0 }).status, 'no_norms');
});

test('norm group falls back from ascendancy+family to family, ascendancy and the whole corpus', () => {
  const mk = (i, asc, tags) => ({ _card: `${i}.json`, signature: `s${i}`, identity: { file: `${i}.xml`, level: 95 }, features: { ascendancy: asc }, skills: { main: { tags } }, damage: { primary_form: 'hit' }, foundation: f() });
  const cards = [...Array.from({ length: 3 }, (_, i) => mk(`o${i}`, 'Occultist', ['spell'])), ...Array.from({ length: 6 }, (_, i) => mk(`e${i}`, 'Elementalist', ['spell'])), ...Array.from({ length: 2 }, (_, i) => mk(`a${i}`, 'Occultist', ['attack']))];
  assert.deepEqual(chooseNormGroup({ cards, ascendancy: 'Occultist', family: 'spell', minGroup: 3 }).group, { ascendancy: 'Occultist', skill_tag: 'spell', builds: 3 });
  assert.equal(chooseNormGroup({ cards, ascendancy: 'Occultist', family: 'spell', minGroup: 5 }).group.skill_tag, 'spell');
  assert.equal(chooseNormGroup({ cards, ascendancy: 'Occultist', family: 'spell', minGroup: 5 }).group.ascendancy, null);
  assert.deepEqual(chooseNormGroup({ cards, ascendancy: 'Occultist', family: 'attack', minGroup: 5 }).group, { ascendancy: 'Occultist', skill_tag: null, builds: 5 });
  assert.equal(chooseNormGroup({ cards, ascendancy: 'Juggernaut', family: 'attack', minGroup: 5 }).group.builds, 11);
});

test('groups filter by ascendancy list, skill tag and hit/dot form', () => {
  const c = { features: { ascendancy: 'Occultist' }, skills: { main: { tags: ['spell', 'cold'] } }, damage: { primary_form: 'skill_dot' } };
  assert.equal(matchesGroup(c, { ascendancy: 'Chieftain, occultist' }), true);
  assert.equal(matchesGroup(c, { skillTag: 'attack' }), false);
  assert.equal(matchesGroup(c, { form: 'dot' }), true);
  assert.equal(matchesGroup(c, { form: 'hit' }), false);
});

test('corpus norms use quality-filtered cards, flag small groups and backfill missing foundations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norms-'));
  const cards = path.join(dir, 'cards'), corpus = path.join(dir, 'corpus');
  fs.mkdirSync(cards); fs.mkdirSync(path.join(corpus, 'xml'), { recursive: true });
  const card = (name, asc, level, foundation) => fs.writeFileSync(path.join(cards, `${name}.json`), JSON.stringify({ signature: name, identity: { file: `${name}.xml`, level }, features: { ascendancy: asc },
    skills: { main: { tags: [] } }, damage: { primary_form: 'hit', scope: 'player' }, ...(foundation ? { foundation } : {}) }));
  card('a', 'Occultist', 95, f()); card('b', 'Chieftain', 92, f({ primary: 'regen', leech: 0 })); card('c', 'Chieftain', 40, f()); card('d', 'Occultist', 90, null);
  fs.writeFileSync(path.join(corpus, 'xml', 'd.xml'), '<PathOfBuilding/>');
  const read = () => fs.readdirSync(cards).sort().map(x => ({ ...JSON.parse(fs.readFileSync(path.join(cards, x))), _card: x }));
  let r = corpusNorms({ cards: read(), ascendancy: 'Chieftain' });
  assert.equal(r.builds_in_pool, 3); assert.equal(r.missing_foundation, 1); assert.equal(r.norms.builds, 1); assert.equal(r.small_group, true); assert.equal(r.norms_all.builds, 2);
  const b = backfillFoundations({ cards, directory: corpus, compute: () => f({ eld: 4 }) });
  assert.equal(b.backfilled, 1); assert.equal(b.already, 3);
  r = corpusNorms({ cards: read() });
  assert.equal(r.missing_foundation, 0); assert.equal(r.norms.builds, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cards, 'd.json'))).identity.level, 90);
});
