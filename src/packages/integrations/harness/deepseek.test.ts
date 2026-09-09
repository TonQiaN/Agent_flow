import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessRegistry } from '@agentflow/engine';
import type { HarnessTask, HarnessEvidence } from '@agentflow/engine';
import { DeepSeekAdapter, DEEPSEEK_VERSION, DEEPSEEK_SESSION_RECORD } from '../index.js';
const adapter = new DeepSeekAdapter();
const task = (): HarnessTask => ({ identity: { runId: 'run', nodeTaskId: 'node', attemptId: 'attempt', attemptNumber: 1 },
  prompt: '--help\n用户自定 "任务"', config: { model: 'deepseek-v4-flash', reasoning: 'off', search: false, subagents: false } });
test('DeepSeek Adapter declares fixed isolated launch, private authentication and named capture requirements', () => {
  const t = task(), plan = adapter.plan(t), registry = new HarnessRegistry(); registry.register(adapter);
  assert.equal(registry.get('deepseek'), adapter); assert.equal(plan.version, DEEPSEEK_VERSION);
  assert.deepEqual(plan.argv, ['node', '/task/config/deepseek-policy/launch.mjs', '--', t.prompt]); assert.equal(plan.cwd, '/task/work');
  assert.deepEqual(plan.authentication, { service: 'deepseek', method: 'api-key', variable: 'DEEPSEEK_API_KEY' });
  assert.deepEqual(plan.requirements, ['private-state', 'readonly-config', 'controlled-egress', 'deepseek-runtime-assets', 'deepseek-session-record']);
  assert.equal(plan.environment['DSH_TOOLS_MODE'], 'native'); assert.equal(plan.environment['DEEPSEEK_API_KEY'], undefined);
  assert.equal(plan.configFiles.length, 1);
  const patches = JSON.parse(plan.configFiles[0]!.content);
  for (const id of ['fs-sandbox', 'subprocess', 'bash-sandbox', 'sandbox-policy', 'session-title-llm']) assert.equal(patches.find((p: any) => p.id === id).disabled, true);
  const inserted = patches.find((p: any) => p.insert).insert; assert.equal(inserted.length, 5); assert.ok(inserted.every((p: any) => p.name.startsWith('/task/config/deepseek-policy/')));
  assert.equal(patches.find((p: any) => p.id === 'llm-deepseek').config.baseURL, 'https://api.deepseek.com');
  (t.identity as { runId: string }).runId = 'changed'; assert.equal(plan.identity.runId, 'run');
  assert.equal(DEEPSEEK_SESSION_RECORD.path, 'deepseek-session.jsonl');
});
test('DeepSeek Adapter only adds an enum outcome tool for valid multiple exits and rejects injected task/config fields', () => {
  const t = { ...task(), outcomes: ['accepted', 'rejected'] };
  const patches = JSON.parse(adapter.plan(t).configFiles[0]!.content), plugin = patches.find((p: any) => p.insert).insert.at(-1);
  assert.equal(plugin.name, '/task/config/deepseek-policy/outcome-service.mjs'); assert.deepEqual(plugin.config, { outcomes: t.outcomes });
  for (const outcomes of [[], ['one'], ['same', 'same'], ['ok', '../escape'], ['ok', 'bad\n'], Array.from({ length: 33 }, (_, i) => `o${i}`), null])
    assert.throws(() => adapter.plan({ ...task(), outcomes } as HarnessTask), /INVALID_HARNESS_OUTCOMES/);
  for (const prompt of ['', ' ', '\0', 'x'.repeat(65537)]) assert.throws(() => adapter.plan({ ...task(), prompt }), /INVALID_HARNESS_PROMPT/);
  for (const extra of [{ workdir: '/' }, { identity: { ...task().identity, private: 'value' } }]) assert.throws(() => adapter.plan({ ...task(), ...extra }), /INVALID_HARNESS_TASK/);
  assert.throws(() => adapter.plan({ ...task(), config: { model: 'x', search: false, subagents: false, plugins: [] } }), /UNSUPPORTED/);
});
test('DeepSeek Adapter never treats stdout as session evidence', () => {
  const raw = new TextEncoder().encode('{"type":"turn/end","data":{"reason":{"kind":"completed"}}}\n');
  const e: HarnessEvidence = { task: task(), version: DEEPSEEK_VERSION, stdout: raw, redact: text => text,
    runner: { identity: task().identity, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed', resource: { id: 'test' }, diagnostics: [], startedAt: 1, finishedAt: 2,
      capture: { imageId: 'test', outputsPath: '/out', stdout: { path: '/stdout', bytes: raw.length, complete: true, truncated: false }, stderr: { path: '/stderr', bytes: 0, complete: true, truncated: false }, files: { deepseek_session: { path: '/private/session', bytes: raw.length, complete: true, truncated: false } } } } };
  for (const records of [undefined, {}, { wrong_id: raw }]) {
    const result = adapter.interpret({ ...e, ...(records ? { records } : {}) }); assert.equal(result.status, 'failed'); assert.ok(result.diagnostics.includes('RAW_CAPTURE_INCOMPLETE'));
  }
});
