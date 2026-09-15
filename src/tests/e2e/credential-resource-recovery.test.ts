import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore, FileCredentialStore, DeepSeekApiKeyCodec, CodexSubscriptionRunner } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled = process.env['AGENTFLOW_EGRESS_TESTS'] === '1';
const image = `agentflow-test/credential-resource:${randomUUID()}`;
const credential = { credentialRef: 'fixture', service: 'deepseek', method: 'api-key' };
const content = (key: string) => JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: key });
let build: string | undefined, assetsPath: string;
before(async () => {
  if (!enabled) return;
  build = await mkdtemp(join(tmpdir(), 'af-credential-build-')); assetsPath = join(build, 'assets.json');
  await writeFile(assetsPath, execFileSync(process.execPath, ['src/apps/deepseek-tools/export-assets.mjs']));
  await writeFile(join(build, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --chmod=755 dsh /usr/local/bin/dsh\nCOPY package.json /usr/local/lib/node_modules/@deepseek-ai/dsh/package.json\n');
  await writeFile(join(build, 'dsh'), await readFile(new URL('../fixtures/deepseek-protocol.cjs', import.meta.url)));
  await writeFile(join(build, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }));
  execFileSync('docker', ['build', '--network', 'none', '--pull=false', '--tag', image, build], { stdio: 'pipe', timeout: 60000 });
});
after(async () => { if (build) { await docker(['image', 'rm', image]).catch(() => {}); await rm(build, { recursive: true, force: true }); } });
function child(root: string, operation: string, stage: string) {
  const process = fork(new URL('../fixtures/credential-resource.mjs', import.meta.url), [root, operation, stage, image, assetsPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let stdout = '', stderr = ''; process.stdout!.on('data', b => { stdout += b; }); process.stderr!.on('data', b => { stderr += b; });
  const timer = setTimeout(() => process.kill('SIGKILL'), 25000); const exited = once(process, 'exit').finally(() => clearTimeout(timer));
  return { process, exited, output: () => ({ stdout, stderr }) };
}
async function output(c: ReturnType<typeof child>) { const [code] = await c.exited; assert.equal(code, 0, c.output().stderr); return JSON.parse(c.output().stdout); }
async function rootAt() {
  const root = await mkdtemp(join(tmpdir(), 'af-credential-resource-'));
  await mkdir(join(root, 'source')); await writeFile(join(root, 'source/numbers.json'), '{"numbers":[1,2,3]}');
  const source = new FileCredentialStore(join(root, 'store'), [new DeepSeekApiKeyCodec()]);
  await source.configure(credential, { content: content('fixture-deepseek-key') }); return { root, source };
}
async function setup(stage: string) {
  const f = await rootAt(), c = child(f.root, 'run', stage);
  try { await Promise.race([once(c.process, 'message'), c.exited.then(() => { throw new Error(c.output().stderr || 'early exit'); })]); }
  finally { if (c.process.exitCode === null && c.process.signalCode === null) { c.process.kill('SIGKILL'); await c.exited; } }
  const store = await SqliteRunRecordStore.open(join(f.root, 'db')); const record: any = (await store.read('run'))!.content; store.close();
  const id: string = record.execution.resource.id;
  return { ...f, id, record, close: async () => {
    for (const name of [id, `${id}-proxy`]) await docker(['rm', '-f', name]).catch(() => {});
    for (const name of [`${id}-internal`, `${id}-external`]) await docker(['network', 'rm', name]).catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  } };
}
async function removed(id: string) {
  for (const name of [id, `${id}-proxy`]) assert.equal(await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']), '');
  for (const name of [`${id}-internal`, `${id}-external`]) assert.equal(await docker(['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.ID}}']), '');
}
for (const mode of ['allocated', 'create_completed', 'start_completed', 'completed', 'workspace-missing', 'rotated', 'deleted'])
  test(`immutable Agent resource recovery does not read or restore old keys: ${mode}`, { skip: !enabled, timeout: 35000 }, async () => {
    const f = await setup(['workspace-missing', 'rotated', 'deleted'].includes(mode) ? 'start_completed' : mode);
    try {
      assert.equal(f.record.versionComplete, true); assert.equal(f.record.execution.execution.schema, 'agentflow-docker-execution/v3');
      assert.deepEqual(f.record.execution.execution.privateState, { schema: 'agentflow-environment-resource/v1', credential, keys: ['DEEPSEEK_API_KEY'] });
      assert.ok(!JSON.stringify(f.record).includes('fixture-deepseek-key')); assert.ok(!JSON.stringify(f.record).includes('generation'));
      if (mode === 'workspace-missing') await rm(join(f.root, 'attempts'), { recursive: true, force: true });
      if (mode === 'rotated') await f.source.configure(credential, { content: content('fixture-rotated-key') });
      if (mode === 'deleted') await f.source.delete(credential);
      const before = await f.source.inspect(credential), result = await output(child(f.root, 'restore', ''));
      assert.equal(result.confirmed, true); assert.equal(result.credentialCalls, 0); await removed(f.id);
      assert.deepEqual(await f.source.inspect(credential), before);
      if (mode === 'rotated') { const lease = await f.source.acquire(credential); try { assert.equal(await lease.readSecret(), content('fixture-rotated-key')); } finally { await lease.release(); } }
      assert.equal(await readFile(join(f.root, 'source/numbers.json'), 'utf8'), '{"numbers":[1,2,3]}');
    } finally { await f.close(); }
  });
test('credential identity, transport and proxy drift refuse cleanup; Docker outage remains retryable', { skip: !enabled, timeout: 35000 }, async () => {
  const f = await setup('create_completed');
  try {
    const store = await SqliteRunRecordStore.open(join(f.root, 'db'));
    try {
      for (const mutate of [(r: any) => { r.execution.execution.privateState.credential.credentialRef = 'other'; }, (r: any) => { r.execution.execution.privateState.keys = ['OTHER_TOKEN']; },
        (r: any) => { r.execution.execution.egress.proxySha256 = '0'.repeat(64); }]) {
        const changed = structuredClone(f.record); mutate(changed); await store.compareAndSwap('run', (await store.read('run'))!.revision, changed);
        const bad = child(f.root, 'restore', ''); assert.notEqual((await bad.exited)[0], 0);
        assert.equal(await docker(['inspect', '--format', '{{.State.Status}}', f.id]), 'created');
      }
      await store.compareAndSwap('run', (await store.read('run'))!.revision, f.record);
    } finally { store.close(); }
    const failed = await output(child(f.root, 'outage', '')); assert.equal(failed.confirmed, false); assert.equal(failed.credentialCalls, 0);
    assert.equal((await output(child(f.root, 'restore', ''))).confirmed, true); await removed(f.id);
  } finally { await f.close(); }
});
test('model resource save failure creates no process and the already released source lease remains usable', { skip: !enabled, timeout: 25000 }, async () => {
  const f = await rootAt();
  try {
    const { result } = await output(child(f.root, 'run', 'save-fail'));
    assert.equal(result.stage, 'execution'); assert.equal(result.runner.phase, 'failed'); assert.equal(result.runner.cleanup, 'removed');
    assert.ok(result.runner.diagnostics.includes('RESOURCE_PERSISTENCE_FAILED')); assert.equal(result.authentication.status, 'released');
    assert.equal((await output(child(f.root, 'restore', ''))).confirmed, true);
    const lease = await f.source.acquire(credential); await lease.release();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('a host killed inside credential acquisition leaves a busy lease, not an automatically recovered execution', { skip: !enabled, timeout: 15000 }, async () => {
  const f = await rootAt(), c = child(f.root, 'lease', 'lease');
  try {
    await Promise.race([once(c.process, 'message'), c.exited.then(() => { throw new Error(c.output().stderr); })]); c.process.kill('SIGKILL'); await c.exited;
    await assert.rejects(f.source.acquire(credential), /CREDENTIAL_BUSY/);
    const rejected = child(f.root, 'restore', ''); assert.notEqual((await rejected.exited)[0], 0);
    await assert.rejects(f.source.acquire(credential), /CREDENTIAL_BUSY/);
  } finally { if (c.process.exitCode === null && c.process.signalCode === null) { c.process.kill('SIGKILL'); await c.exited; } await rm(f.root, { recursive: true, force: true }); }
});
test('subscription execution resource definitions remain refused without accessing its store', { skip: !enabled }, async () => {
  let calls = 0; const forbidden = async () => { calls++; throw new Error('no credentials'); };
  const runtime = new CodexSubscriptionRunner({ acquire: forbidden, inspect: forbidden, configure: forbidden, delete: forbidden }, { workspaceRoot: '/tmp/unused-subscription-resource', image, proxyImage: 'node:22-bookworm-slim' });
  await assert.rejects(runtime.executionResourceDefinition({ id: 'test', credentialRef: 'fixture', service: 'openai', method: 'subscription', endpoint: 'official', capacity: 1 }), /CREDENTIAL_RESOURCE_RESTORE_UNAVAILABLE/);
  assert.equal(calls, 0);
});

test('ordinary Agent run reserves execution before any await so a late first definition cannot race it', { skip: !enabled, timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-definition-race-'));
  let calls = 0; const forbidden = async () => { calls++; throw new Error('no credentials'); };
  const runtime = new CodexSubscriptionRunner({ acquire: forbidden, inspect: forbidden, configure: forbidden, delete: forbidden },
    { workspaceRoot: root, image: 'agentflow-test/missing-definition:does-not-exist', proxyImage: 'node:22-bookworm-slim' });
  const pending = runtime.run({ task: { identity: { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 }, prompt: 'fixture', config: { model: 'fixture', search: false, subagents: false } },
    profile: { id: 'test', credentialRef: 'fixture', service: 'openai', method: 'subscription', endpoint: 'official', capacity: 1 }, inputSource: root, timeoutMs: 1000 });
  const rejectedRun = assert.rejects(pending);
  try { await assert.rejects(runtime.versionProbeDefinition(), /EXECUTION_DEFINITION_AFTER_START/); await rejectedRun; assert.equal(calls, 0); }
  finally { await rm(root, { recursive: true, force: true }); }
});
