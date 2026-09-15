import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from './runner.js';
import { runnerLaunchStates } from './launch.js';
import type { ExecutionBackend, RunnerResourceCheckpoint, RunnerRequest, Observation, RawCapture } from './types.js';
const request: RunnerRequest = { identity: { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 }, inputSource: 'input', invocation: { argv: ['script'] }, timeoutMs: 100 };
class Backend implements ExecutionBackend {
  calls: string[] = []; state: Observation = { state: 'exited', exitCode: 0 }; stopConfirmed = true; removeFails = false; releaseFails = false;
  async definition() { this.calls.push('definition'); return { version: 1 }; }
  async allocate() { this.calls.push('allocate'); return { id: 'resource' }; }
  async snapshotResource() { this.calls.push('snapshot'); return { owned: true }; }
  async restoreResource() { this.calls.push('restore'); return { id: 'resource' }; }
  async prepare() { this.calls.push('prepare'); }
  async create() { this.calls.push('create'); }
  async start() { this.calls.push('start'); }
  async observe() { this.calls.push('observe'); return this.state; }
  async stop() { this.calls.push('stop'); return { confirmed: this.stopConfirmed }; }
  async remove() { this.calls.push('remove'); if (this.removeFails) throw new Error('private'); this.state = { state: 'absent' }; }
  async release() { this.calls.push('release'); if (this.releaseFails) throw new Error('private'); }
  async capture(): Promise<RawCapture> { this.calls.push('capture'); return { stdout: { path: '', bytes: 0, truncated: false, complete: true }, stderr: { path: '', bytes: 0, truncated: false, complete: true }, files: {}, outputsPath: '', imageId: null }; }
}
const clock = { now: () => 0, sleep: async () => {} };
const checkpoint = (): RunnerResourceCheckpoint => ({ schema: 'agentflow-runner-resource/v1', identity: structuredClone(request.identity), resource: { id: 'resource' }, execution: { version: 1 }, backend: { owned: true } });

test('launch journal completes each durable write before its backend operation or successor', async () => {
  const backend = new Backend();
  const result = await new Runner(backend, clock).run(request, undefined, { save: async () => { backend.calls.push('save'); },
    launch: async state => { await Promise.resolve(); backend.calls.push(state); } });
  assert.equal(result.phase, 'exited');
  assert.deepEqual(backend.calls.slice(0, 14), ['definition', 'allocate', 'snapshot', 'save', 'prepare_pending', 'prepare', 'prepare_completed',
    'create_pending', 'create', 'create_completed', 'start_pending', 'start', 'observe', 'start_completed']);
});
test('asynchronous start remains pending while observation still reports created', async () => {
  const backend = new Backend(), states: string[] = []; let observations = 0;
  backend.observe = async () => {
    assert.equal(states.at(-1), 'start_pending');
    return ++observations < 3 ? { state: 'created' } : { state: 'exited', exitCode: 0 };
  };
  const result = await new Runner(backend, clock).run(request, undefined, { save: async () => {}, launch: async state => { states.push(state); } });
  assert.equal(result.phase, 'exited'); assert.equal(observations, 3); assert.equal(states.at(-1), 'start_completed');
});
test('each rejected launch write blocks its operation or successor and preserves ordinary cleanup', async () => {
  for (const failed of runnerLaunchStates.slice(1)) {
    const backend = new Backend();
    const result = await new Runner(backend, clock).run(request, undefined, { save: async () => {}, launch: async state => { if (state === failed) throw new Error('CAS lost'); } });
    assert.equal(result.phase, 'failed'); assert.ok(result.diagnostics.includes('RESOURCE_PERSISTENCE_FAILED'));
    const operations = ['prepare', 'create', 'start'];
    const index = operations.indexOf(failed.split('_')[0]!);
    assert.deepEqual(backend.calls.filter(x => operations.includes(x)), operations.slice(0, index + (failed.endsWith('_completed') ? 1 : 0)));
    assert.equal(result.stop, 'confirmed'); assert.equal(result.cleanup, 'removed');
  }
});
test('a thrown backend operation never acquires a completed journal state', async () => {
  for (const operation of ['prepare', 'create', 'start'] as const) {
    const backend = new Backend(), states: string[] = [];
    backend[operation] = async () => { backend.calls.push(operation); throw new Error('ambiguous operation'); };
    const result = await new Runner(backend, clock).run(request, undefined, { save: async () => {}, launch: async state => { states.push(state); } });
    assert.equal(states.at(-1), `${operation}_pending`); assert.ok(result.diagnostics.includes(`${operation.toUpperCase()}_FAILED`));
    assert.equal(result.cleanup, 'removed');
  }
});
test('cancellation while a launch write waits does not issue that operation after the write completes', async () => {
  const backend = new Backend(); let cancelled = false;
  const result = await new Runner(backend, clock).run(request, { requested: () => cancelled }, { save: async () => {},
    launch: async state => { if (state === 'create_pending') { await Promise.resolve(); cancelled = true; } } });
  assert.equal(result.phase, 'cancelled'); assert.equal(backend.calls.includes('create'), false); assert.equal(backend.calls.includes('start'), false);
});

