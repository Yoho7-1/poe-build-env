import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { referenceDb, importPrices } from '../scripts/reference-store.mjs';
import { priceContext, quoteComponent, quoteBundle, rareAffixScore, clusterBaseType, lineConfidence, networkPlan, KIND_CATEGORIES } from '../scripts/prices-model.mjs';

const OBSERVED = '2026-11-23T22:15:00.000Z';
const NOW = Date.parse('2026-11-24T10:00:00.000Z');

function snapshot(category, lines, observed_at = OBSERVED) {
  return { game: 'poe1', patch: '3.30', mode: 'softcore', league: 'Covens of Umbra', platform: 'pc', category, observed_at,
    source_url: 'local:test/prices-model', lines };
}

function fixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prices-model-')), 'workbench.sqlite');
  const db = referenceDb(file);
  importPrices(snapshot('Currency', [{ name: 'Divine Orb', chaosValue: 190 }]), db);
  importPrices(snapshot('UniqueAccessory', [
    { name: 'Test Amulet', chaosValue: 1900, divineValue: 10, count: 40 },
    { name: 'Test Amulet', chaosValue: 3800, divineValue: 20, count: 2, corrupted: true },
  ]), db);
  importPrices(snapshot('ClusterJewel', [
    { name: 'Widespread Destruction', chaosValue: 50, divineValue: 0.26, count: 120, baseType: 'Large Cluster Jewel', variant: '8 passives', levelRequired: 75 },
    { name: 'Other Notable', chaosValue: 150, divineValue: 0.8, count: 30, baseType: 'Large Cluster Jewel', variant: '8 passives', levelRequired: 75 },
    { name: 'Small Thing', chaosValue: 10, divineValue: 0.05, count: 8, baseType: 'Small Cluster Jewel', variant: '2 passives', levelRequired: 54 },
  ]), db);
  importPrices(snapshot('BaseType', [
    { name: 'Test Regalia', chaosValue: 10, divineValue: 0.05, count: 70, levelRequired: 86 },
    { name: 'Test Regalia', chaosValue: 120, divineValue: 0.63, count: 1, variant: 'Redeemer', levelRequired: 84 },
  ]), db);
  db.close();
  return { file, cleanup: () => fs.rmSync(path.dirname(file), { recursive: true, force: true }) };
}

function withContext(run) {
  const { file, cleanup } = fixture();
  const db = referenceDb(file, { readOnly: true });
  try { run(priceContext({ db, now: NOW })); } finally { db.close(); cleanup(); }
}

test('categories cover uniques, gems, currency, clusters and rare bases only', () => {
  assert.deepEqual(KIND_CATEGORIES.cluster, ['ClusterJewel']);
  assert.deepEqual(KIND_CATEGORIES.rare, ['BaseType']);
  assert.equal(networkPlan().network_used, false);
  assert.ok(networkPlan().user_decisions.some(d => /profile\.platform/.test(d)));
});

test('unique with a priced line is exact, with date, source, platform and confidence', () => withContext(ctx => {
  const q = quoteComponent({ kind: 'unique', name: 'Test Amulet' }, ctx);
  assert.equal(q.cost_class, 'exact');
  assert.equal(q.chaos, 1900);
  assert.equal(q.divine, 10);
  assert.equal(q.date, OBSERVED);
  assert.equal(q.platform, 'pc');
  assert.equal(q.confidence, 'high');
  assert.match(q.source, /UniqueAccessory snapshot/);
  // The corrupted variant is a different, dearer line and is reachable by filter.
  assert.equal(quoteComponent({ kind: 'unique', name: 'Test Amulet', corrupted: true }, ctx).chaos, 3800);
  assert.equal(quoteComponent({ kind: 'unique', name: 'Test Amulet', corrupted: true }, ctx).confidence, 'low');
}));

test('missing data is unknown, never zero', () => withContext(ctx => {
  const q = quoteComponent({ kind: 'unique', name: 'No Such Unique' }, ctx);
  assert.equal(q.cost_class, 'unknown');
  assert.equal(q.chaos, null);
  assert.equal(q.confidence, null);
  assert.equal(q.warnings[0].code, 'no_price_data');
}));

