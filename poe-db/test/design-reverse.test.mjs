import test from 'node:test';
import assert from 'node:assert/strict';
import { reverseSearch } from '../scripts/design-reverse.mjs';

test('reverse search finds independent sources of a goal across tree, pantheon, flasks and uniques', () => {
  const r = reverseSearch({ pattern: 'avoid being frozen|immun\w* to freeze', prices: false, top: 50 });
  assert.ok(r.paths.tree?.top.some(x => /Avoid being Frozen/i.test(x.match[0])));
  assert.ok(r.paths.pantheon?.top.some(x => x.god === 'TheBrineKing'));
  assert.ok(r.paths.flask_mod?.count > 0);
  assert.ok(r.paths.unique?.count > 0);
  assert.throws(() => reverseSearch({ pattern: '' }), /goal pattern required/);
});
