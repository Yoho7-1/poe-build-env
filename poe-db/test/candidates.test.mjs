import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalTypeExpression, supportCompatible, parseSockets, slugId, parseUniqueRaw, uniqueItemText, withAnoint, currentAnoint, choosePriceRow, normalizeSlot,
  generateSupportCandidates, generateUniqueCandidates, generateAnointCandidates, candidatesCommand, candidatesHelp, analyzeAutoUpgrades } from '../scripts/analysis-candidates.mjs';
import { validateCandidateFile } from '../scripts/analysis-upgrades.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fireball-control.xml', import.meta.url));

test('type expressions follow PoB RPN semantics', () => {
  const t = new Set(['Spell', 'Projectile']);
  assert.equal(evalTypeExpression(['Spell'], t), true);
  assert.equal(evalTypeExpression(['Attack'], t), false);
  assert.equal(evalTypeExpression(['Attack', 'Spell', 'OR'], t), true);
  assert.equal(evalTypeExpression(['Attack', 'Spell', 'AND'], t), false);
  assert.equal(evalTypeExpression(['Spell', 'Minion', 'NOT', 'AND'], t), true);
  assert.equal(evalTypeExpression(['Spell', 'Projectile', 'NOT', 'AND'], t), false);
  // Any true value left on the stack matches (list of alternatives).
  assert.equal(evalTypeExpression(['Attack', 'Projectile'], t), true);
});

test('support prefilter: excluded types win, required types must match, gem-only supports', () => {
  const t = new Set(['Spell', 'Multicastable']);
  assert.equal(supportCompatible({ support_gem: { allowed_types: ['Multicastable'], excluded_types: ['Triggered'] } }, t).ok, true);
  assert.equal(supportCompatible({ support_gem: { allowed_types: ['Multicastable'], excluded_types: ['Spell'] } }, t).reason, 'excluded_type');
  assert.equal(supportCompatible({ support_gem: { allowed_types: ['Attack'] } }, t).reason, 'required_type_missing');
  assert.equal(supportCompatible({ support_gem: { allowed_types: null, supports_gems_only: true } }, t, { fromGem: false }).reason, 'supports_gems_only');
  assert.equal(supportCompatible({}, t).ok, false);
});

test('sockets, ids and slots', () => {
  assert.deepEqual(parseSockets('R-G-G B-B G'), { total: 6, largest_link: 3 });
  assert.equal(parseSockets(null), null);
  assert.equal(slugId('uniq', "Atziri's Splendour", 'v3'), 'uniq-atziri-s-splendour-v3');
  assert.ok(slugId('sup', 'x'.repeat(100)).length <= 64);
  assert.equal(normalizeSlot('ring'), 'Ring 1');
  assert.equal(normalizeSlot('body armour'), 'Body Armour');
  assert.throws(() => normalizeSlot('Pocket'), /Unknown slot/);
});

test('unique raw text: legacy variants dropped, explicit variant selection', () => {
  const raw = 'Crown of Eyes\nHubris Circlet\nVariant: Pre 3.7.0\nVariant: Current\n{variant:1}+(200-250) to Accuracy Rating\n{variant:2}+(300-350) to Accuracy Rating\nAttacks have 150% Arcane Might';
  const u = parseUniqueRaw(raw);
  assert.equal(u.name, 'Crown of Eyes');
  assert.equal(u.base, 'Hubris Circlet');
  assert.deepEqual(u.current, [{ index: 2, name: 'Current' }]);
  const text = uniqueItemText(raw, 2).split('\n');
  assert.deepEqual(text.slice(0, 4), ['Rarity: UNIQUE', 'Crown of Eyes', 'Hubris Circlet', 'Selected Variant: 2']);
  assert.ok(!uniqueItemText(raw).includes('Selected Variant'));
});

test('anoint line is replaced or inserted with the implicit count updated', () => {
  const withOld = 'Rarity: RARE\nX\nAgate Amulet\nImplicits: 2\n{crafted}Allocates Potency of Will\n+20 to Strength and Intelligence\n+10 to Strength';
  assert.equal(currentAnoint(withOld), 'Potency of Will');
  const a = withAnoint(withOld, 'Whispers of Doom');
  assert.match(a, /\{crafted\}Allocates Whispers of Doom/);
  assert.match(a, /Implicits: 2/);
  const plain = 'Rarity: RARE\nX\nAgate Amulet\nImplicits: 1\n+20 to Strength and Intelligence';
  const b = withAnoint(plain, 'Whispers of Doom').split('\n');
  assert.deepEqual(b.slice(3, 5), ['Implicits: 2', '{crafted}Allocates Whispers of Doom']);
  assert.equal(withAnoint('Rarity: RARE\nX\nAgate Amulet', 'Y'), null);
});

