import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
function child(root: string, operation: string, stage: string) {
  const process = fork(new URL('../fixtures/phase-workflow.mjs', import.meta.url), [root, operation, stage], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let stdout = '', stderr = ''; process.stdout!.on('data', b => { stdout += b; }); process.stderr!.on('data', b => { stderr += b; });
  const timer = setTimeout(() => process.kill('SIGKILL'), 25000), exited = once(process, 'exit').finally(() => clearTimeout(timer));
  return { process, exited, output: () => ({ stdout, stderr }) };
}
async function killAt(root: string, operation: string, stage: string) {
  const c = child(root, operation, stage);
  try { const [message] = await Promise.race([once(c.process, 'message'), c.exited.then(() => { throw new Error(c.output().stderr || 'no pause'); })]); return message; }
  finally { if (c.process.exitCode === null && c.process.signalCode === null) { c.process.kill('SIGKILL'); await c.exited; } }
}
async function content(root: string) { const store = await SqliteRunRecordStore.open(join(root, 'db')); try { return (await store.read('run'))!; } finally { store.close(); } }
async function cleanup(root: string) {
  const record: any = (await content(root))?.content, c = record?.checkpoint ?? record;
  for (const a of c?.attempts ?? []) for (const p of a.phases ?? []) if (p.resource) await docker(['rm', '-f', p.resource.resource.id]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
for (const [stage, interruptions] of [['check', 1], ['execute', 1], ['execute', 2]] as const)
  test(`real phased Workflow cleans all old resources and resumes only B: ${stage}/${interruptions}`, { skip: !enabled, timeout: 35000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'af-phased-workflow-'));
    try {
      await killAt(root, 'run', stage);
      if (interruptions === 2) { const message = await killAt(root, 'resume-pause', stage); assert.equal(message.attempt.attemptNumber, 2); }
      const before: any = (await content(root)).content;
      const ids = before.attempts.flatMap((a: any) => (a.phases ?? []).flatMap((p: any) => p.resource ? [p.resource.resource.id] : []));
      const c = child(root, 'resume', ''); assert.equal((await c.exited)[0], 0, c.output().stderr); const result = JSON.parse(c.output().stdout);
      assert.equal(result.result.status, 'succeeded'); assert.equal(result.result.lastAccepted.result.output, 'seedAB');
      assert.deepEqual(result.calls.map((r: any) => r.node), ['b']); assert.equal(result.calls[0].identity.attemptNumber, interruptions + 1);
      for (const id of ids) assert.equal(await docker(['container', 'ls', '-a', '--filter', `name=^/${id}$`, '--format', '{{.ID}}']), '');
      const saved = await content(root), loaded = child(root, 'load', ''); assert.equal((await loaded.exited)[0], 0, loaded.output().stderr);
      const actual = JSON.parse(loaded.output().stdout); assert.equal(actual.checkpoint.cursor.value, 'seedAB'); assert.deepEqual(actual.calls, []); assert.deepEqual(await content(root), saved);
    } finally { await cleanup(root); }
  });
test('real phased Workflow refuses takeover inside an unfinished host operation without touching its saved record', { skip: !enabled, timeout: 25000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-phased-operation-'));
  try {
    await killAt(root, 'run', 'local'); const before = await content(root);
    const c = child(root, 'resume', ''); assert.notEqual((await c.exited)[0], 0); assert.match(c.output().stderr, /WORKFLOW_LAUNCH_UNCONFIRMED/);
    assert.deepEqual(await content(root), before);
  } finally { await cleanup(root); }
});
