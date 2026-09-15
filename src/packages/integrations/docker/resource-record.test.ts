import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceRecord } from './resource-record.js';
const identity = { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 };
test('resource ownership accepts equivalent configured root spellings but never normalizes a stored escape', () => {
  const record = { schema: 'agentflow-docker-resource/v1', resourceId: 'af-12345678-1234-4123-8123-123456789abc', directory: '/work/attempts/attempt-abcdef', identity };
  for (const root of ['/work/attempts', '/work/attempts/', '/work/./attempts']) assert.deepEqual(resourceRecord(record, identity, root), record);
  for (const directory of ['/work/attempts/../other/attempt-abcdef', '/work/attempts/./attempt-abcdef', '/work/other/attempt-abcdef'])
    assert.throws(() => resourceRecord({ ...record, directory }, identity, '/work/attempts/'), /INVALID_DOCKER_RESOURCE_RECORD/);
});
