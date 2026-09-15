import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const image = `agentflow-test/version-resource:${randomUUID()}`;
let build: string | undefined;
before(async () => {
  if (!enabled) return;
  build = await mkdtemp(join(tmpdir(), 'af-version-build-'));
  await writeFile(join(build, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --chmod=755 codex /usr/local/bin/codex\n');
  await writeFile(join(build, 'codex'), "#!/usr/bin/env node\nif(!process.argv.includes('--version'))process.exit(9);setTimeout(()=>console.log('codex-cli 0.153.4'),2000);\n");
  execFileSync('docker', ['build', '--network', 'none', '--pull=false', '--tag', image, build], { stdio: 'pipe', timeout: 60000 });
});
after(async () => { if (build) { await docker(['image', 'rm', image]).catch(() => {}); await rm(build, { recursive: true, force: true }); } });
function child(root: string, operation: string, stage: string) {
  const process = fork(new URL('../fixtures/version-resource.mjs', import.meta.url), [root, operation, stage, image], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let stdout = '', stderr = ''; process.stdout!.on('data', b => { stdout += b; }); process.stderr!.on('data', b => { stderr += b; });
  const timer = setTimeout(() => process.kill('SIGKILL'), 20000); const exited = once(process, 'exit').finally(() => clearTimeout(timer));
  return { process, exited, output: () => ({ stdout, stderr }) };
}
async function restore(root: string, operation = 'restore') {
  const c = child(root, operation, ''); const [code] = await c.exited;
  assert.equal(code, 0, c.output().stderr); return JSON.parse(c.output().stdout);
}
for (const stage of ['allocated', 'create_completed', 'start_completed', 'complete', 'workspace-missing']) test(`actual Agent version resource survives SIGKILL before credentials: ${stage}`, { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-version-resource-')); let resource: string | undefined;
  const c = child(root, 'run', stage === 'workspace-missing' ? 'start_completed' : stage);
  try {
    const [message] = await Promise.race([once(c.process, 'message'), c.exited.then(() => { throw new Error(c.output().stderr || 'probe exited before pause'); })]);
    assert.equal(message.credentialCalls, 0); c.process.kill('SIGKILL'); assert.deepEqual(await c.exited, [null, 'SIGKILL']);
    const store = await SqliteRunRecordStore.open(join(root, 'db')); const record: any = (await store.read('run'))!.content; store.close();
    resource = record.checkpoint.runner.resource.id;
    assert.equal(record.checkpoint.definition.backend.options.network, 'none'); assert.deepEqual(record.checkpoint.definition.argv, ['codex', '--version']);
    if (stage === 'workspace-missing') await rm(join(root, 'attempts'), { recursive: true, force: true });
    const result = await restore(root);
    assert.equal(result.credentialCalls, 0); assert.equal(result.confirmed, true);
    if (stage === 'allocated' || stage === 'complete') assert.equal(result.query.state, 'absent');
    else if (stage === 'create_completed') assert.equal(result.query.state, 'created');
    else assert.ok(['running', 'exited'].includes(result.query.state));
    assert.equal(await docker(['container', 'ls', '--all', '--filter', `name=^/${resource}$`, '--format', '{{.ID}}']), '');
  } finally { if (c.process.exitCode === null && c.process.signalCode === null) { c.process.kill('SIGKILL'); await c.exited; } if (resource) await docker(['rm', '-f', resource]).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
for (const stage of ['save-fail', 'launch-fail', 'complete-fail']) test(`probe ${stage} blocks credential acquisition and keeps common cleanup`, { skip: !enabled, timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-version-reject-'));
  try {
    const c = child(root, 'run', stage); assert.equal((await c.exited)[0], 0, c.output().stderr);
    const { result, credentialCalls } = JSON.parse(c.output().stdout);
    assert.equal(credentialCalls, 0); assert.equal(result.stage, 'version'); assert.equal(result.runner.cleanup, 'removed');
    if (stage === 'complete-fail') { assert.equal(result.version.actual, '0.153.4'); assert.deepEqual(result.diagnostics, ['VERSION_COMPLETION_NOT_PERSISTED']); }
    else { assert.equal(result.runner.phase, 'failed'); assert.ok(result.runner.diagnostics.includes('RESOURCE_PERSISTENCE_FAILED')); }
    assert.equal((await restore(root)).query.state, 'absent');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('probe definition mismatch and Docker outage never become cleanup proof', { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-version-drift-')); let resource: string | undefined;
  const c = child(root, 'run', 'create_completed');
  try {
    await Promise.race([once(c.process, 'message'), c.exited.then(() => { throw new Error(c.output().stderr); })]); c.process.kill('SIGKILL'); await c.exited;
    const store = await SqliteRunRecordStore.open(join(root, 'db'));
    try {
      const original: any = (await store.read('run'))!.content; resource = original.checkpoint.runner.resource.id;
      for (const mutate of [(v: any) => { v.checkpoint.definition.expected = 'other'; }, (v: any) => { v.checkpoint.definition.argv = ['other']; },
        (v: any) => { v.checkpoint.runner.backend.identity.runId = 'other'; }]) {
        const changed = structuredClone(original); mutate(changed); await store.compareAndSwap('run', (await store.read('run'))!.revision, changed);
        const rejected = child(root, 'restore', ''); assert.notEqual((await rejected.exited)[0], 0);
        assert.equal(await docker(['inspect', '--format', '{{.State.Status}}', resource!]), 'created');
      }
      await store.compareAndSwap('run', (await store.read('run'))!.revision, original);
    } finally { store.close(); }
    const outage = await restore(root, 'outage'); assert.equal(outage.confirmed, false); assert.equal(typeof outage.error, 'string'); assert.equal(outage.credentialCalls, 0);
    assert.equal((await restore(root)).confirmed, true);
  } finally { if (c.process.exitCode === null && c.process.signalCode === null) { c.process.kill('SIGKILL'); await c.exited; } if (resource) await docker(['rm', '-f', resource]).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
