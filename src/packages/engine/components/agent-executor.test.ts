import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessTask } from '../harness/types.js';
import type { ArtifactStore, FileManifest } from '../contracts/files.js';
import { ArtifactError, FileContractRegistry } from '../contracts/files.js';
import { ContractRegistry } from '../contracts/registry.js';
import { AgentExecutor } from './agent-executor.js';
import type { AgentExecutionDriver, AgentExecutionFacts, AgentExecutionRequest } from './agent-executor.js';

const identity = { runId: 'run', nodeTaskId: 'first', attemptId: 'a1', attemptNumber: 1 };
const request: AgentExecutionRequest = { componentId: 'marker', identity, prompt: 'User-owned task', config: {}, input: { source: '/host/input', contractId: 'files' }, outcomes: { completed: 'files' } };
function facts(task: HarnessTask): AgentExecutionFacts {
  return { runner: { identity: task.identity, resource: { id: 'resource' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed',
    capture: { imageId: 'sha256:' + 'a'.repeat(64), outputsPath: '/private/outputs', files: {},
      stdout: { path: '/private/raw', bytes: 10, complete: true, truncated: false }, stderr: { path: '/private/errors', bytes: 0, complete: true, truncated: false } },
    diagnostics: [], startedAt: 0, finishedAt: 1 },
  harness: { identity: task.identity, harness: 'fixture', status: 'completed', outcome: null,
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null }, events: [], diagnostics: [] },
  finalized: true, diagnostics: [], version: '1.0.0' };
}
function fixture(change: (value: AgentExecutionFacts) => AgentExecutionFacts = value => value) {
  const contracts = new FileContractRegistry(new ContractRegistry());
  for (const id of ['files', 'reject-files']) contracts.register(id, { rules: [], maxFiles: 0, maxTotalBytes: 0, unmatched: 'reject' });
  const captures: { source: string; contractId: string }[] = [], released: string[] = [], runs: { task: HarnessTask; input: FileManifest }[] = [];
  let cleanup = 0, releases = 0;
  const artifacts: ArtifactStore = {
    async capture(source, contractId) { captures.push({ source, contractId }); return { id: `snapshot-${captures.length}`, contractId, directories: [], files: [] }; },
    async materialize() {}, async release(id) { released.push(id); },
  };
  const driver: AgentExecutionDriver = { harness: 'fixture', validate() {}, async run(task, input) {
    runs.push({ task, input }); let current = change(facts(task));
    return { get facts() { return current; }, async retryCleanup() { cleanup++; current = facts(task); }, async release() { releases++; } };
  } };
  return { executor: new AgentExecutor(contracts, artifacts, driver), artifacts, driver, captures, released, runs, cleanup: () => cleanup, releases: () => releases };
}

test('single-exit acceptance binds engine-owned identity and snapshots; exported records cannot change authority', async () => {
  const f = fixture(); const attempt = await f.executor.execute(request); const result = attempt.result;
  assert.equal(result.status, 'accepted'); if (result.status !== 'accepted') throw new Error();
  assert.equal(result.receipt.outcome, 'completed'); assert.equal(result.receipt.predecessor, null);
  assert.equal(result.receipt.input.id, f.runs[0]!.input.id); assert.equal(result.receipt.output.id, 'snapshot-2');
  assert.deepEqual(result.receipt.identity, identity); assert.ok(!JSON.stringify(attempt).includes('/private/'));
  (result.receipt as { outcome: string }).outcome = 'forged';
  (f.executor.receipt(result.receipt.id) as { componentId: string }).componentId = 'forged';
  assert.equal(f.executor.receipt(result.receipt.id).outcome, 'completed');
  assert.equal(f.executor.receipt(result.receipt.id).componentId, 'marker');
  await attempt.releaseExecution(); assert.deepEqual(f.released, ['snapshot-1']);
  await f.executor.releaseOutput(result.receipt.id); await f.executor.releaseOutput(result.receipt.id);
  assert.deepEqual(f.released, ['snapshot-1', 'snapshot-2']); assert.equal(f.executor.receipt(result.receipt.id).outcome, 'completed');
});

