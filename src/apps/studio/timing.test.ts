import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTimeline } from './timing.js';
import { attemptDuration, duration, fileGroup, isRecruitmentOutput, previewKind, timestamp, clockTime } from './client/presentation.js';

const identity = (task = 'task-1', attempt = 1) => ({ runId: 'run', nodeTaskId: task, attemptId: `attempt-${attempt}`, attemptNumber: attempt });
const row = (revision: number, time: number | null, attempts: any[], status = 'running') => ({ runId: 'run', revision, sequence: revision, recordedAt: time,
  content: { snapshot: { runId: 'run', currentNode: 'build', currentIdentity: status === 'running' ? attempts.at(-1)?.identity : null, status, steps: [] }, attempts } }) as any;
test('timing keeps logical attempt boundaries separate from container execution, retry and rework', () => {
  const a = { node: 'build', identity: identity(), resultStep: null }, b = { ...a, identity: identity('task-1', 2) }, c = { ...a, identity: identity('task-2') };
  const rows = [row(1, 1000, [a]), row(2, 1200, [{ ...a, retry: true }], 'retry_wait'),
    row(3, 1800, [{ ...a, retry: true }, b]), row(4, 2200, [{ ...a, retry: true }, { ...b, resultStep: 0 }, c]),
    row(5, 2600, [{ ...a, retry: true }, { ...b, resultStep: 0 }, { ...c, resultStep: 1 }], 'succeeded')];
  const events = [{ sequence: 1, runId: 'run', recordedAt: 2190, content: { kind: 'execution', identity: b.identity, runner: { startedAt: 1900, finishedAt: 2150 } } }] as any;
  const result = projectTimeline(rows, events);
  assert.deepEqual(result.attempts.map(a => [a.startedAt, a.finishedAt]), [[1000, 1200], [1800, 2200], [2200, 2600]]);
  assert.deepEqual(result.attempts[1]!.execution, [{ startedAt: 1900, finishedAt: 2150 }]);
  const past = projectTimeline(rows, events, 1850);
  assert.equal(past.attempts.length, 2); assert.equal(past.attempts[1]!.finishedAt, null); assert.deepEqual(past.attempts[1]!.execution, []);
  assert.equal(past.finishedAt, null);
  assert.equal(attemptDuration(past.attempts[1], past.updatedAt), '已用 0 毫秒');
  assert.equal(attemptDuration(result.attempts[1], result.updatedAt), '400 毫秒');
});
test('missing legacy timestamps and reversed clocks never become invented or negative durations', () => {
  const ended = { node: 'build', identity: identity(), resultStep: 0 };
  const legacy = projectTimeline([row(9, null, [ended], 'succeeded')], []);
  assert.equal(legacy.attempts[0]!.startedAt, null); assert.equal(legacy.attempts[0]!.finishedAt, null);
  assert.equal(duration(null, 100), '未记录'); assert.equal(duration(200, 100), '时钟异常'); assert.equal(duration(0, 0), '0 毫秒');
  assert.match(timestamp(1789539862870), /2026.*09.*16.*\d{2}:\d{2}:\d{2}\.870/);
  assert.match(clockTime(1789539862870), /\d{2}:\d{2}:\d{2}\.870/);
  assert.equal(projectTimeline([row(9, null, [ended], 'succeeded')], [], 5000).revisions.length, 0);
});
test('arbitrary workflows and source files use generic presentation with identity-based grouping', () => {
  assert.equal(isRecruitmentOutput('code-generation', { recommendations: [], candidates: [], requirements: [], documents: [] }), false);
  assert.equal(isRecruitmentOutput('recruitment', { recommendations: [{}], candidates: [], requirements: [], documents: [] }), false);
  assert.equal(previewKind({ name: 'analysis.py', mediaType: 'application/octet-stream' }), 'code');
  assert.equal(previewKind({ name: 'custom.pdf', mediaType: 'application/pdf' }), 'pdf');
  assert.equal(previewKind({ name: 'model.bin', mediaType: 'application/octet-stream' }), 'binary');
  const f = (node: string, attemptNumber: number) => ({ runId: 'run', name: 'result.json', sources: [{ node, runId: 'run', nodeTaskId: 'task-1', attemptNumber, role: 'output' }] }) as any;
  assert.notEqual(fileGroup(f('build', 1), []).key, fileGroup(f('build', 2), []).key);
  assert.notEqual(fileGroup(f('build', 1), []).key, fileGroup(f('verify', 1), []).key);
});
