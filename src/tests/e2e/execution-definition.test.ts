import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ContractRegistry, FileContractRegistry, ScriptExecutor, compileWorkflow, snapshotWorkflowExecution, assertWorkflowExecutionMatches, snapshotWorkflowStructure } from '@agentflow/engine';
import type { WorkflowDefinition, ExecutionBackend } from '@agentflow/engine';
import { DockerBackend } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
import { systemClock } from '../../packages/integrations/system-clock.js';
import { FileWorkflowCatalog } from '../../packages/integrations/workflow/files.js';
import { FileArtifactStore } from '../../packages/integrations/artifacts/file-store.js';
import { readCapturedBytes } from '../../packages/integrations/execution/capture-reader.js';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const definition: WorkflowDefinition = { id: 'script-flow', start: 'a', input: { kind: 'files', id: 'files' }, maxSteps: 1,
  nodes: { a: { component: 'script' } }, outcomes: { done: { kind: 'files', id: 'files' } }, routes: [{ from: 'a', outcome: 'ok', to: { end: 'done' } }] };
function catalog(root: string, backend: ExecutionBackend, text = 'first', timeoutMs = 10000) {
  const contracts = new FileContractRegistry(new ContractRegistry()); contracts.register('files', { rules: [], maxFiles: 0, maxTotalBytes: 0, unmatched: 'reject' });
  const files = new FileWorkflowCatalog(contracts, new FileArtifactStore(join(root, 'snapshots'), contracts), join(root, 'work'));
  const script = new ScriptExecutor(backend, systemClock, { read: async (file, max) => new TextDecoder('utf-8', { fatal: true }).decode(await readCapturedBytes(file, max)) });
  files.registerScript({ id: 'script', kind: 'transform', inputContract: 'files', outcomes: { ok: 'files' }, implementation: 'script' }, script,
    { argv: ['/bin/sh', '-c', `printf '%s' '${text}' >/task/work/marker; printf '%s' '{"schema":"agentflow-script-result/v1","outcome":"ok"}'`], timeoutMs });
  return { files, script, compiled: compileWorkflow(definition, files) };
}

test('actual script binding changes are distinct even when structural snapshots match', async () => {
  const backend = { definition: async () => ({ schema: 'test-environment/v1', image: 'fixed' }) } as unknown as ExecutionBackend;
  const a = catalog('/unused/script-binding', backend), b = catalog('/unused/script-binding', backend, 'second');
  assert.deepEqual(snapshotWorkflowStructure(a.compiled), snapshotWorkflowStructure(b.compiled));
  const saved = await snapshotWorkflowExecution(a.compiled);
  await assert.rejects(assertWorkflowExecutionMatches(b.compiled, saved), /WORKFLOW_EXECUTION_MISMATCH/);
  await assert.rejects(assertWorkflowExecutionMatches(catalog('/unused/script-binding', backend, 'first', 20000).compiled, saved), /WORKFLOW_EXECUTION_MISMATCH/);
  a.files.executionDefinition = async () => { throw new Error('replaced'); };
  assert.deepEqual(await snapshotWorkflowExecution(a.compiled), saved);
  (saved.bindings['a'] as any).definition.argv[0] = 'changed';
  await assert.rejects(assertWorkflowExecutionMatches(a.compiled, saved), /WORKFLOW_EXECUTION_MISMATCH/);
});

test('absent or empty environment definitions cannot become script persistence evidence', async () => {
  for (const backend of [{}, { definition: async () => null }, { definition: async () => ({}) }]) {
    const f = catalog('/unused/no-definition', backend as ExecutionBackend);
    await assert.rejects(snapshotWorkflowExecution(f.compiled), /EXECUTION_DEFINITION/);
  }
});

test('Docker execution definition freezes the actual image through tag removal and new installations reject drift', { skip: !enabled, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-execution-definition-'));
  const tag = `agentflow-definition-test:${randomUUID()}`;
  const image = process.env['AGENTFLOW_TEST_IMAGE'] ?? 'alpine:3';
  await docker(['tag', image, tag]);
  t.after(async () => { try { await docker(['image', 'rm', tag]); } catch { /* Test tag may already be removed. */ } await rm(root, { recursive: true, force: true }); });
  const options = { workspaceRoot: join(root, 'attempts'), image: tag };
  const backend = new DockerBackend(options), f = catalog(root, backend);
  const [saved, again] = await Promise.all([snapshotWorkflowExecution(f.compiled), snapshotWorkflowExecution(f.compiled)]);
  assert.deepEqual(saved, again); assert.deepEqual(await readdir(root), []);
  const environment = (saved.bindings['a'] as any).backend;
  assert.match(environment.options.image, /^sha256:[a-f0-9]{64}$/); assert.equal(environment.options.network, 'none');
  await docker(['image', 'rm', tag]);
  // Fresh installs inspect the selected reference, not a previously saved claim.
  await assert.rejects(snapshotWorkflowExecution(catalog(root, new DockerBackend(options)).compiled));
  const pinned = catalog(root, new DockerBackend({ ...options, image: environment.options.image }));
  await assertWorkflowExecutionMatches(pinned.compiled, saved);
  const changed = catalog(root, new DockerBackend({ ...options, image: environment.options.image, memoryMiB: 1024 }));
  await assert.rejects(assertWorkflowExecutionMatches(changed.compiled, saved), /WORKFLOW_EXECUTION_MISMATCH/);
  environment.options.image = 'forged'; assert.notEqual((await backend.definition() as any).options.image, 'forged');
  const input = join(root, 'input'); await mkdir(input);
  const attempt = await f.script.execute({ identity: { runId: 'binding', nodeTaskId: 'a', attemptId: 'one', attemptNumber: 1 }, inputSource: input,
    definition: { argv: ['/bin/sh', '-c', `printf '%s' '{"schema":"agentflow-script-result/v1","outcome":"ok"}'`], timeoutMs: 10000, outcomes: ['ok'] } });
  try { assert.equal(attempt.result.status, 'accepted'); assert.equal(attempt.executionFacts()!.capture!.imageId, (await backend.definition() as any).options.image); }
  finally { await attempt.retryCleanup(); await attempt.releaseExecution(); }
});

test('Docker refuses late/private/interactive freezing and describes owned network environments', { skip: !enabled, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-definition-refusal-')); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { workspaceRoot: join(root, 'attempts'), image: 'alpine:3' };
  const backend = new DockerBackend(options), resource = await backend.allocate();
  try { await assert.rejects(backend.definition(), /EXECUTION_DEFINITION_AFTER_ALLOCATION/); } finally { await backend.remove(resource); await backend.release(resource); }
  let called = false;
  const privateBackend = new DockerBackend(options, { environment: {}, prepare: async () => { called = true; }, beforeRelease: async () => { called = true; } });
  await assert.rejects(privateBackend.definition(), /EXECUTION_DEFINITION_UNAVAILABLE/); assert.equal(called, false);
  const interactive = new DockerBackend(options, undefined, { open: () => { called = true; return () => {}; }, output: () => { called = true; } });
  await assert.rejects(interactive.definition(), /EXECUTION_DEFINITION_UNAVAILABLE/); assert.equal(called, false);
  const network = new DockerBackend({ ...options, network: { kind: 'connect-proxy', proxyImage: 'node:22-bookworm-slim', allowedHosts: ['example.com'] } });
  const described = await network.definition() as any;
  assert.equal(described.schema, 'agentflow-docker-execution/v2'); assert.match(described.egress.proxySha256, /^[a-f0-9]{64}$/);
  assert.match(described.options.network.proxyImage, /^sha256:/);
});