test('price rows: exact gem level/quality only, unique variants never merged', () => {
  const gems = [{ variant: { variant: '20/20', gemLevel: 20, gemQuality: 20 } }, { variant: { variant: '21/20c', gemLevel: 21, gemQuality: 20, corrupted: true } }, { variant: { variant: '3', gemLevel: 3 } }];
  assert.deepEqual(choosePriceRow(gems, { gemLevel: 20, gemQuality: 20 }), { status: 'matched', variant: '20/20' });
  assert.equal(choosePriceRow(gems, { gemLevel: 3, gemQuality: 0 }).variant, '3');
  const miss = choosePriceRow(gems, { gemLevel: 3, gemQuality: 20 });
  assert.equal(miss.status, 'no_exact_variant');
  assert.deepEqual(miss.nearest, ['3']);
  assert.equal(choosePriceRow([], { gemLevel: 20 }).status, 'no_observation');
  const one = [{ variant: { baseType: 'Heavy Belt' } }];
  assert.equal(choosePriceRow(one, { itemVariants: 1 }).status, 'matched');
  assert.equal(choosePriceRow(one, { itemVariants: 3, variantName: 'Current' }).status, 'variant_not_distinguished_in_price_data');
  const named = [{ variant: { variant: '2 Flasks' } }, { variant: { variant: '3 Flasks' } }];
  assert.deepEqual(choosePriceRow(named, { variantName: '3 flasks' }), { status: 'matched', variant: '3 Flasks' });
  assert.equal(choosePriceRow(named, { variantName: 'Current' }).status, 'variant_required');
});

test('support generation for the Fireball fixture is type-filtered and file-valid', () => {
  const gen = generateSupportCandidates({ file: fixture });
  assert.equal(gen.target.mode, 'add');
  assert.ok(gen.active_skill.types.includes('Spell'));
  const names = gen.candidates.map(c => c.generated.support);
  for (const n of ['Spell Echo', 'Controlled Destruction', 'Awakened Spell Echo']) assert.ok(names.includes(n), n);
  for (const n of ['Melee Physical Damage', 'Multistrike', 'Minion Damage']) assert.ok(!names.includes(n), n);
  assert.ok(gen.excluded.some(e => e.name === 'Melee Physical Damage' && e.reason === 'required_type_missing'));
  validateCandidateFile({ candidates: gen.candidates });
  assert.equal(new Set(gen.candidates.map(c => c.id)).size, gen.candidates.length);
  const echo = gen.candidates.find(c => c.generated.support === 'Spell Echo');
  assert.deepEqual(echo.changes, { skills: { groups: [{ group: 1, add_gems: [{ name: 'Spell Echo', level: 20, quality: 20 }] }] } });
  assert.ok(generateSupportCandidates({ file: fixture, excludeAwakened: true }).candidates.every(c => !c.generated.awakened));
  assert.throws(() => generateSupportCandidates({ file: fixture, replace: '1' }), /index of a support gem/);
});

test('unique generation: catalog-gated, PoB text, current variants only', () => {
  const gen = generateUniqueCandidates({ file: fixture, slot: 'Helmet' });
  assert.ok(gen.candidates.length > 50);
  validateCandidateFile({ candidates: gen.candidates });
  for (const c of gen.candidates) {
    assert.equal(c.changes.replace_items[0].slot, 'Helmet');
    assert.match(c.changes.replace_items[0].text, /^Rarity: UNIQUE\n/);
    assert.ok(!/^Pre \d/.test(c.generated.pob_variant ?? ''));
    if (c.price) assert.equal(c.price.name, c.generated.name);
  }
  const eyes = gen.candidates.filter(c => c.generated.name === 'Crown of Eyes');
  assert.equal(eyes.length, 1);
  assert.match(eyes[0].changes.replace_items[0].text, /Selected Variant: 2/);
  assert.ok(generateUniqueCandidates({ file: fixture, slot: 'Amulet', search: 'Astramentis' }).candidates.every(c => c.generated.name === 'Astramentis'));
});

test('anoint generation without an amulet uses custom Allocates lines; CLI plan and help', () => {
  const gen = generateAnointCandidates({ file: fixture, search: 'Whispers of Doom' });
  assert.equal(gen.mode, 'custom_mods');
  assert.deepEqual(gen.candidates.map(c => c.changes), [{ custom_mods: 'Allocates Whispers of Doom' }]);
  const plan = candidatesCommand([fixture, '--kind', 'supports', '--search', 'echo', '--plan']);
  assert.ok(plan.total >= 2 && plan.candidates.every(c => c.id.startsWith('sup-')));
  assert.throws(() => candidatesCommand([fixture, '--plan']), /--kind/);
  assert.throws(() => candidatesCommand([fixture, '--kind', 'clusters', '--plan']), /--kind supports/);
  assert.ok(Object.keys(candidatesHelp).some(k => k.startsWith('analyze candidates')));
});

test('engine: generated supports apply and generated unique text parses', { skip: process.platform !== 'win32' }, () => {
  const sup = analyzeAutoUpgrades({ file: fixture, kind: 'supports', search: 'spell echo', excludeAwakened: true, concurrency: 2 });
  assert.ok(sup.ranking.length >= 1);
  for (const r of sup.ranking) {
    assert.equal(r.verification.status, 'applied');
    assert.ok(r.deltas.dps.pct > 0);
  }
  const uni = analyzeAutoUpgrades({ file: fixture, kind: 'uniques', slot: 'Helmet', search: 'Crown of Eyes', concurrency: 1 });
  assert.equal(uni.ranking.length, 1);
  assert.equal(uni.ranking[0].verification.status, 'parsed');
  assert.match(uni.ranking[0].verification.equipped, /^Crown of Eyes/);
});
