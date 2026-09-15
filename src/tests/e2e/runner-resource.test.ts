import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const fixture = fileURLToPath(new URL('../fixtures/runner-resource.mjs', import.meta.url));
function child(root: string, operation: string, stage: string) {
  const process = fork(fixture, [root, operation, stage], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let stdout = '', stderr = ''; process.stdout!.on('data', b => { stdout += b; }); process.stderr!.on('data', b => { stderr += b; });
  return { process, exited: once(process, 'exit'), output: () => ({ stdout, stderr }) };
}
async function setup(stage: string) {
  const root = await mkdtemp(join(tmpdir(), 'af-runner-resource-'));
  await mkdir(join(root, 'source')); await writeFile(join(root, 'source/input.txt'), 'original');
  const running = child(root, 'run', stage);
  const [message] = await Promise.race([once(running.process, 'message'), running.exited.then(() => { throw new Error(running.output().stderr || 'exited before pause'); })]);
  assert.equal(message.event, 'paused'); assert.match(message.resource.id, /^af-[a-f0-9-]+$/);
  running.process.kill('SIGKILL'); assert.deepEqual(await running.exited, [null, 'SIGKILL']);
  return { root, resource: message.resource.id as string };
}
for (const mode of ['allocated', 'created', 'running', 'exited', 'workspace-missing', 'container-missing']) test(`Runner restores actual durable ownership and removes old execution after SIGKILL: ${mode}`, { skip: !enabled, timeout: 25000 }, async () => {
  const stage = mode.endsWith('-missing') ? 'running' : mode;
  const { root, resource } = await setup(stage); let removable = false;
  try {
    if (mode === 'workspace-missing') await rm(join(root, 'attempts'), { recursive: true, force: true });
    if (mode === 'container-missing') await docker(['rm', '-f', resource]);
    const restoring = child(root, 'restore', stage); const [code] = await restoring.exited;
    assert.equal(code, 0, restoring.output().stderr); const result = JSON.parse(restoring.output().stdout);
    assert.equal(result.confirmed, true); assert.equal(result.error, undefined);
    assert.equal(result.observation.state, mode === 'allocated' || mode === 'container-missing' ? 'absent' : mode === 'workspace-missing' ? 'running' : mode);
    if (mode === 'exited') assert.equal(result.observation.exitCode, 7);
    assert.equal(await docker(['container', 'ls', '--all', '--filter', `name=^/${resource}$`, '--format', '{{.ID}}']), '');
    assert.equal(await readFile(join(root, 'source/input.txt'), 'utf8'), 'original');
    assert.deepEqual(await readdir(join(root, 'attempts')).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []); removable = true;
  } finally {
    await docker(['rm', '-f', resource]).catch(() => {});
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained Runner evidence: ${root}\n`);
  }
});
test('resource persistence failure blocks actual Docker create/start and leaves its committed ownership inspectable', { skip: !enabled, timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-resource-save-fail-'));
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/input.txt'), 'original');
    const running = child(root, 'run', 'save-fail'); const [code] = await running.exited;
    assert.equal(code, 0, running.output().stderr); const result = JSON.parse(running.output().stdout);
    assert.equal(result.phase, 'failed'); assert.deepEqual(result.diagnostics, ['RESOURCE_PERSISTENCE_FAILED']);
    assert.equal(result.cleanup, 'removed'); assert.equal(result.capture.stdout.error, 'NOT_STARTED');
    const restoring = child(root, 'restore', 'save-fail'); const [restored] = await restoring.exited;
    assert.equal(restored, 0, restoring.output().stderr); assert.equal(JSON.parse(restoring.output().stdout).observation.state, 'absent');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('invalid resource records and replaced workspace marker refuse restoration without stopping the old container', { skip: !enabled, timeout: 25000 }, async () => {
  const { root, resource } = await setup('running'); let removable = false;
  try {
    const store = await SqliteRunRecordStore.open(join(root, 'db'));
    try {
      const original = (await store.read('run'))!.content;
      const mutations: ((r: any) => void)[] = [r => { r.execution.options.image = `sha256:${'0'.repeat(64)}`; },
        r => { r.backend.directory = join(root, 'source'); }, r => { r.backend.identity.runId = 'other'; }, r => { r.backend.extra = true; }, r => { r.resource.id = 'other'; }];
      for (const mutation of mutations) {
        const changed = structuredClone(original); mutation(changed); await store.compareAndSwap('run', (await store.read('run'))!.revision, changed);
        const restoring = child(root, 'restore', 'running'); const [code] = await restoring.exited;
        assert.notEqual(code, 0); assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', resource]), 'true');
      }
      await store.compareAndSwap('run', (await store.read('run'))!.revision, original);
      const marker = join((original as any).backend.directory, '.agentflow-resource.json'); const bytes = await readFile(marker);
      await writeFile(marker, '{}');
      const bad = child(root, 'restore', 'running'); assert.notEqual((await bad.exited)[0], 0);
      assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', resource]), 'true'); await writeFile(marker, bytes);
    } finally { store.close(); }
    const restoring = child(root, 'restore', 'running'); assert.equal((await restoring.exited)[0], 0, restoring.output().stderr); removable = true;
  } finally {
    await docker(['rm', '-f', resource]).catch(() => {});
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained invalid resource evidence: ${root}\n`);
  }
});
test('Docker query outage remains unconfirmed and a later common recovery can finish cleanup', { skip: !enabled, timeout: 20000 }, async () => {
  const { root, resource } = await setup('running');
  try {
    const unavailable = child(root, 'restore-unavailable', 'running'); const [code] = await unavailable.exited;
    assert.equal(code, 0, unavailable.output().stderr); const result = JSON.parse(unavailable.output().stdout);
    assert.equal(result.confirmed, false); assert.equal(typeof result.error, 'string');
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', resource]), 'true');
    const restored = child(root, 'restore', 'running'); assert.equal((await restored.exited)[0], 0, restored.output().stderr);
    assert.equal(JSON.parse(restored.output().stdout).confirmed, true);
  } finally { await docker(['rm', '-f', resource]).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
test('same container name with mismatched task ownership is not stopped or removed by restoration', { skip: !enabled, timeout: 15000 }, async () => {
  const { root, resource } = await setup('allocated');
  try {
    await docker(['run', '-d', '--name', resource, '--label', `agentflow.resource=${resource}`, '--label', 'agentflow.run=other', '--entrypoint', '/bin/sh', process.env['AGENTFLOW_TEST_IMAGE'] ?? 'alpine:3', '-c', 'sleep 60']);
    const restoring = child(root, 'restore', 'allocated'); const [code] = await restoring.exited;
    assert.equal(code, 0, restoring.output().stderr); const result = JSON.parse(restoring.output().stdout);
    assert.equal(result.confirmed, false); assert.equal(result.error, 'RESOURCE_EXECUTION_MISMATCH');
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', resource]), 'true');
  } finally { await docker(['rm', '-f', resource]); await rm(root, { recursive: true, force: true }); }
});
