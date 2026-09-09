import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const fixture = fileURLToPath(new URL('../fixtures/workflow-checkpoint.mjs', import.meta.url));
function child(root: string, operation: string, mode = 'recovery-running') {
  const process = fork(fixture, [root, operation, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let stdout = '', stderr = ''; process.stdout!.on('data', b => { stdout += b; }); process.stderr!.on('data', b => { stderr += b; });
  return { process, exited: once(process, 'exit'), output: () => ({ stdout, stderr }) };
}
async function message(p: ReturnType<typeof child>) {
  const timer = setTimeout(() => p.process.kill('SIGKILL'), 20000);
  try {
    const [value] = await Promise.race([once(p.process, 'message'), p.exited.then(() => { throw new Error(p.output().stderr || p.output().stdout || 'early exit'); })]);
    return value;
  } finally { clearTimeout(timer); }
}
async function output(p: ReturnType<typeof child>) {
  const timer = setTimeout(() => p.process.kill('SIGKILL'), 20000);
  try { const [code] = await p.exited; assert.equal(code, 0, p.output().stderr); return JSON.parse(p.output().stdout); }
  finally { clearTimeout(timer); }
}
async function setup(mode = 'recovery-running') {
  const root = await mkdtemp(join(tmpdir(), 'af-workflow-recovery-'));
  await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
  const processes: ReturnType<typeof child>[] = [], worker = child(root, mode); processes.push(worker);
  const ready = await message(worker), resource = ready.resource.id; assert.match(resource, /^af-[a-f0-9-]+$/);
  const store = await SqliteRunRecordStore.open(join(root, 'db'));
  return { root, worker, resource, store,
    spawn: (operation: string) => { const p = child(root, operation, mode); processes.push(p); return p; },
    close: async () => {
      for (const p of processes) if (p.process.exitCode === null && p.process.signalCode === null) { p.process.kill('SIGKILL'); await p.exited; }
      await docker(['rm', '-f', resource]).catch(() => {}); store.close(); await rm(root, { recursive: true, force: true });
    } };
}

for (const mode of ['recovery-allocated', 'recovery-running']) test(`real recovery CAS fences a live host at ${mode} and cleans only its old resource`, { skip: !enabled, timeout: 40000 }, async () => {
  const f = await setup(mode);
  try {
    const before = (await f.store.read('run'))!;
    const recovered = await output(f.spawn('claim'));
    assert.equal(recovered.error, undefined); assert.equal(recovered.result.resourceRemoved, true);
    assert.deepEqual(recovered.result.checkpoint, before.content); assert.deepEqual(recovered.started, []); assert.deepEqual(recovered.created, []);
    assert.deepEqual(recovered.restored, [mode === 'recovery-running' ? 'b' : 'a']);
    assert.deepEqual(recovered.texts, mode === 'recovery-running' ? ['seed', 'seedA'] : ['seed']);
    assert.equal(await docker(['container', 'ls', '--all', '--filter', `name=^/${f.resource}$`, '--format', '{{.ID}}']), '');
    const committed = await f.store.read('run');
    f.worker.process.send('continue'); const old = await output(f.worker);
    assert.equal(old.status, 'failed'); assert.deepEqual(await f.store.read('run'), committed);
    if (mode === 'recovery-allocated') { assert.deepEqual(old.created, []); assert.deepEqual(old.started, []); }
    else { assert.deepEqual(old.created, ['a', 'b']); assert.deepEqual(old.started, ['a', 'b']); }
    assert.equal(await readFile(join(f.root, 'source/value.txt'), 'utf8'), 'seed');
    const inspected = await output(f.spawn('load')); assert.equal(inspected.error, undefined);
    assert.equal(inspected.recovery.resourceRemoved, true); assert.deepEqual(inspected.started, []);
    assert.deepEqual(await f.store.read('run'), committed);
  } finally { await f.close(); }
});

test('two fresh recovery processes compete for one actual SQLite revision without loser cleanup', { skip: !enabled, timeout: 40000 }, async () => {
  const f = await setup();
  try {
    f.worker.process.kill('SIGKILL'); await f.worker.exited;
    const one = f.spawn('claim-barrier'), two = f.spawn('claim-barrier');
    const reads = await Promise.all([message(one), message(two)]); assert.equal(reads[0].revision, reads[1].revision);
    one.process.send('go'); two.process.send('go'); const results = await Promise.all([output(one), output(two)]);
    const winner = results.filter(r => !r.error), loser = results.filter(r => r.error);
    assert.equal(winner.length, 1); assert.equal(loser.length, 1); assert.equal(loser[0].error, 'RUN_REVISION_CONFLICT');
    assert.deepEqual(loser[0].restored, []); assert.deepEqual(winner[0].restored, ['b']); assert.equal(winner[0].result.resourceRemoved, true);
    assert.equal((await f.store.read('run'))!.revision, winner[0].result.revision);
  } finally { await f.close(); }
});

for (const operation of ['claim-pause', 'claim-before-complete', 'claim-after-complete']) test(`a killed recovery process preserves restartable coordination at ${operation}`, { skip: !enabled, timeout: 40000 }, async () => {
  const f = await setup();
  try {
    f.worker.process.kill('SIGKILL'); await f.worker.exited;
    const recovering = f.spawn(operation); await message(recovering);
    recovering.process.kill('SIGKILL'); await recovering.exited;
    const interrupted = (await f.store.read('run'))!;
    assert.equal((interrupted.content as any).schema, 'agentflow-workflow-recovery/v1');
    assert.equal((interrupted.content as any).resourceRemoved, operation === 'claim-after-complete');
    const result = await output(f.spawn('claim')); assert.equal(result.error, undefined); assert.equal(result.result.resourceRemoved, true);
    assert.ok(result.result.claimRevision > (interrupted.content as any).claimRevision);
    assert.deepEqual(result.result.checkpoint, (interrupted.content as any).checkpoint);
    assert.deepEqual(result.restored, operation === 'claim-after-complete' ? [] : ['b']);
    assert.deepEqual(result.started, []); assert.deepEqual(result.texts, ['seed', 'seedA']);
  } finally { await f.close(); }
});

test('pending create refuses automatic recovery and preserves the original record and live host', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await setup('recovery-pending');
  try {
    const before = await f.store.read('run'), result = await output(f.spawn('claim'));
    assert.equal(result.error, 'WORKFLOW_LAUNCH_UNCONFIRMED'); assert.deepEqual(result.restored, []); assert.deepEqual(await f.store.read('run'), before);
    f.worker.process.send('continue'); assert.equal((await output(f.worker)).status, 'succeeded');
  } finally { await f.close(); }
});

test('Docker outage after claim keeps recovery unconfirmed; a new process can later finish it', { skip: !enabled, timeout: 40000 }, async () => {
  const f = await setup();
  try {
    f.worker.process.kill('SIGKILL'); await f.worker.exited;
    const failed = await output(f.spawn('claim-query-fail')); assert.equal(typeof failed.error, 'string');
    assert.equal((await f.store.read('run') as any).content.resourceRemoved, false);
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', f.resource]), 'true');
    const result = await output(f.spawn('claim')); assert.equal(result.error, undefined); assert.equal(result.result.resourceRemoved, true);
    assert.deepEqual(result.started, []);
  } finally { await f.close(); }
});
