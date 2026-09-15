import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessRegistry, TASK_PATHS } from '@agentflow/engine';
import type { HarnessEvidence, HarnessTask, RunnerResult } from '@agentflow/engine';
import { CODEX_VERSION, CodexAdapter } from './codex.js';

const identity = { runId: 'run-1', nodeTaskId: 'node-1', attemptId: 'attempt-1', attemptNumber: 1 };
const task: HarnessTask = { identity, prompt: 'Read the input and save result.json in /task/outputs.', config: { model: 'gpt-5.4', reasoning: 'low', subagents: false, search: false } };
const adapter = new CodexAdapter();
// Public protocol-shaped fixtures; synthetic content, no private model transcript.
const start = [{ type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.started' }];
const completed = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 12, reasoning_output_tokens: 4 } };
function evidence(events: unknown[] = [...start, completed], selected = task): HarnessEvidence {
  const stdout = Buffer.from(events.map(value => JSON.stringify(value)).join('\n') + '\n');
  const file = { path: '/private/raw.bin', bytes: stdout.length, complete: true, truncated: false };
  const runner: RunnerResult = { identity, resource: { id: 'test-resource' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed',
    capture: { stdout: file, stderr: { ...file, bytes: 0 }, files: {}, outputsPath: '/private/outputs', imageId: null }, diagnostics: [], startedAt: 0, finishedAt: 1 };
  return { task: selected, runner, stdout, version: CODEX_VERSION, redact: text => text.replaceAll('SYNTHETIC_SECRET', '[redacted]') };
}

test('explicit registry and Codex plan keep prompt, fixed paths and secrets separate', () => {
  const registry = new HarnessRegistry(); registry.register(adapter);
  assert.equal(registry.get('codex'), adapter);
  assert.throws(() => registry.register(new CodexAdapter()), /DUPLICATE_HARNESS_ADAPTER/);
  assert.throws(() => registry.get('claude'), /UNKNOWN_HARNESS_ADAPTER/);
  const prompt = '--model evil\nDo exactly this, including $HOME and `literal`.';
  const plan = adapter.plan({ ...task, prompt });
  assert.deepEqual(plan.argv.slice(-2), ['--', prompt]);
  assert.equal(plan.cwd, TASK_PATHS.work);
  assert.equal(plan.environment['CODEX_HOME'], '/task/state/codex');
  assert.equal(plan.authentication.file, '/task/state/codex/auth.json');
  assert.equal(plan.configFiles.length, 0);
  assert.ok(plan.requirements.includes('controlled-egress'));
  assert.ok(plan.argv.some(arg => arg.includes('"/task/input"="write"')));
  assert.ok(plan.argv.some(arg => arg.includes('"/task/state/codex/auth.json"="deny"')));
  assert.ok(!JSON.stringify(plan).includes('API_KEY'));
});

test('unsupported, misspelled and conflicting config is rejected before execution', () => {
  for (const config of [null, {}, { model: 'm', subagents: false }, { model: 'm', subagents: true, search: false },
    { model: 'm', subagents: false, search: true }, { model: 'm', subagents: false, search: false, budget: 10 },
    { model: 'm', subagents: false, search: false, argv: [] }, { model: 'm', subagents: false, search: false, reasoning: 'maximum' },
    { model: 'm\n-c invalid=true', subagents: false, search: false }]) {
    assert.throws(() => adapter.plan({ ...task, config }), /UNSUPPORTED_CODEX_CONFIGURATION/);
  }
  assert.throws(() => adapter.plan({ ...task, outcomes: ['ok'] }), /INVALID_HARNESS_OUTCOMES/);
  assert.throws(() => adapter.plan({ ...task, outcomes: ['ok', 'ok'] }), /INVALID_HARNESS_OUTCOMES/);
});

test('normal completion requires both execution and protocol facts; it does not assign the business outcome', () => {
  const parsed = adapter.interpret(evidence());
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.outcome, null);
  assert.deepEqual(parsed.usage, { inputTokens: 100, cachedInputTokens: 30, outputTokens: 12, reasoningOutputTokens: 4 });
  assert.ok(parsed.events.every(event => JSON.stringify(event.identity) === JSON.stringify(identity)));
  for (const runnerChange of [{ exitCode: 1 }, { phase: 'cancelled' as const }, { phase: 'timed_out' as const }, { phase: 'failed' as const }, { stop: 'unknown' as const }, { identity: { ...identity, attemptId: 'other' } }]) {
    const item = evidence();
    assert.equal(adapter.interpret({ ...item, runner: { ...item.runner, ...runnerChange } }).status, 'failed');
  }
  assert.equal(adapter.interpret({ ...evidence(), version: '0.146.1' }).status, 'failed');
  for (const events of [[], start, [...start, { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'Done!' } }],
    [completed], [...start, { type: 'turn.failed', error: { message: 'failure' } }, completed], [...start, completed, { type: 'error' }]]) {
    assert.equal(adapter.interpret(evidence(events)).status, 'failed');
  }
});