test('runner, protocol, raw evidence, identity and finalization failures cannot scan outputs or issue receipts', async () => {
  const changes: ((f: AgentExecutionFacts) => AgentExecutionFacts)[] = [
    f => ({ ...f, runner: { ...f.runner, exitCode: 1 } }), f => ({ ...f, runner: { ...f.runner, phase: 'timed_out' } }),
    f => ({ ...f, runner: { ...f.runner, stop: 'unknown' } }), f => ({ ...f, runner: { ...f.runner, cleanup: 'blocked' } }),
    f => ({ ...f, runner: { ...f.runner, identity: { ...identity, attemptId: 'other' } } }),
    f => ({ ...f, runner: { ...f.runner, capture: { ...f.runner.capture!, stdout: { ...f.runner.capture!.stdout, truncated: true } } } }),
    f => ({ ...f, harness: { ...f.harness!, status: 'failed' } }), f => ({ ...f, harness: { ...f.harness!, harness: 'other' } }),
    f => ({ ...f, harness: { ...f.harness!, identity: { ...identity, runId: 'other' } } }),
    f => ({ ...f, finalized: false }), f => ({ ...f, diagnostics: ['PRIVATE_FAILURE_CONTENT'] }),
    f => ({ ...f, version: null }), f => ({ ...f, runner: { ...f.runner, capture: null } }),
  ];
  for (const change of changes) {
    const f = fixture(change); const attempt = await f.executor.execute(request);
    assert.equal(attempt.result.status, 'failed'); assert.equal(f.captures.length, 1);
    assert.throws(() => f.executor.receipt('receipt-1'), /UNKNOWN_EXECUTION_RECEIPT/);
    assert.ok(!JSON.stringify(attempt).includes('PRIVATE_FAILURE_CONTENT'));
    await attempt.retryCleanup(); assert.equal(attempt.result.status, 'failed'); assert.equal(f.cleanup(), 1);
    await attempt.releaseExecution(); assert.equal(f.releases(), 1);
  }
});

test('multi-outcome selects its declared file contract; refusal is a valid business outcome but missing outputs fail', async () => {
  const selected = { ...request, outcomes: { accepted: 'files', rejected: 'reject-files' } };
  const f = fixture(value => ({ ...value, harness: { ...value.harness!, outcome: 'rejected' } }));
  const result = (await f.executor.execute(selected)).result;
  assert.equal(result.status, 'accepted'); if (result.status === 'accepted') assert.equal(result.receipt.outcome, 'rejected');
  assert.equal(f.captures[1]!.contractId, 'reject-files'); assert.deepEqual(f.runs[0]!.task.outcomes, ['accepted', 'rejected']);
  for (const outcome of [null, 'unknown']) {
    const bad = fixture(value => ({ ...value, harness: { ...value.harness!, outcome } }));
    assert.equal((await bad.executor.execute(selected)).result.status, 'failed'); assert.equal(bad.captures.length, 1);
  }
  const bad = fixture(); const capture = bad.artifacts.capture.bind(bad.artifacts);
  bad.artifacts.capture = async (source, id) => { if (source === '/private/outputs') throw new Error('PRIVATE_CONTENT'); return capture(source, id); };
  const attempt = await bad.executor.execute(request); assert.equal(attempt.result.status, 'failed');
  assert.ok(!JSON.stringify(attempt).includes('PRIVATE_CONTENT')); await attempt.releaseExecution();
  const located = fixture(); const originalCapture = located.artifacts.capture.bind(located.artifacts);
  located.artifacts.capture = async (source, id) => {
    if (source === '/private/outputs') throw new ArtifactError('FILE_CONTRACT_VIOLATION', '', [{ path: 'answer.json', rule: 'answer', code: 'JSON_CONTRACT' }]);
    return originalCapture(source, id);
  };
  const failure = (await located.executor.execute(request)).result;
  if (failure.status !== 'failed') throw new Error();
  assert.equal(failure.contractId, 'files'); assert.deepEqual(failure.issues, [{ path: 'answer.json', rule: 'answer', code: 'JSON_CONTRACT' }]);
});

test('predecessor IDs resolve only through this engine, same Run and matching contracts; released outputs cannot run', async () => {
  const f = fixture(); const first = (await f.executor.execute(request)).result;
  if (first.status !== 'accepted') throw new Error();
  const next = { ...request, componentId: 'reviewer', identity: { ...identity, nodeTaskId: 'second' }, input: { receiptId: first.receipt.id, contractId: 'files' } };
  for (const patch of [{ input: { receiptId: 'forged', contractId: 'files' } }, { identity: { ...next.identity, runId: 'other' } },
    { input: { receiptId: first.receipt.id, contractId: 'reject-files' } }]) await assert.rejects(f.executor.execute({ ...next, ...patch }));
  const second = (await f.executor.execute(next)).result; assert.equal(second.status, 'accepted');
  if (second.status === 'accepted') { assert.equal(second.receipt.predecessor, first.receipt.id); assert.deepEqual(second.receipt.input, first.receipt.output); }
  assert.equal(f.captures.length, 3); assert.equal(f.runs[1]!.input.id, first.receipt.output.id);
  await f.executor.releaseOutput(first.receipt.id);
  await assert.rejects(f.executor.execute({ ...next, identity: { ...identity, nodeTaskId: 'third' } }), /INVALID_PREDECESSOR_RECEIPT/);
});

