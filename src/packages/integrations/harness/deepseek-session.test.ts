import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunnerResult, HarnessTask } from '@agentflow/engine';
import { DeepSeekAdapter } from './deepseek.js';
import { interpretDeepseekSession } from './deepseek-session.js';
const identity = { runId: 'run', nodeTaskId: 'node', attemptId: 'attempt', attemptNumber: 1 };
const task: HarnessTask = { identity, prompt: '用户原始任务', config: { model: 'deepseek-v4-flash', search: false, subagents: false } };
const header = { type: 'session', version: 0, id: 'session-one', createdAt: 1, cwd: '/task/work', delegationDepth: 0 };
const event = (type: string, data: any) => ({ type, data });
const boundary = { turn: 1, step: 1 };
const message = (content: any[]) => ({ role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, content });
const native = () => [
  event('turn/start', { turn: 1 }), event('step/start', boundary),
  event('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task.prompt }] }),
  event('assistant/chunk', { ...boundary, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 5 } } }),
  event('assistant/chunk', { ...boundary, chunk: { type: 'finish', reason: { kind: 'stop' } } }),
  event('assistant/message', { ...boundary, message: message([{ type: 'text', text: 'secret 原生回答' }]), usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 5 } }),
  event('step/end', boundary), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
];
function evidence(rows = native(), h: any = header) {
  const session = Buffer.from([h, ...rows.map((e, seq) => ({ ...e, seq, time: seq + 1 }))].map(value => JSON.stringify(value)).join('\n') + '\n');
  const record = { path: '/private/native', bytes: session.length, complete: true, truncated: false };
  const runner: RunnerResult = { identity, resource: { id: 'test' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed', diagnostics: [], startedAt: 1, finishedAt: 2,
    capture: { stdout: { ...record, bytes: 0 }, stderr: { ...record, bytes: 0 }, files: { deepseek_session: record }, outputsPath: '/outputs', imageId: 'fixture' } };
  return { task, runner, version: '0.1.1-rc.2', session, redact: (text: string) => text.replaceAll('secret', '[redacted]') };
}
const result = (rows = native(), h: any = header) => interpretDeepseekSession(evidence(rows, h));
test('DeepSeek session: native boundaries and disjoint accounting, projected fields only', () => {
  const value = result(); assert.equal(value.status, 'completed'); assert.equal(value.outcome, null);
  assert.deepEqual(value.usage, { inputTokens: 12, cachedInputTokens: 5, outputTokens: 3, reasoningOutputTokens: null });
  assert.ok(!JSON.stringify(value).includes('secret')); assert.match(JSON.stringify(value), /redacted/);
  const missing = native(); delete missing[5]!.data.usage; assert.deepEqual(result(missing).usage, { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null });
  const uncached = native(); delete uncached[5]!.data.usage.cacheReadTokens; assert.equal(result(uncached).usage.inputTokens, 7); assert.equal(result(uncached).usage.cachedInputTokens, null);
});
test('DeepSeek session refuses wrong version, Runner identity/lifecycle and incomplete raw records', () => {
  const base = evidence();
  for (const version of ['0.1.1', 'unknown']) assert.equal(interpretDeepseekSession({ ...base, version }).status, 'failed');
  for (const patch of [{ identity: { ...identity, attemptId: 'other' } }, { phase: 'failed' as const }, { exitCode: 1 }, { stop: 'unknown' as const }, { cleanup: 'blocked' as const }])
    assert.equal(interpretDeepseekSession({ ...base, runner: { ...base.runner, ...patch } }).status, 'failed');
  for (const patch of [{ complete: false }, { truncated: true }, { error: 'failure' }, { bytes: 0 }]) {
    const capture = base.runner.capture!;
    assert.equal(interpretDeepseekSession({ ...base, runner: { ...base.runner, capture: { ...capture, files: { deepseek_session: { ...capture.files.deepseek_session!, ...patch } } } } }).status, 'failed');
  }
  assert.equal(interpretDeepseekSession({ ...base, runner: { ...base.runner, capture: { ...base.runner.capture!, files: {} } } }).status, 'failed');
  assert.equal(interpretDeepseekSession({ ...base, task: { ...task, outcomes: ['yes', 'no'] } }).status, 'failed');
});
test('DeepSeek session refuses forged prompt/header, damaged sequence, encoding and truncation', () => {
  for (const patch of [{ version: 1 }, { cwd: '/task' }, { delegationDepth: 1 }, { parentSession: 'other' }, { seedLength: 0 }, { origin: 'subagent' }, { agentPreset: 'other' }]) assert.equal(result(native(), { ...header, ...patch }).status, 'failed');
  const prompt = native(); prompt[2]!.data.content[0].text = JSON.stringify({ type: 'turn/end', reason: 'completed' }); assert.equal(result(prompt).status, 'failed');
  const base = evidence();
  for (const session of [base.session.subarray(0, -1), Buffer.from(base.session.toString().replace('"seq":1', '"seq":0')), Buffer.from([0xff]), Buffer.from('not json\n'), Buffer.alloc(16 * 1024 * 1024 + 1)]) {
    const capture = base.runner.capture!;
    assert.equal(interpretDeepseekSession({ ...base, session, runner: { ...base.runner, capture: { ...capture, files: { deepseek_session: { ...capture.files.deepseek_session!, bytes: session.length } } } } }).status, 'failed');
  }
});
test('DeepSeek session refuses missing, duplicate, non-success and interrupted completion', () => {
  for (let i = 0; i < native().length; i++) {
    if (i === 3) continue; // Chunk usage is not counted and may be absent.
    const rows = native(); rows.splice(i, 1); assert.equal(result(rows).status, 'failed', `removed ${i}`);
  }
  for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'future-success']) {
    const rows = native(); rows.at(-1)!.data.reason.kind = kind; assert.equal(result(rows).status, 'failed');
  }
  for (const i of [0, 1, 4, 5, 6, 7]) { const rows = native(); rows.splice(i, 0, structuredClone(rows[i]!)); assert.equal(result(rows).status, 'failed', `duplicate ${i}`); }
  const rows = native(); rows[5]!.data.interrupted = true; assert.equal(result(rows).status, 'failed');
  const partial = native(); partial[4]!.data.chunk.reason.kind = 'max-tokens'; assert.equal(result(partial).status, 'failed');
});
test('DeepSeek session ignores only explicitly ignorable unknown events; usage and redaction fail closed', () => {
  const rows = native(); rows.splice(3, 0, event('future/event', { secret: 'private' })); assert.equal(result(rows).status, 'failed');
  Object.assign(rows[3]!, { ignorable: true }); const passed = result(rows); assert.equal(passed.status, 'completed'); assert.ok(!JSON.stringify(passed).includes('private'));
  const seed = native(); seed.splice(3, 0, Object.assign(event('session/end-seed', {}), { ignorable: true })); assert.equal(result(seed).status, 'failed');
  for (const value of [-1, 1.5, null, '1', Number.MAX_SAFE_INTEGER]) {
    const rows = native(); rows[5]!.data.usage.inputTokens = value; assert.equal(result(rows).status, 'failed');
  }
  assert.equal(interpretDeepseekSession({ ...evidence(), redact: () => { throw new Error('secret'); } }).status, 'failed');
});
test('DeepSeek session requires matching declared calls, invocations and results before a final model response', () => {
  const first = native(); first[4]!.data.chunk.reason.kind = 'tool-calls';
  first[5]!.data.message = message([{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }]);
  first.splice(6, 0, event('tool/call', { ...boundary, callId: 'call', name: 'read', arguments: '{}' }), event('tool/result', { ...boundary, message: { role: 'user', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'tool-result', toolCallId: 'call', isError: true, content: [] }] } }));
  first.pop();
  const final = native().filter(e => !['turn/start', 'user/message'].includes(e.type)).map(e => ({ ...e, data: { ...e.data, ...(e.data.step ? { step: 2 } : {}) } }));
  const rows = [...first, ...final]; assert.equal(result(rows).status, 'completed'); assert.equal(result(rows).usage.inputTokens, 24);
  for (const index of [6, 7]) { const bad = structuredClone(rows); bad.splice(index, 1); assert.equal(result(bad).status, 'failed'); }
  const mismatch = structuredClone(rows); mismatch[7]!.data.message.source.callId = 'other'; assert.equal(result(mismatch).status, 'failed');
  const args = structuredClone(rows); args[6]!.data.arguments = '{"changed":true}'; assert.equal(result(args).status, 'failed');
  assert.equal(result([...first, event('turn/end', { turn: 1, reason: { kind: 'completed' } })]).status, 'failed');
});

