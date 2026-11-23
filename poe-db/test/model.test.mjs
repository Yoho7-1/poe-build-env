import test from 'node:test';
import assert from 'node:assert/strict';
import { plainText, splitOptions, classifyAvailability, numeric } from '../scripts/model.mjs';

test('wiki markup preserves names, conditions, line breaks and numeric ranges', () => {
  assert.equal(plainText('Mageblood&#039;s [[Life]]&lt;br&gt;+(2-4)% while [[Leech|Leeching]]'), "Mageblood's Life\n+(2-4)% while Leeching");
});
test('random option blocks are never presented as guaranteed fixed modifiers', () => {
  const result = splitOptions('Gain 10 Life<br><table class="random-modifier-stats"><tr><th>&lt;1 random modifier&gt;</th></tr><tr><td>Gain Cold<hr>Gain Fire</td></tr></table>');
  assert.equal(result.fixed, 'Gain 10 Life');
  assert.match(result.choices[0], /Gain Cold\nGain Fire/);
  assert.match(result.choices[0], /<1 random modifier>/);
});
test('historical and future items cannot enter the current league database', () => {
  const item = { is_in_game: '1', drop_enabled: '1', class: 'Belt', release_version: '3.16.0' };
  assert.equal(classifyAvailability(item).include, true);
  assert.equal(classifyAvailability({ ...item, removal_version: '3.30.0' }).include, false);
  assert.equal(classifyAvailability({ ...item, release_version: '3.31.0' }).include, false);
  assert.equal(classifyAvailability({ ...item, drop_enabled: '0' }).include, false);
  assert.equal(classifyAvailability({ ...item, class: 'Idol' }).include, false);
});
test('unknown values remain null and zero rolls remain zero', () => {
  assert.equal(numeric(null), null);
  assert.equal(numeric(''), null);
  assert.equal(numeric('0'), 0);
  assert.equal(numeric('-0.5'), -0.5);
  assert.throws(() => numeric('not-a-number'));
});
