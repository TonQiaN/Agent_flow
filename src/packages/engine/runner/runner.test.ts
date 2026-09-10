import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../index.js';
import type { Clock, ExecutionBackend, ExecutionResource, RunnerRequest, Observation, RawCapture } from '../index.js';

const request: RunnerRequest = { identity: { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 },
  inputSource: 'opaque-input', invocation: { argv: ['script'] }, timeoutMs: 100 };
const resource: ExecutionResource = { id: 'resource' };
class Backend implements ExecutionBackend {
  calls: string[] = [];
  observation: Observation = { state: 'exited', exitCode: 0 };
  failure: string | null = null;
  stopped = true;
  onCreate = () => {};
  call(name: string) { this.calls.push(name); if (this.failure === name) throw new Error('private-value'); }
  async allocate() { this.call('allocate'); return resource; }
  async prepare() { this.call('prepare'); }
  async create() { this.call('create'); this.onCreate(); }
  async start() { this.call('start'); }
  async observe() { this.call('observe'); return this.observation; }
  async stop() { this.call('stop'); return { confirmed: this.stopped }; }
  async capture(): Promise<RawCapture> { this.call('capture'); return { stdout: { path: 'stdout', bytes: 0, truncated: false, complete: true },
    stderr: { path: 'stderr', bytes: 0, truncated: false, complete: true }, files: {}, outputsPath: 'outputs', imageId: 'image' }; }
  async remove() { this.call('remove'); }
  async release() { this.call('release'); }
}
function fixture() {
  const backend = new Backend();
  let time = 0;
  const clock: Clock = { now: () => time, sleep: async ms => { time += ms; } };
  return { backend, runner: new Runner(backend, clock) };
}

test('natural exit is a process fact, including nonzero, and capture precedes removal', async () => {
  const { backend, runner } = fixture();
  backend.observation = { state: 'exited', exitCode: 7 };
  const result = await runner.run(request);
  assert.equal(result.phase, 'exited');
  assert.equal(result.exitCode, 7);
  assert.equal(result.stop, 'confirmed');
  assert.equal(result.cleanup, 'removed');
  assert.deepEqual(backend.calls, ['allocate', 'prepare', 'create', 'start', 'observe', 'capture', 'remove']);
  await runner.release(resource);
  assert.equal(backend.calls.at(-1), 'release');
});

test('pre-start cancellation allocates nothing; cancellation during create never starts', async () => {
  const before = fixture();
  const early = await before.runner.run(request, { requested: () => true });
  assert.equal(early.phase, 'cancelled');
  assert.equal(early.stop, 'not_started');
  assert.deepEqual(before.backend.calls, []);
  const { backend, runner } = fixture();
  let cancelled = false;
  backend.onCreate = () => { cancelled = true; };
  const result = await runner.run(request, { requested: () => cancelled });
  assert.equal(result.phase, 'cancelled');
  assert.ok(!backend.calls.includes('start'));
  assert.deepEqual(backend.calls.slice(-3), ['stop', 'capture', 'remove']);
});

test('timeout stops the actual backend and reports unconfirmed stop without deleting resources', async () => {
  const { backend, runner } = fixture();
  backend.observation = { state: 'running' };
  backend.stopped = false;
  const result = await runner.run(request);
  assert.equal(result.phase, 'timed_out');
  assert.equal(result.exitCode, null);
  assert.equal(result.stop, 'unknown');
  assert.equal(result.cleanup, 'blocked');
  assert.deepEqual(result.diagnostics, ['STOP_UNCONFIRMED']);
  assert.ok(backend.calls.includes('stop'));
  assert.ok(!backend.calls.includes('remove'));
});

test('failures at every lifecycle stage still preserve cleanup and never echo exception text', async () => {
  for (const stage of ['allocate', 'prepare', 'create', 'start', 'observe']) {
    const { backend, runner } = fixture();
    backend.failure = stage;
    const result = await runner.run(request);
    assert.equal(result.phase, 'failed');
    assert.ok(result.diagnostics.includes(`${stage.toUpperCase()}_FAILED`));
    assert.ok(!JSON.stringify(result).includes('private-value'));
    if (stage !== 'allocate') assert.deepEqual(backend.calls.slice(-3), ['stop', 'capture', 'remove']);
  }
});

test('capture or cleanup failures do not rewrite the original execution result', async () => {
  for (const failure of ['capture', 'remove']) {
    const { backend, runner } = fixture();
    backend.failure = failure;
    backend.observation = { state: 'exited', exitCode: 9 };
    const result = await runner.run(request);
    assert.equal(result.phase, 'exited');
    assert.equal(result.exitCode, 9);
    assert.ok(result.diagnostics.includes(failure === 'capture' ? 'CAPTURE_FAILED' : 'CLEANUP_FAILED'));
    assert.ok(backend.calls.includes('remove'));
  }
});

test('an observed natural exit wins over a cancellation arriving during observation', async () => {
  const { backend, runner } = fixture();
  let cancelled = false;
  backend.observe = async () => { cancelled = true; return { state: 'exited', exitCode: 0 }; };
  assert.equal((await runner.run(request, { requested: () => cancelled })).phase, 'exited');
});

test('invalid execution descriptions are rejected before allocating a backend resource', async () => {
  const { backend, runner } = fixture();
  for (const timeoutMs of [0, -1, 0.5, Infinity, 86_400_001]) await assert.rejects(runner.run({ ...request, timeoutMs }), /INVALID_RUNNER_REQUEST/);
  await assert.rejects(runner.run({ ...request, invocation: { argv: [] } }), /INVALID_RUNNER_REQUEST/);
  assert.deepEqual(backend.calls, []);
});
