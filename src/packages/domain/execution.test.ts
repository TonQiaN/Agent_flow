import test from 'node:test';
import assert from 'node:assert/strict';
import { isExecutionIdentity, isIdentifier } from './index.js';

test('execution identity distinguishes valid attempt numbers from absent or invalid values', () => {
  const base = { runId: 'r-1', nodeTaskId: 'task:gate', attemptId: 'a-1', attemptNumber: 1 };
  assert.equal(isExecutionIdentity(base), true);
  for (const attemptNumber of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined]) {
    assert.equal(isExecutionIdentity({ ...base, attemptNumber }), false);
  }
  for (const id of ['', 'has space', 'id\n', '../path', 'x'.repeat(129), null, 3]) assert.equal(isIdentifier(id), false);
});