test('malformed, truncated, mismatched and non UTF-8 evidence cannot become completion', () => {
  for (const stdoutPatch of [{ truncated: true }, { complete: false }, { error: 'READ_FAILED' }, { bytes: 0 }]) {
    const item = evidence(); const capture = item.runner.capture!;
    const result = adapter.interpret({ ...item, runner: { ...item.runner, capture: { ...capture, stdout: { ...capture.stdout, ...stdoutPatch } } } });
    assert.ok(result.diagnostics.includes('RAW_CAPTURE_INCOMPLETE'));
  }
  const malformed = evidence();
  for (const suffix of [Buffer.from('{'), Buffer.from([0xc3, 0x28])]) {
    const stdout = Buffer.concat([malformed.stdout, suffix]);
    const capture = malformed.runner.capture!;
    const result = adapter.interpret({ ...malformed, stdout, runner: { ...malformed.runner, capture: { ...capture, stdout: { ...capture.stdout, bytes: stdout.length } } } });
    assert.equal(result.status, 'failed');
  }
});

test('initialization warnings may precede a turn but cannot substitute for completion or leak payloads', () => {
  const warning = { type: 'item.completed', item: { id: 'warning', type: 'error', message: 'SYNTHETIC_SECRET' } };
  const parsed = adapter.interpret(evidence([start[0], warning, start[1], completed]));
  assert.equal(parsed.status, 'completed');
  assert.deepEqual(parsed.events.find(event => event.kind === 'error')?.data, null);
  assert.ok(!JSON.stringify(parsed).includes('SYNTHETIC_SECRET'));
  for (const events of [[warning, ...start, completed], [start[0], warning], [...start, completed, warning],
    [start[0], { ...warning, type: 'item.started' }, start[1], completed],
    [start[0], { type: 'item.completed', item: { id: 'early', type: 'agent_message', text: 'Done' } }, start[1], completed]]) {
    assert.equal(adapter.interpret(evidence(events)).status, 'failed');
  }
});

test('failed terminals are complete failure receipts, idempotent and incompatible with success', () => {
  const failed = { type: 'turn.failed', error: { message: 'SYNTHETIC_SECRET' } };
  const selected = { ...task, outcomes: ['accepted', 'rejected'] };
  const parsed = adapter.interpret(evidence([...start, failed, failed], selected));
  assert.equal(parsed.status, 'failed');
  assert.deepEqual(parsed.diagnostics, ['HARNESS_REPORTED_FAILURE']);
  assert.equal(parsed.events.filter(event => event.sourceType === 'turn.failed').length, 1);
  assert.equal(parsed.outcome, null);
  assert.equal(parsed.usage.inputTokens, null);
  assert.ok(!JSON.stringify(parsed).includes('SYNTHETIC_SECRET'));
  for (const terminals of [[failed, completed], [completed, failed], [failed, { ...failed, error: { message: 'different' } }]]) {
    assert.ok(adapter.interpret(evidence([...start, ...terminals])).diagnostics.includes('CONFLICTING_HARNESS_TERMINAL'));
  }
  assert.ok(adapter.interpret(evidence([failed])).diagnostics.includes('INVALID_HARNESS_EVENT_ORDER'));
  assert.ok(adapter.interpret(evidence([...start, failed, { type: 'future.event' }])).diagnostics.includes('EVENT_AFTER_HARNESS_TERMINAL'));
});

