import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScriptResult, ScriptExecutor, SCRIPT_RESULT_SCHEMA } from './script-executor.js';
import type { ScriptRequest } from './script-executor.js';
import type { ExecutionBackend, RawCapture } from '../runner/types.js';

const request: ScriptRequest = { identity: { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 }, inputSource: '/input',
  definition: { argv: ['script'], timeoutMs: 100, outcomes: ['accepted', 'rejected'] } };
const envelope = (outcome = 'accepted'): string => JSON.stringify({ schema: SCRIPT_RESULT_SCHEMA, outcome });
function fixture() {
  let text = envelope(), time = 0, allocations = 0, reads = 0, releases = 0, exitCode = 0, removeFails = false, stopConfirmed = true, running = false;
  const capture: RawCapture = { stdout: { path: '/private/raw/stdout', bytes: text.length, complete: true, truncated: false },
    stderr: { path: '/private/raw/stderr', bytes: 0, complete: true, truncated: false }, outputsPath: '/private/outputs', imageId: 'sha256:' + 'a'.repeat(64), files: {} };
  const backend: ExecutionBackend = { async allocate() { allocations++; return { id: 'resource' }; }, async prepare() {}, async create() {}, async start() {},
    async observe() { return running ? { state: 'running' } : { state: 'exited', exitCode }; }, async stop() { return { confirmed: stopConfirmed }; }, async capture() { return capture; },
    async remove() { if (removeFails) throw new Error('PRIVATE_REMOVE'); }, async release() { releases++; } };
  const executor = new ScriptExecutor(backend, { now: () => time, async sleep(ms) { time += ms; } }, { async read() { reads++; return text; } });
  return { executor, backend, capture, allocations: () => allocations, reads: () => reads, releases: () => releases,
    text: (v: string) => { text = v; }, exit: (v: number) => { exitCode = v; }, removal: (v: boolean) => { removeFails = v; },
    stop: (v: boolean) => { stopConfirmed = v; }, running: (v: boolean) => { running = v; } };
}

test('script protocol accepts declared business rejection and rejects logs, duplicates, unknown fields and bounds', () => {
  assert.equal(parseScriptResult(envelope('rejected'), ['accepted', 'rejected']), 'rejected');
  assert.equal(parseScriptResult(' \n' + envelope() + '\n', ['accepted']), 'accepted');
  const invalid = ['', 'null', '[]', envelope('unknown'), 'log\n' + envelope(), envelope() + envelope(),
    '{"schema":"agentflow-script-result/v1","outcome":"rejected","outcome":"accepted"}',
    JSON.stringify({ schema: SCRIPT_RESULT_SCHEMA, outcome: 'accepted', artifacts: [] }),
    JSON.stringify({ schema: 'wrong', outcome: 'accepted' }), JSON.stringify({ schema: SCRIPT_RESULT_SCHEMA, outcome: 1 }),
    ' '.repeat(65536) + envelope(), '\uFEFF' + envelope()];
  for (const text of invalid) assert.throws(() => parseScriptResult(text, ['accepted']), /INVALID_SCRIPT_RESULT/);
});

test('script preflight is side effect free and rejects unsupported definition fields and invalid limits', async () => {
  const f = fixture();
  for (const patch of [{ argv: [] }, { argv: [''] }, { argv: ['bad\0'] }, { timeoutMs: 0 }, { outcomes: [] }, { outcomes: ['same', 'same'] },
    { outcomes: ['invalid space'] }, { env: { SECRET: 'private' } }]) assert.throws(() => f.executor.validate({ ...request.definition, ...patch }), /INVALID_SCRIPT_DEFINITION/);
  f.executor.validate(request.definition); f.executor.validate(request.definition); assert.equal(f.allocations(), 0);
  const attempt = await f.executor.execute(request); assert.equal(attempt.result.status, 'accepted');
  assert.ok(!JSON.stringify(attempt).includes('/private')); assert.equal(f.reads(), 1);
  await attempt.releaseExecution(); await attempt.releaseExecution(); assert.equal(f.releases(), 1);
});

test('nonzero, cancelled, timed-out, incomplete and malformed executions never produce accepted script evidence', async () => {
  for (const mode of ['exit', 'cancel', 'timeout', 'capture', 'bytes', 'protocol', 'cleanup']) {
    const f = fixture();
    if (mode === 'exit') f.exit(7);
    if (mode === 'timeout') f.running(true);
    if (mode === 'capture') (f.capture.stdout as { truncated: boolean }).truncated = true;
    if (mode === 'bytes') f.text(envelope() + ' ');
    if (mode === 'protocol') f.text('x'.repeat(f.capture.stdout.bytes));
    if (mode === 'cleanup') f.removal(true);
    const attempt = await f.executor.execute(request, { requested: () => mode === 'cancel' });
    assert.equal(attempt.result.status, 'failed', mode); assert.ok(!JSON.stringify(attempt).includes('PRIVATE'));
    if (!['bytes', 'protocol'].includes(mode)) assert.equal(f.reads(), 0, mode);
    f.removal(false); await attempt.retryCleanup(); await attempt.releaseExecution(); assert.equal(attempt.result.status, 'failed');
  }
});

test('unknown stop is retained until recovery and cleanup cannot upgrade failure', async () => {
  const f = fixture(); f.running(true); f.stop(false);
  const attempt = await f.executor.execute(request); assert.equal(attempt.stopped(), false);
  await assert.rejects(attempt.releaseExecution(), /SCRIPT_STOP_UNCONFIRMED/); await assert.rejects(attempt.retryCleanup(), /SCRIPT_STOP_UNCONFIRMED/);
  assert.equal(f.releases(), 0); f.stop(true); await attempt.retryCleanup(); assert.equal(attempt.stopped(), true);
  await attempt.releaseExecution(); assert.equal(f.releases(), 1); assert.equal(attempt.result.status, 'failed');
});

test('script request mutation and concurrent duplicate attempts cannot alter execution', async () => {
  const f = fixture(), mutable = structuredClone(request); let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; }); f.backend.prepare = async () => pending;
  const first = f.executor.execute(mutable); (mutable.identity as { runId: string }).runId = 'forged';
  (mutable.definition as { outcomes: readonly string[] }).outcomes = ['forged'];
  await assert.rejects(f.executor.execute(request), /DUPLICATE_SCRIPT_ATTEMPT/); finish();
  const attempt = await first; assert.equal(attempt.result.status, 'accepted'); assert.deepEqual(attempt.result.identity, request.identity);
  await attempt.releaseExecution();
});
