import test from 'node:test';
import assert from 'node:assert/strict';
import { agent, groupHelp, errorCode } from '../scripts/agent.mjs';

test('--help returns the command group, narrowed to an operation when given', () => {
  const analyze = agent(['analyze', '--help']);
  assert.equal(analyze.command, 'analyze');
  assert.ok(Object.keys(analyze.commands).length > 10);
  assert.ok(Object.keys(analyze.commands).every(k => k.startsWith('analyze')));
  const ablate = agent(['analyze', 'ablate', '-h']);
  assert.deepEqual(Object.keys(ablate.commands).map(k => k.split(' ')[1]), ['ablate']);
  assert.ok(Object.keys(agent(['lab', '--help']).commands).length >= 5);
  assert.ok(Object.keys(groupHelp('build', ['show']).commands).every(k => k.includes('show')));
  // Unknown operation falls back to the whole group; unknown command is a usage error.
  assert.ok(Object.keys(groupHelp('build', ['zzz']).commands).length >= 3);
  assert.throws(() => agent(['nope', '--help']), /Unknown command/);
});

test('error codes classify CLI failures', () => {
  assert.equal(errorCode('Revision conflict: H-001 is at revision 3'), 'conflict');
  assert.equal(errorCode('Record H-999 not found'), 'not_found');
  assert.equal(errorCode('Unknown option --x'), 'usage');
  assert.equal(errorCode('--expected-revision N required'), 'usage');
  assert.equal(errorCode('Change error: passive budget exceeded'), 'engine');
  assert.equal(errorCode('generalized needs supporting evidence from at least two different builds (transfer)'), 'gate');
  assert.equal(errorCode('something else'), 'error');
});

test('help is a compact group index; --full keeps every entry', () => {
  const index = agent(['help']);
  assert.ok(JSON.stringify(index).length < 3000);
  assert.match(index.groups.lab, /\bevidence\b/);
  assert.match(index.groups.pob, /\brun\b/);
  assert.ok(!('commands' in index));
  assert.deepEqual(agent(['--help']), index);
});