test('attempt reservation prevents concurrent replay and request mutation cannot change the invocation or receipt', async () => {
  const f = fixture(); const mutable = structuredClone(request); const first = f.executor.execute(mutable);
  (mutable as { componentId: string; prompt: string }).componentId = 'changed'; (mutable as { prompt: string }).prompt = 'changed';
  const duplicate = f.executor.execute(request); await assert.rejects(duplicate, /DUPLICATE_AGENT_ATTEMPT/);
  const result = (await first).result; assert.equal(result.componentId, 'marker'); assert.equal(f.runs[0]!.task.prompt, 'User-owned task');
  await assert.rejects(f.executor.execute({ ...request, identity: { ...identity, attemptNumber: 2 } }), /DUPLICATE_AGENT_ATTEMPT/);
});

test('definition and cancellation failures occur before a driver call; failed starts retain releasable input', async () => {
  const f = fixture();
  await assert.rejects(f.executor.execute({ ...request, outcomes: { done: 'unknown' } }), /UNKNOWN_FILE_CONTRACT/);
  await assert.rejects(f.executor.execute({ ...request, receipt: { outcome: 'done' } } as AgentExecutionRequest), /INVALID_AGENT_REQUEST/);
  const cancelled = await f.executor.execute(request, { requested: () => true });
  assert.equal(cancelled.result.status, 'failed'); assert.equal(f.captures.length, 0); assert.equal(f.runs.length, 0);
  const g = fixture(); g.driver.run = async () => { throw new Error('PRIVATE_START_FAILURE'); };
  const failed = await g.executor.execute(request); assert.equal(failed.result.status, 'failed');
  await failed.releaseExecution(); assert.deepEqual(g.released, ['snapshot-1']);
  const h = fixture(); let polls = 0;
  const brokenCancellation = await h.executor.execute(request, { requested() { if (++polls === 2) throw new Error('PRIVATE_CALLBACK_FAILURE'); return false; } });
  assert.equal(brokenCancellation.result.status, 'failed'); assert.equal(h.runs.length, 0);
  await brokenCancellation.releaseExecution(); assert.deepEqual(h.released, ['snapshot-1']);
});

test('Agent definition uses the installed driver without reading or capturing task input', async () => {
  const f = fixture(); let seen: HarnessTask | null = null;
  f.driver.definitionSnapshot = async task => { seen = task; return { schema: 'fixture-agent-definition/v1', prompt: task.prompt, config: task.config }; };
  const definition = await f.executor.definitionSnapshot(request);
  assert.deepEqual(definition, { schema: 'fixture-agent-definition/v1', prompt: request.prompt, config: request.config });
  assert.equal((seen as HarnessTask | null)?.prompt, request.prompt); assert.deepEqual(f.captures, []); assert.deepEqual(f.runs, []);
  await assert.rejects(f.executor.definitionSnapshot({ ...request, prompt: '' }), /INVALID_AGENT_REQUEST/);
});
test('an old custom Agent driver can execute but cannot claim an absent persistence definition', async () => {
  const f = fixture(); await assert.rejects(f.executor.definitionSnapshot(request), /EXECUTION_DEFINITION_UNAVAILABLE/);
  assert.deepEqual(f.captures, []); assert.equal((await f.executor.execute(request)).result.status, 'accepted');
});

test('existing snapshot inputs avoid capture and remain owned by their caller', async () => {
  const f = fixture(), input = await f.artifacts.capture('/host/input', 'files');
  f.artifacts.inspect = async id => { assert.equal(id, input.id); return structuredClone(input); };
  assert.equal(f.executor.canReuseSnapshot(f.artifacts), true);
  assert.equal(f.executor.canReuseSnapshot({ ...f.artifacts }), false);
  const attempt = await f.executor.execute({ ...request, input: { contractId: 'files', snapshotId: input.id } });
  assert.equal(attempt.result.status, 'accepted'); assert.equal(f.captures.length, 2);
  if (attempt.result.status !== 'accepted') throw new Error();
  assert.equal(attempt.result.receipt.input.id, input.id); assert.equal(attempt.result.receipt.predecessor, null);
  await attempt.releaseExecution(); assert.deepEqual(f.released, []);
  await f.executor.releaseOutput(attempt.result.receipt.id); assert.deepEqual(f.released, ['snapshot-2']);
});
test('snapshot lookup absence, identity mismatch and contract mismatch cannot start an Agent', async () => {
  for (const problem of ['unsupported', 'unknown', 'identity', 'contract']) {
    const f = fixture();
    if (problem !== 'unsupported') f.artifacts.inspect = async () => {
      if (problem === 'unknown') throw new ArtifactError('UNKNOWN_SNAPSHOT');
      return { id: problem === 'identity' ? 'other' : 'saved', contractId: problem === 'contract' ? 'reject-files' : 'files', files: [], directories: [] };
    };
    const result = (await f.executor.execute({ ...request, input: { contractId: 'files', snapshotId: 'saved' } })).result;
    assert.equal(result.status, 'failed'); assert.equal(f.runs.length, 0); assert.equal(f.captures.length, 0); assert.deepEqual(f.released, []);
  }
});
