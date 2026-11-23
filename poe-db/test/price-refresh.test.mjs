import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceDb, importPrices, priceQuery } from '../scripts/reference-store.mjs';
import { priceFreshness, attachFreshness, parseCategories, economyCategories, priceCommand, priceOperations, refreshPrices } from '../scripts/price-refresh.mjs';

const base = { game: 'poe1', patch: '3.30', mode: 'softcore', league: 'Covens of Umbra', platform: 'pc', source_url: 'local:test-only' };
function seeded() {
  const db = referenceDb(':memory:');
  importPrices({ ...base, category: 'Currency', observed_at: '2026-11-10T00:00:00Z', lines: [{ name: 'Divine Orb', chaosValue: 100 }] }, db);
  importPrices({ ...base, category: 'Currency', observed_at: '2026-11-20T00:00:00Z', lines: [{ name: 'Divine Orb', chaosValue: 120 }] }, db);
  importPrices({ ...base, category: 'UniqueArmour', observed_at: '2026-11-20T00:01:00Z', lines: [{ name: 'Test Armour', chaosValue: 400, divineValue: 2 }, { name: 'Cheap', chaosValue: 5, divineValue: 0.04 }] }, db);
  return db;
}

test('freshness: newest snapshot per category, stale threshold, history kept', () => {
  const db = seeded();
  try {
    const now = Date.parse('2026-11-22T00:00:00Z');
    const f = priceFreshness(db, { now, staleDays: 3 });
    const currency = f.groups.find(g => g.category === 'Currency');
    assert.equal(currency.newest_observed_at, '2026-11-20T00:00:00Z');
    assert.equal(currency.snapshots_stored, 2);
    assert.equal(currency.age_days, 2);
    assert.equal(f.stale_any, false);
    const later = priceFreshness(db, { now: Date.parse('2026-11-24T00:00:00Z'), staleDays: 3 });
    assert.equal(later.stale_any, true);
    assert.equal(later.stale_categories.length, 2);
    assert.match(later.warning, /older than 3 days/);
    assert.equal(priceFreshness(db, { now: Date.parse('2026-11-24T00:00:00Z'), staleDays: 7 }).stale_any, false);
    assert.throws(() => priceFreshness(db, { staleDays: 0 }), /positive/);
  } finally { db.close(); }
});

test('freshness reports inconsistent_currency_conversion without merging rates', () => {
  const db = seeded();
  try {
    const c = priceFreshness(db, { now: Date.parse('2026-11-21T00:00:00Z') }).currency_conversion;
    assert.equal(c.code, 'inconsistent_currency_conversion');
    const armour = c.categories.find(x => x.category === 'UniqueArmour');
    assert.equal(armour.item_implied_chaos_per_divine_median, 200);
    assert.equal(armour.currency_feed_chaos_per_divine, 120);
    assert.equal(armour.compared_lines, 1);
  } finally { db.close(); }
});

test('attachFreshness marks quotes and empty database is stale', () => {
  const db = seeded();
  try {
    const f = priceFreshness(db, { now: Date.parse('2026-11-30T00:00:00Z') });
    const quoted = attachFreshness(priceQuery('get', 'Test Armour', db), f);
    assert.equal(quoted.results[0].freshness.stale, true);
    assert.equal(quoted.results[0].freshness.quote_is_latest_snapshot, true);
    assert.equal(quoted.stale_any, true);
  } finally { db.close(); }
  const empty = referenceDb(':memory:');
  try { assert.equal(priceFreshness(empty).stale_any, true); } finally { empty.close(); }
});

test('categories and CLI routing are validated', async () => {
  assert.deepEqual(parseCategories(undefined), economyCategories);
  assert.deepEqual(parseCategories('SkillGem,Currency'), ['Currency', 'SkillGem']);
  assert.throws(() => parseCategories('Rares'), /Unknown categories/);
  assert.throws(() => priceCommand(['get', 'x']), /status/);
  assert.deepEqual([...priceOperations], ['status', 'refresh']);
  const db = seeded();
  try {
    const plan = await refreshPrices({ dryRun: true, categories: ['Currency'], db });
    assert.equal(plan.network_used, false);
    assert.equal(plan.plan.length, 2);
  } finally { db.close(); }
});

test('refresh stops clearly when the league id is not advertised (stubbed source, no network)', async () => {
  const db = seeded();
  try {
    const source = async () => ({ bytes: Buffer.from(JSON.stringify([{ id: 'Covens2', name: 'Covens2' }])), metadata: { url: 'stub', sha256: 'x' }, cache_hit: false });
    const r = await refreshPrices({ db, source, delayMs: 0 });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].error, /not in the advertised/);
    assert.equal(r.errors[0].advertised[0].id, 'Covens2');
    assert.equal(r.added_snapshots, 0);
  } finally { db.close(); }
});
