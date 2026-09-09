import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from './runner.js';
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