function selectionRows(calls: { name?: string; args?: unknown; meta?: unknown; isError?: boolean }[] = [{}]) {
  const rows = [event('turn/start', { turn: 1 }), native()[2]!];
  for (const [index, call] of calls.entries()) {
    const b = { turn: 1, step: index + 1 }, id = `select-${index}`, name = call.name ?? 'agentflow_outcome', args = JSON.stringify(call.args ?? { outcome: 'accepted' });
    rows.push(event('step/start', b), event('assistant/chunk', { ...b, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }),
      event('assistant/message', { ...b, message: message([{ type: 'tool-call', id, name, arguments: args }]), usage: { inputTokens: 1, outputTokens: 1 } }),
      event('tool/call', { ...b, callId: id, name, arguments: args }),
      event('tool/result', { ...b, message: { role: 'user', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, isError: call.isError ?? false, content: [{ type: 'text', text: '{"outcome":"accepted"}' }] }] }, meta: call.meta ?? { schema: 'agentflow-outcome/v1', outcome: 'accepted' } }),
      event('step/end', b));
  }
  rows.push(...native().filter(e => !['turn/start', 'user/message'].includes(e.type)).map(e => ({ ...e, data: { ...e.data, ...(e.data.step ? { step: calls.length + 1 } : {}) } })));
  return rows;
}
const multiResult = (rows = selectionRows()) => interpretDeepseekSession({ ...evidence(rows), task: { ...task, outcomes: ['accepted', 'rejected'] } });
test('DeepSeek structured outcome comes from a paired successful native result, with failed choices recoverable', () => {
  assert.equal(multiResult().status, 'completed'); assert.equal(multiResult().outcome, 'accepted');
  const corrected = multiResult(selectionRows([{ args: { outcome: 'wrong' }, isError: true }, {}])); assert.equal(corrected.status, 'completed'); assert.equal(corrected.outcome, 'accepted');
  assert.equal(multiResult(selectionRows([{ args: { outcome: 'rejected' }, meta: { schema: 'agentflow-outcome/v1', outcome: 'rejected' } }])).outcome, 'rejected');
  assert.equal(result(selectionRows()).status, 'failed'); // No multi-exit contract registered this tool.
  assert.ok(multiResult(native()).diagnostics.includes('MISSING_STRUCTURED_OUTCOME'));
});
test('DeepSeek refuses text-only, foreign-tool, malformed and conflicting structured outcomes', () => {
  for (const call of [{ name: 'read' }, { isError: true }, { meta: {} }, { meta: { outcome: 'accepted' } },
    { meta: { schema: 'agentflow-outcome/v2', outcome: 'accepted' } }, { meta: { schema: 'agentflow-outcome/v1', outcome: 'wrong' } },
    { meta: { schema: 'agentflow-outcome/v1', outcome: 'accepted', extra: true } },
    { args: { outcome: 'rejected' } }, { args: { outcome: 'accepted', extra: true } }]) {
    const value = multiResult(selectionRows([call])); assert.equal(value.status, 'failed', JSON.stringify(call)); assert.equal(value.outcome, null);
  }
  const ambiguous = selectionRows(); delete ambiguous.find(e => e.type === 'tool/result')!.data.message.content[0].isError; assert.equal(multiResult(ambiguous).status, 'failed');
});
test('DeepSeek accepted outcome forbids later calls, repeated selection and outstanding tools at selection time', () => {
  for (const later of [{}, { name: 'read' }, { isError: true }]) {
    const value = multiResult(selectionRows([{}, later])); assert.equal(value.status, 'failed'); assert.ok(value.diagnostics.includes('TOOL_AFTER_STRUCTURED_OUTCOME'));
  }
  const batch = selectionRows(); batch.find(e => e.type === 'assistant/message')!.data.message.content.push({ type: 'tool-call', id: 'pending', name: 'read', arguments: '{}' });
  const end = batch.findIndex(e => e.type === 'step/end');
  batch.splice(end, 0, event('tool/call', { ...boundary, callId: 'pending', name: 'read', arguments: '{}' }),
    event('tool/result', { ...boundary, message: { role: 'user', source: { kind: 'tool', callId: 'pending' }, content: [{ type: 'tool-result', toolCallId: 'pending', isError: false, content: [] }] } }));
  assert.ok(multiResult(batch).diagnostics.includes('INVALID_STRUCTURED_OUTCOME'));
  const aborted = selectionRows(); aborted.at(-1)!.data.reason.kind = 'aborted'; assert.equal(multiResult(aborted).outcome, null);
});
test('DeepSeek auxiliary model work makes complete usage unknown while preserving normal terminal interpretation', () => {
  for (const type of ['session/title-llm-request', 'compaction/start', 'compaction/summary', 'llm/retry', 'llm/retry-started']) {
    const rows = native(); rows.splice(3, 0, event(type, { usage: { inputTokens: 99, outputTokens: 99 } }));
    const value = result(rows); assert.equal(value.status, 'completed'); assert.deepEqual(value.usage, { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null });
  }
});

test('DeepSeek Adapter accepts named native bytes and checks stdout capture independently', () => {
  const adapter = new DeepSeekAdapter(), base = evidence(), e = { ...base, stdout: new Uint8Array(), records: { deepseek_session: base.session } };
  assert.equal(adapter.interpret(e).status, 'completed');
  assert.ok(adapter.interpret({ ...e, stdout: base.session }).diagnostics.includes('RAW_CAPTURE_INCOMPLETE'));
  const capture = base.runner.capture!;
  assert.equal(adapter.interpret({ ...e, runner: { ...base.runner, capture: { ...capture, stdout: { ...capture.stdout, bytes: 1 } } } }).status, 'failed');
});