test('cluster jewel: exact by enchant and passive count, group median otherwise', () => withContext(ctx => {
  const exact = quoteComponent({ kind: 'cluster', size: 'Large', passives: 8, enchant: 'Widespread Destruction' }, ctx);
  assert.equal(exact.cost_class, 'exact');
  assert.equal(exact.chaos, 50);
  assert.equal(exact.category, 'ClusterJewel');
  const estimated = quoteComponent({ kind: 'cluster', size: 'Large', passives: 8, enchant: 'Unpriced Notable' }, ctx);
  assert.equal(estimated.cost_class, 'estimated');
  assert.equal(estimated.chaos, 100); // median of 50 and 150 on the same base and passive count
  assert.deepEqual(estimated.chaos_range, [50, 150]);
  assert.equal(estimated.warnings[0].code, 'enchant_not_priced');
  assert.equal(clusterBaseType({ size: 'medium' }), 'Medium Cluster Jewel');
  assert.equal(clusterBaseType({ size: 'something' }), null);
}));

test('rare: dated base price times a stated affix band, always estimated', () => withContext(ctx => {
  const plain = rareAffixScore({ count: 0 });
  assert.equal(plain.band, 'base_only');
  const hard = rareAffixScore({ t1: 3, t1_t2: 4, count: 6, fractured: 1, influence: 1 });
  assert.equal(hard.parts.t2, 1);
  assert.equal(hard.parts.other, 2);
  assert.equal(hard.score, 3 * 3 + 2 + 2 + 2 + 1);
  assert.equal(hard.band, 'extreme');

  const q = quoteComponent({ kind: 'rare', base: 'Test Regalia', item_level: 86, affixes: { t1: 1, t1_t2: 2, count: 4 } }, ctx);
  assert.equal(q.cost_class, 'estimated');
  assert.equal(q.confidence, 'low');
  assert.equal(q.base_price_chaos, 10); // ilvl 86 line, no influence asked
  assert.equal(q.affix_band.band, 'moderate');
  assert.deepEqual(q.chaos_range, [50, 250]);
  assert.equal(q.method, 'rule:affix_tier_band_over_base_price');
  assert.ok(q.warnings.some(w => w.code === 'rare_price_modelled'));
  // Influence variant is a different base line.
  assert.equal(quoteComponent({ kind: 'rare', base: 'Test Regalia', item_level: 86, influence: 'Redeemer', affixes: {} }, ctx).base_price_chaos, 120);
  // Unknown base: the affix band alone gives no currency value.
  const none = quoteComponent({ kind: 'rare', base: 'Unknown Base', affixes: { t1: 2 } }, ctx);
  assert.equal(none.cost_class, 'unknown');
  assert.equal(none.chaos, null);
  assert.equal(none.affix_band.band, 'moderate'); // score 6 from two T1 affixes
}));

test('bundle keeps exact, estimated and unknown apart', () => withContext(ctx => {
  const b = quoteBundle([
    { kind: 'unique', name: 'Test Amulet' },
    { kind: 'cluster', size: 'Large', passives: 8, enchant: 'Widespread Destruction' },
    { kind: 'rare', base: 'Test Regalia', item_level: 86, affixes: { t1: 1, t1_t2: 2, count: 4 } },
    { kind: 'unique', name: 'No Such Unique' },
  ], ctx);
  assert.equal(b.exact.count, 2);
  assert.equal(b.exact.chaos, 1950);
  assert.equal(b.estimated.count, 1);
  assert.deepEqual(b.estimated.chaos_range, [50, 250]);
  assert.equal(b.unknown.count, 1);
  assert.deepEqual(b.unknown.components, ['No Such Unique']);
  assert.equal(b.oldest_snapshot_at, OBSERVED);
  assert.ok(!('total' in b));
}));

test('conflicting chaos/divine rates suppress the divine total', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-model-conflict-'));
  const file = path.join(dir, 'workbench.sqlite');
  const write = referenceDb(file);
  // Currency feed says 116 chaos per divine, the item feed implies 190: the project's known conflict.
  importPrices(snapshot('Currency', [{ name: 'Divine Orb', chaosValue: 116 }]), write);
  importPrices(snapshot('UniqueAccessory', [{ name: 'Test Amulet', chaosValue: 1900, divineValue: 10, count: 40 }]), write);
  write.close();
  const db = referenceDb(file, { readOnly: true });
  try {
    const ctx = priceContext({ db, now: NOW });
    assert.ok(ctx.inconsistent_categories.has('UniqueAccessory'));
    const b = quoteBundle([{ kind: 'unique', name: 'Test Amulet' }], ctx);
    assert.equal(b.exact.chaos, 1900);
    assert.equal(b.exact.divine, null);
    assert.equal(b.conversion.code, 'inconsistent_currency_conversion');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stale snapshots cannot be high confidence', () => {
  assert.equal(lineConfidence({ variant: { count: 40 } }, { stale: false }), 'high');
  assert.equal(lineConfidence({ variant: { count: 40 } }, { stale: true }), 'medium');
  assert.equal(lineConfidence({ variant: {} }, { stale: false }), 'low');
});