test('terminal usage is idempotent, not recursively summed; missing usage remains unknown', () => {
  const duplicate = { usage: { ...completed.usage }, type: 'turn.completed' };
  const parsed = adapter.interpret(evidence([...start, completed, duplicate]));
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.usage.inputTokens, 100);
  assert.equal(parsed.events.filter(event => event.kind === 'usage').length, 1);
  assert.equal(adapter.interpret(evidence([...start, completed, { ...completed, usage: { input_tokens: 101 } }])).status, 'failed');
  const absent = adapter.interpret(evidence([...start, { type: 'metrics.snapshot', usage: { input_tokens: 9999 } }, { type: 'turn.completed' }]));
  assert.equal(absent.status, 'completed');
  assert.deepEqual(absent.usage, { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null });
  for (const usage of [{ input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: '20' }, { input_tokens: 1, cached_input_tokens: 2 }]) {
    assert.ok(adapter.interpret(evidence([...start, { type: 'turn.completed', usage }])).diagnostics.includes('INVALID_HARNESS_USAGE'));
  }
});

test('ordinary events project and redact fields while unknown payloads remain private', () => {
  const parsed = adapter.interpret(evidence([...start,
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'SYNTHETIC_SECRET' } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'echo SYNTHETIC_SECRET', aggregated_output: 'SYNTHETIC_SECRET', exit_code: 0, headers: { authorization: 'SYNTHETIC_SECRET' } } },
    { type: 'item.completed', item: { id: 'i3', type: 'future_tool', password: 'SYNTHETIC_SECRET' } },
    { type: 'SYNTHETIC_SECRET', nested: { access_token: 'SYNTHETIC_SECRET' } }, completed]));
  assert.equal(parsed.status, 'completed');
  assert.ok(!JSON.stringify(parsed).includes('SYNTHETIC_SECRET'));
  assert.ok(JSON.stringify(parsed).includes('[redacted]'));
  assert.ok(parsed.events.some(event => event.kind === 'unknown'));
  const failed = adapter.interpret({ ...evidence(), redact: () => { throw new Error('SYNTHETIC_SECRET'); } });
  assert.equal(failed.status, 'failed');
  assert.ok(!JSON.stringify(failed).includes('SYNTHETIC_SECRET'));
});

test('multi-outcome uses a schema and structured final answer, never an artifact manifest', () => {
  const selected = { ...task, outcomes: ['accepted', 'rejected'] };
  const plan = adapter.plan(selected);
  assert.deepEqual(JSON.parse(plan.configFiles[0]!.content).properties.outcome.enum, selected.outcomes);
  assert.ok(plan.argv.includes('/task/config/outcome.schema.json'));
  for (const [text, status] of [['{"outcome":"rejected"}', 'completed'], ['Done: accepted', 'failed'], ['{"outcome":"other"}', 'failed'], ['{"outcome":"accepted","artifacts":[]}', 'failed']] as const) {
    const result = adapter.interpret(evidence([...start, { type: 'item.completed', item: { id: 'final', type: 'agent_message', text } }, completed], selected));
    assert.equal(result.status, status);
    assert.equal(result.outcome, status === 'completed' ? 'rejected' : null);
  }
});

test('Codex initial images preserve ordering and map only safe input-relative paths', () => {
  const inputImages = ['source/prompt-images/page-0002.jpg', 'source/prompt-images/page-0001.png'];
  const selected = { ...task, config: { ...(task.config as object), inputImages } };
  const plan = adapter.plan(selected);
  assert.deepEqual(plan.argv.slice(-5), ['--image', '/task/input/source/prompt-images/page-0002.jpg', '/task/input/source/prompt-images/page-0001.png', '--', task.prompt]);
  const maximum = adapter.plan({ ...task, config: { ...(task.config as object), inputImages: Array.from({ length: 64 }, (_, i) => `${i}.png`) } });
  assert.ok(maximum.argv.length <= 128);
  assert.equal(maximum.argv.filter(arg => arg === '--image').length, 1);
  inputImages[0] = 'changed.jpg';
  assert.ok(!plan.argv.includes('/task/input/changed.jpg'));
  assert.equal(adapter.interpret(evidence([...start, completed], selected)).status, 'completed');
  for (const paths of [['/etc/passwd.png'], ['../state/codex/auth.json'], ['source/../state/a.png'], ['a,b.png'], ['a.png','a.png'], ['a.gif'], [''], ['folder\\image.png'], ['bad\nimage.png'], ['bad\0image.png'], [null], Array(2), Array.from({ length: 65 }, (_, i) => `${i}.png`), 'a.png']) {
    assert.throws(() => adapter.plan({ ...task, config: { ...(task.config as object), inputImages: paths } as any }), /INVALID_CODEX_INPUT_IMAGES/);
  }
});