test('resource save precedes preparation and process creation, and receives independent actual facts', async () => {
  const backend = new Backend(); let saved: RunnerResourceCheckpoint | undefined;
  const result = await new Runner(backend, clock).run(request, undefined, { save: async value => {
    backend.calls.push('save'); saved = structuredClone(value); (value.identity as any).runId = 'mutated';
    assert.deepEqual(backend.calls, ['definition', 'allocate', 'snapshot', 'save']);
  } });
  assert.deepEqual(saved, checkpoint()); assert.equal(result.identity.runId, 'run'); assert.equal(result.phase, 'exited');
  assert.ok(backend.calls.indexOf('prepare') > backend.calls.indexOf('save'));
});
test('failed resource persistence never prepares, creates or starts and retains cleanup facts', async () => {
  const backend = new Backend();
  const result = await new Runner(backend, clock).run(request, undefined, { save: async () => { throw new Error('private'); } });
  assert.equal(result.phase, 'failed'); assert.deepEqual(result.diagnostics, ['RESOURCE_PERSISTENCE_FAILED']);
  assert.equal(result.cleanup, 'removed'); assert.equal(backend.calls.includes('prepare'), false); assert.equal(backend.calls.includes('create'), false); assert.equal(backend.calls.includes('start'), false);
});
test('unavailable descriptors refuse persistent execution before allocation but ordinary execution stays available', async () => {
  const backend: ExecutionBackend = new Backend(); delete (backend as any).definition;
  Object.defineProperty(backend, 'definition', { value: undefined });
  const result = await new Runner(backend, clock).run(request, undefined, { save: async () => assert.fail() });
  assert.equal(result.resource, null); assert.equal(result.phase, 'failed');
  assert.equal((await new Runner(backend, clock).run(request)).phase, 'exited');
});
test('restore rejects identity/schema/environment drift before installing ownership and never invokes execution', async () => {
  for (const change of [(c: any) => { c.schema = 'other'; }, (c: any) => { c.identity.extra = true; }, (c: any) => { c.execution.version = 2; }]) {
    const backend = new Backend(), record = checkpoint(); change(record);
    await assert.rejects(new Runner(backend, clock).restore(record)); assert.equal(backend.calls.includes('restore'), false);
  }
  const backend = new Backend(), handle = await new Runner(backend, clock).restore(checkpoint());
  assert.deepEqual(backend.calls, ['definition', 'restore']); assert.deepEqual(await handle.query(), backend.state);
  await assert.rejects(handle.release(), /RESTORED_EXECUTION_NOT_REMOVED/);
});
test('stop confirmation alone cannot release a restored resource; removal and failures remain retryable', async () => {
  const backend = new Backend(), handle = await new Runner(backend, clock).restore(checkpoint());
  backend.state = { state: 'created' }; backend.stopConfirmed = false;
  assert.deepEqual(await handle.stopAndRemove(), { confirmed: false }); assert.equal(backend.calls.includes('remove'), false);
  backend.stopConfirmed = true; backend.removeFails = true;
  assert.deepEqual(await handle.stopAndRemove(), { confirmed: false }); await assert.rejects(handle.release());
  backend.removeFails = false;
  assert.deepEqual(await Promise.all([handle.stopAndRemove(), handle.stopAndRemove()]), [{ confirmed: true }, { confirmed: true }]);
  assert.equal(backend.calls.filter(x => x === 'remove').length, 2);
  backend.releaseFails = true; await assert.rejects(handle.release()); backend.releaseFails = false;
  await Promise.all([handle.release(), handle.release()]); await handle.release();
  assert.equal(backend.calls.filter(x => x === 'release').length, 2);
});
