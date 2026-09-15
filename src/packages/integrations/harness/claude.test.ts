import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvidence, HarnessTask } from '@agentflow/engine';
import { ClaudeAdapter, CLAUDE_VERSION } from './claude.js';

const adapter = new ClaudeAdapter(), identity = { runId: 'run', nodeTaskId: 'node', attemptId: 'attempt', attemptNumber: 1 };
const task = (): HarnessTask => ({ identity: { ...identity }, prompt: '--user prompt\nkeep exactly', config: { model: 'sonnet', reasoning: 'high', subagents: false, search: false } });
const init = { type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'PRIVATE', tools: ['Read'] };
const success = { type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', result: 'finished', usage: {
  input_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 20, output_tokens: 5 }, modelUsage: { nested: { input_tokens: 99999 } } };
const assistant = { type: 'assistant', session_id: 'session-1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hello PRIVATE' }] } };
function evidence(records: unknown[] = [init, assistant, success], own = task()): HarnessEvidence {
  const stdout = new TextEncoder().encode(records.map(v => JSON.stringify(v)).join('\n') + '\n');
  return { task: own, version: CLAUDE_VERSION, stdout, redact: value => value.replaceAll('PRIVATE', '[redacted]'),
    runner: { identity: { ...identity }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed', resource: { id: 'fixture' }, diagnostics: [], startedAt: 0, finishedAt: 1,
      capture: { imageId: 'sha256:fixture', outputsPath: '/task/outputs', files: {}, stdout: { path: '/raw/stdout', bytes: stdout.byteLength, complete: true, truncated: false },
        stderr: { path: '/raw/stderr', bytes: 0, complete: true, truncated: false } } } };
}
test('Claude plan preserves prompt, separates fixed paths and subscription requirements, and limits supported configuration', () => {
  const t = task(), plan = adapter.plan(t); assert.deepEqual(plan.argv.slice(-2), ['--', t.prompt]); assert.equal(plan.cwd, '/task/work');
  assert.equal(plan.version, '2.1.226'); assert.ok(plan.argv.includes('--safe-mode')); assert.ok(!plan.argv.includes('--bare'));
  assert.ok(plan.argv.includes('stream-json')); assert.ok(!plan.argv.includes('--dangerously-skip-permissions'));
  assert.equal(plan.authentication.file, '/task/state/claude/.credentials.json'); assert.equal(plan.environment['CLAUDE_CONFIG_DIR'], '/task/state/claude');
  const policy = JSON.parse(plan.configFiles[0]!.content); assert.equal(policy.sandbox.failIfUnavailable, true); assert.equal(policy.sandbox.allowUnsandboxedCommands, false);
  assert.ok(policy.sandbox.filesystem.allowWrite.includes('/task/input')); assert.ok(policy.sandbox.filesystem.denyRead.includes('/task/state'));
  assert.deepEqual(policy.permissions.deny, ['Read(//task/state/**)', 'Edit(//task/state/**)', 'Edit(//task/config/**)', 'Agent', 'WebSearch', 'WebFetch']);
  assert.deepEqual(policy.sandbox.network.allowedDomains, []); assert.ok(policy.sandbox.filesystem.denyWrite.includes('/task/config'));
  for (const extra of [{ search: true }, { subagents: true }, { reasoning: 'off' }, { model: '--help' }, { budget: 10 }, { env: {} }])
    assert.throws(() => adapter.plan({ ...task(), config: { model: 'sonnet', subagents: false, search: false, ...extra } }), /UNSUPPORTED_CLAUDE_CONFIGURATION/);
  assert.throws(() => adapter.plan({ ...task(), outcomes: ['only'] }), /INVALID_HARNESS_OUTCOMES/);
  assert.throws(() => adapter.plan({ ...task(), outcomes: ['x', 'x'] }), /INVALID_HARNESS_OUTCOMES/);
  assert.throws(() => adapter.plan({ ...task(), identity: { ...identity, secret: 'PRIVATE' } } as HarnessTask), /INVALID_HARNESS_TASK/);
  (t.identity as { runId: string }).runId = 'mutated'; assert.equal(plan.identity.runId, 'run');
});
test('Claude completion requires terminal evidence; terminal usage sums disjoint input buckets once and ignores nested/message counters', () => {
  const parsed = adapter.interpret(evidence([init, { ...assistant, usage: { input_tokens: 999 } }, success, { ...success, usage: { ...success.usage } }]));
  assert.equal(parsed.status, 'completed'); assert.equal(parsed.outcome, null); assert.deepEqual(parsed.usage, { inputTokens: 70, cachedInputTokens: 40, outputTokens: 5, reasoningOutputTokens: null });
  assert.equal(parsed.events.filter(e => e.kind === 'usage').length, 1); assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));
  assert.equal(parsed.events[1]!.data && (parsed.events[1]!.data as { text: string }).text, 'hello [redacted]');
  assert.equal(adapter.interpret(evidence([init, assistant])).status, 'failed');
  assert.equal(adapter.interpret(evidence([success])).status, 'failed');
  assert.equal(adapter.interpret(evidence([init, { type: 'mystery', payload: { secret: 'PRIVATE' } }, success])).status, 'completed');
});
test('Claude multi-outcome accepts only terminal structured_output, never a completion sentence or JSON-looking result text', () => {
  const t = { ...task(), outcomes: ['accepted', 'rejected'] }, p = adapter.plan(t), schema = JSON.parse(p.argv[p.argv.indexOf('--json-schema') + 1]!);
  assert.deepEqual(schema.properties.outcome.enum, t.outcomes); assert.equal(schema.additionalProperties, false);
  const result = adapter.interpret(evidence([init, { ...success, structured_output: { outcome: 'rejected' } }], t));
  assert.equal(result.status, 'completed'); assert.equal(result.outcome, 'rejected');
  for (const structured_output of [undefined, null, { outcome: 'unknown' }, { outcome: 'accepted', extra: true }]) {
    const value = { ...success, result: '{"outcome":"accepted"}', ...(structured_output === undefined ? {} : { structured_output }) };
    assert.ok(adapter.interpret(evidence([init, value], t)).diagnostics.includes('INVALID_STRUCTURED_OUTCOME'));
  }
});
test('Claude rejects conflicting, foreign, post-terminal and subagent records while retaining explicit error terminals', () => {
  for (const records of [[init, success, { ...success, result: 'different' }], [init, success, assistant], [init, init, success],
    [init, { ...success, session_id: 'other' }], [init, { ...assistant, parent_tool_use_id: 'child' }, success],
    [init, { ...success, is_error: true }], [init, { ...success, subtype: 'error_max_turns', errors: ['PRIVATE'] }]]) {
    const result = adapter.interpret(evidence(records)); assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
  const failed = adapter.interpret(evidence([init, { ...success, subtype: 'error_during_execution', is_error: true, errors: ['PRIVATE'] }]));
  assert.ok(failed.diagnostics.includes('HARNESS_REPORTED_FAILURE')); assert.ok(!failed.diagnostics.includes('MISSING_HARNESS_TERMINAL'));
  assert.equal(failed.usage.inputTokens, 70); assert.equal(failed.usage.outputTokens, 5);
});
test('Claude rejects version, identity, runner, capture, malformed bytes and redaction failures', () => {
  const good = evidence();
  for (const e of [{ ...good, version: '2.1.225' }, { ...good, runner: { ...good.runner, identity: { ...identity, runId: 'other' } } },
    { ...good, runner: { ...good.runner, exitCode: 1 } }, { ...good, runner: { ...good.runner, cleanup: 'failed' as const } },
    { ...good, runner: { ...good.runner, capture: { ...good.runner.capture!, stdout: { ...good.runner.capture!.stdout, complete: false } } } },
    { ...good, stdout: new Uint8Array([0xff]) }, { ...good, stdout: new TextEncoder().encode('{incomplete') },
    { ...good, redact: () => { throw new Error('PRIVATE'); } }]) assert.equal(adapter.interpret(e).status, 'failed');
  const extra = { ...good, stdout: new TextEncoder().encode('x'.repeat(16 * 1024 * 1024 + 1)) }; assert.ok(adapter.interpret(extra).diagnostics.includes('RAW_CAPTURE_TOO_LARGE'));
});
test('Claude unknown usage remains unknown, malformed counters fail, and raw tool payloads never enter ordinary events', () => {
  const missing = adapter.interpret(evidence([init, { ...success, usage: { input_tokens: 10, output_tokens: 5 } }]));
  assert.deepEqual(missing.usage, { inputTokens: null, cachedInputTokens: null, outputTokens: 5, reasoningOutputTokens: null });
  for (const value of [-1, 0.5, true, '10', Number.MAX_SAFE_INTEGER + 1]) assert.equal(adapter.interpret(evidence([init, { ...success, usage: { ...success.usage, input_tokens: value } }])).status, 'failed');
  const tool = { ...assistant, message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'PRIVATE' } },
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'PRIVATE' }, { type: 'new-block', signature: 'PRIVATE' }] } };
  const result = adapter.interpret(evidence([init, tool, success])); assert.equal(result.status, 'completed'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  const broken = { ...assistant, message: { content: [{ type: 'tool_use', name: false }] } }; assert.equal(adapter.interpret(evidence([init, broken, success])).status, 'failed');
});
