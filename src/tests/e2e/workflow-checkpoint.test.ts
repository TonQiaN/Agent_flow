import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { WorkflowCheckpoint } from '@agentflow/engine';
import { SqliteRunRecordStore } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const fixture = fileURLToPath(new URL('../fixtures/workflow-checkpoint.mjs', import.meta.url));
function child(root: string, mode: string, definitionMode = 'run') {
  const process = fork(fixture, [root, mode, definitionMode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let stdout = '', stderr = ''; process.stdout!.on('data', b => { stdout += b; }); process.stderr!.on('data', b => { stderr += b; });
  return { process, exited: once(process, 'exit'), output: () => ({ stdout, stderr }) };
}
for (const interrupt of [false, true]) test(`persisted real script Workflow retains accepted files in a fresh process; SIGKILL=${interrupt}`, { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-workflow-checkpoint-')); let resource: string | undefined, removable = false;
  const processes: ReturnType<typeof child>[] = [];
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
    const running = child(root, interrupt ? 'interrupt' : 'run'); processes.push(running);
    if (interrupt) {
      const [message] = await Promise.race([once(running.process, 'message'), running.exited.then(() => { throw new Error(running.output().stderr || 'worker exited before B started'); })]); assert.equal(message.event, 'b-started'); resource = message.resource.id;
      assert.match(resource!, /^af-[a-f0-9-]+$/);
      running.process.kill('SIGKILL'); assert.deepEqual(await running.exited, [null, 'SIGKILL']);
      // A host exit is not proof that its container stopped. Only this test-owned id is inspected/removed.
      assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', resource!]), 'true');
      await docker(['rm', '-f', resource!]); resource = undefined;
    } else {
      const [code] = await running.exited; assert.equal(code, 0, running.output().stderr);
      assert.equal(JSON.parse(running.output().stdout).status, 'succeeded');
    }
    assert.equal(await readFile(join(root, 'source/value.txt'), 'utf8'), 'seed');
    // Remove original inputs and all ephemeral state; only the Run DB and durable archive remain.
    for (const name of ['source', 'temporary', 'work', 'attempts']) await rm(join(root, name), { recursive: true, force: true });
    const reading = child(root, 'read'); processes.push(reading); const [code] = await reading.exited;
    assert.equal(code, 0, reading.output().stderr);
    const { record, texts } = JSON.parse(reading.output().stdout), checkpoint = record.content as WorkflowCheckpoint;
    assert.equal(checkpoint.schema, 'agentflow-workflow-checkpoint/v3'); assert.equal(checkpoint.execution.version, 1);
    assert.deepEqual(texts, interrupt ? ['seed', 'seedA'] : ['seed', 'seedA', 'seedAB']);
    assert.equal(checkpoint.snapshot.steps.length, interrupt ? 1 : 2);
    assert.equal(checkpoint.snapshot.status, interrupt ? 'running' : 'succeeded');
    assert.equal(checkpoint.cursor.node, interrupt ? 'b' : null);
    if (interrupt) assert.deepEqual(checkpoint.snapshot.currentIdentity, { runId: 'run', nodeTaskId: 'task-2', attemptId: 'attempt-1', attemptNumber: 1 });
    const accepted = checkpoint.values[1]!.saved as any;
    assert.equal(accepted.receipt.componentId, 'a'); assert.equal(accepted.receipt.script.identity.nodeTaskId, 'task-1');
    assert.equal(accepted.runId, 'run'); assert.deepEqual(accepted.receipt.predecessor, checkpoint.values[0]!.value);
    assert.deepEqual(accepted.value, checkpoint.snapshot.steps[0]!.result.status === 'accepted' && checkpoint.snapshot.steps[0]!.result.output);
    removable = true;
  } finally {
    for (const p of processes) if (p.process.exitCode === null && p.process.signalCode === null) p.process.kill('SIGKILL');
    if (resource) await docker(['rm', '-f', resource]);
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained checkpoint evidence: ${root}\n`);
  }
});

for (const interrupt of [false, true]) test(`trusted checkpoint loading restores independent file capabilities in a fresh process; live interrupted B=${interrupt}`, { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-workflow-load-')); let resource: string | undefined, removable = false;
  const processes: ReturnType<typeof child>[] = [];
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
    const running = child(root, interrupt ? 'interrupt' : 'run'); processes.push(running);
    if (interrupt) {
      const [message] = await Promise.race([once(running.process, 'message'), running.exited.then(() => { throw new Error(running.output().stderr || 'worker exited early'); })]);
      assert.equal(message.event, 'b-started'); resource = message.resource.id; assert.match(resource!, /^af-[a-f0-9-]+$/);
      running.process.kill('SIGKILL'); assert.deepEqual(await running.exited, [null, 'SIGKILL']);
      assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', resource!]), 'true');
    } else { const [code] = await running.exited; assert.equal(code, 0, running.output().stderr); }
    assert.equal(await readFile(join(root, 'source/value.txt'), 'utf8'), 'seed');
    for (const name of ['source', 'temporary', 'work', ...(!interrupt ? ['attempts'] : [])]) await rm(join(root, name), { recursive: true, force: true });
    const loading = child(root, 'load', interrupt ? 'interrupt' : 'run'); processes.push(loading); const [code] = await loading.exited;
    assert.equal(code, 0, loading.output().stderr);
    const result = JSON.parse(loading.output().stdout); assert.equal(result.error, undefined);
    assert.deepEqual(result.started, []); assert.deepEqual(result.texts, interrupt ? ['seed', 'seedA'] : ['seed', 'seedA', 'seedAB']);
    assert.equal(result.checkpoint.snapshot.status, interrupt ? 'running' : 'succeeded');
    if (resource) assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', resource]), 'true');
    removable = true;
  } finally {
    for (const p of processes) if (p.process.exitCode === null && p.process.signalCode === null) p.process.kill('SIGKILL');
    if (resource) await docker(['rm', '-f', resource]);
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained load evidence: ${root}\n`);
  }
});

test('fresh file restoration rejects stored receipt and manifest drift and rolls back earlier hydrated values', { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-workflow-load-invalid-')); let removable = false;
  const processes: ReturnType<typeof child>[] = [];
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
    const running = child(root, 'run'); processes.push(running); const [code] = await running.exited;
    assert.equal(code, 0, running.output().stderr);
    for (const name of ['source', 'temporary', 'work', 'attempts']) await rm(join(root, name), { recursive: true, force: true });
    const store = await SqliteRunRecordStore.open(join(root, 'db'));
    try {
      const original = (await store.read('run'))!.content;
      const mutations: ((c: any) => void)[] = [
        c => { c.values[1].saved.receipt.predecessor = c.values[1].value; },
        c => { c.values[1].saved.receipt.script.imageId = `sha256:${'0'.repeat(64)}`; },
        c => { c.values[1].saved.receipt.identity.attemptId = 'attempt-2'; },
        c => { c.values[1].saved.receipt.input.id = c.values[1].saved.manifest.id; },
        c => { c.values[1].saved.manifest.files[0].bytes++; },
        c => { c.values[1].saved.archive.sha256 = '0'.repeat(64); },
        c => { c.values[1].saved.receipt.extra = true; },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(original); mutate(changed);
        await store.compareAndSwap('run', (await store.read('run'))!.revision, changed);
        const loading = child(root, 'load'); processes.push(loading); const [loadCode] = await loading.exited;
        assert.equal(loadCode, 0, loading.output().stderr);
        const result = JSON.parse(loading.output().stdout); assert.equal(typeof result.error, 'string'); assert.deepEqual(result.started, []);
      }
      await store.compareAndSwap('run', (await store.read('run'))!.revision, original);
      const archived = join(root, 'archive', (original as any).values[1].saved.archive.id, 'data/value.txt');
      const bytes = await readFile(archived);
      for (const missing of [false, true]) {
        if (missing) await rm(archived); else await writeFile(archived, Buffer.alloc(bytes.length, 120));
        try {
          const loading = child(root, 'load'); processes.push(loading); const [loadCode] = await loading.exited;
          assert.equal(loadCode, 0, loading.output().stderr);
          const result = JSON.parse(loading.output().stdout); assert.equal(typeof result.error, 'string'); assert.deepEqual(result.started, []);
        } finally { await writeFile(archived, bytes, { mode: 0o600 }); }
      }
    } finally { store.close(); }
    const loading = child(root, 'load'); processes.push(loading); const [loadCode] = await loading.exited;
    assert.equal(loadCode, 0, loading.output().stderr); assert.deepEqual(JSON.parse(loading.output().stdout).texts, ['seed', 'seedA', 'seedAB']);
    removable = true;
  } finally {
    for (const p of processes) if (p.process.exitCode === null && p.process.signalCode === null) p.process.kill('SIGKILL');
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained invalid load evidence: ${root}\n`);
  }
});


test('real script output archive failure records failure without acceptance or successor execution', { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-checkpoint-archive-fail-')); let removable = false;
  const processes: ReturnType<typeof child>[] = [];
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
    const running = child(root, 'archive-fail'); processes.push(running); const [code] = await running.exited;
    assert.equal(code, 0, running.output().stderr);
    const result = JSON.parse(running.output().stdout);
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'WORKFLOW_VALUE_PERSISTENCE_FAILED');
    assert.deepEqual(result.started, ['a']); assert.deepEqual(result.steps, []);
    const reading = child(root, 'read'); processes.push(reading); const [readCode] = await reading.exited;
    assert.equal(readCode, 0, reading.output().stderr);
    const { record, texts } = JSON.parse(reading.output().stdout);
    assert.equal(record.content.snapshot.status, 'failed'); assert.equal(record.content.snapshot.lastAccepted, null);
    assert.deepEqual(texts, ['seed']); removable = true;
  } finally {
    for (const p of processes) if (p.process.exitCode === null && p.process.signalCode === null) p.process.kill('SIGKILL');
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained checkpoint evidence: ${root}\n`);
  }
});

for (const beforeCreate of [true, false]) test(`Workflow Attempt resource from its own CAS supports fresh common Runner cleanup after SIGKILL; beforeCreate=${beforeCreate}`, { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-workflow-resource-')); let resource: string | undefined, removable = false;
  const processes: ReturnType<typeof child>[] = [];
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
    const running = child(root, beforeCreate ? 'resource-pause' : 'interrupt'); processes.push(running);
    const [message] = await Promise.race([once(running.process, 'message'), running.exited.then(() => { throw new Error(running.output().stderr || 'worker exited early'); })]);
    assert.equal(message.event, beforeCreate ? 'resource-saved' : 'b-started'); resource = message.resource.id; assert.match(resource!, /^af-[a-f0-9-]+$/);
    running.process.kill('SIGKILL'); assert.deepEqual(await running.exited, [null, 'SIGKILL']);
    if (beforeCreate) assert.equal(await docker(['container', 'ls', '--all', '--filter', `name=^/${resource}$`, '--format', '{{.ID}}']), '');
    else assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', resource!]), 'true');
    for (const name of ['source', 'temporary', 'work']) await rm(join(root, name), { recursive: true, force: true });
    const loading = child(root, 'recover-resource', beforeCreate ? 'run' : 'interrupt'); processes.push(loading); const [code] = await loading.exited;
    assert.equal(code, 0, loading.output().stderr); const result = JSON.parse(loading.output().stdout);
    assert.equal(result.error, undefined); assert.deepEqual(result.started, []);
    assert.deepEqual(result.texts, beforeCreate ? ['seed'] : ['seed', 'seedA']);
    assert.equal(result.recovered.length, 1); assert.equal(result.recovered[0].node, beforeCreate ? 'a' : 'b');
    assert.equal(result.recovered[0].observation.state, beforeCreate ? 'absent' : 'running'); assert.equal(result.recovered[0].confirmed, true);
    assert.equal(result.checkpoint.attempts.at(-1).resource.resource.id, resource);
    assert.equal(result.checkpoint.attempts.at(-1).resultStep, null);
    assert.equal(await docker(['container', 'ls', '--all', '--filter', `name=^/${resource}$`, '--format', '{{.ID}}']), ''); removable = true;
  } finally {
    for (const p of processes) if (p.process.exitCode === null && p.process.signalCode === null) p.process.kill('SIGKILL');
    if (resource) await docker(['rm', '-f', resource]).catch(() => {});
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained Workflow resource evidence: ${root}\n`);
  }
});
test('Workflow resource CAS failure prevents actual container creation and all successor execution', { skip: !enabled, timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-workflow-resource-fail-')); let removable = false;
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
    const running = child(root, 'resource-fail'); const [code] = await running.exited;
    assert.equal(code, 0, running.output().stderr); const result = JSON.parse(running.output().stdout);
    assert.equal(result.status, 'failed'); assert.deepEqual(result.started, []); assert.deepEqual(result.created, []);
    assert.equal(result.steps.length, 1); assert.equal(result.steps[0].result.status, 'failed');
    assert.equal(result.steps[0].result.code, 'SCRIPT_EXECUTION_FAILED'); assert.equal(result.steps[0].result.stopped, true);
    const store = await SqliteRunRecordStore.open(join(root, 'db'));
    try {
      const checkpoint = (await store.read('run'))!.content as any;
      assert.equal(checkpoint.attempts.length, 1); assert.equal(checkpoint.attempts[0].resource, null);
      assert.equal(checkpoint.attempts[0].resultStep, null); assert.equal(checkpoint.snapshot.status, 'running');
      assert.deepEqual(checkpoint.snapshot.steps, []);
    } finally { store.close(); }
    removable = true;
  } finally { if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained resource CAS evidence: ${root}\n`); }
});

for (const [mode, launch, expected] of [
  ['pause-prepare_pending', 'prepare_pending', 'absent'], ['pause-prepare_completed', 'prepare_completed', 'absent'],
  ['pause-create_pending', 'create_pending', 'absent'], ['pause-create_completed', 'create_completed', 'created'],
  ['pause-start_pending', 'start_pending', 'created'], ['pause-start_completed', 'start_completed', 'running'],
  ['inside-create', 'create_pending', 'created'], ['inside-start', 'start_pending', 'running'],
] as const) test(`durable launch journal survives actual host SIGKILL: ${mode}`, { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-launch-journal-')); let resource: string | undefined, removable = false;
  const processes: ReturnType<typeof child>[] = [];
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
    const running = child(root, `journal-${mode}`); processes.push(running);
    const [message] = await Promise.race([once(running.process, 'message'), running.exited.then(() => { throw new Error(running.output().stderr || 'early exit'); })]);
    resource = message.resource.id; assert.match(resource!, /^af-[a-f0-9-]+$/); assert.equal(message.launch, launch);
    running.process.kill('SIGKILL'); assert.deepEqual(await running.exited, [null, 'SIGKILL']);
    if (expected === 'absent') assert.equal(await docker(['container', 'ls', '--all', '--filter', `name=^/${resource}$`, '--format', '{{.ID}}']), '');
    else assert.equal(await docker(['inspect', '--format', '{{.State.Status}}', resource!]), expected);
    for (const name of ['temporary', 'work']) await rm(join(root, name), { recursive: true, force: true });
    const loading = child(root, 'load', `journal-${mode}`); processes.push(loading); const [code] = await loading.exited;
    assert.equal(code, 0, loading.output().stderr); const result = JSON.parse(loading.output().stdout);
    assert.equal(result.error, undefined); assert.equal(result.checkpoint.attempts[0].launch, launch);
    assert.equal(result.checkpoint.attempts[0].resource.resource.id, resource); assert.equal(result.checkpoint.attempts[0].resultStep, null);
    assert.deepEqual(result.started, []); assert.deepEqual(result.texts, ['seed']);
    assert.equal(await readFile(join(root, 'source/value.txt'), 'utf8'), 'seed'); removable = true;
  } finally {
    for (const p of processes) if (p.process.exitCode === null && p.process.signalCode === null) { p.process.kill('SIGKILL'); await p.exited; }
    // Test-owned cleanup only: the fixture was killed at a known paused boundary; this is not automatic recovery authority.
    if (resource) await docker(['rm', '-f', resource]).catch(() => {});
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained launch journal evidence: ${root}\n`);
  }
});

for (const [mode, phase, previous, created, started] of [
  ['fail', 'create_pending', 'prepare_completed', [], []], ['fail', 'create_completed', 'create_pending', ['a'], []],
  ['fail', 'start_pending', 'create_completed', ['a'], []], ['fail', 'start_completed', 'start_pending', ['a'], ['a']],
  ['conflict', 'create_pending', 'prepare_completed', [], []],
] as const) test(`real launch CAS failure does not issue any later operation: ${mode}-${phase}`, { skip: !enabled, timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-launch-rejected-')); let removable = false;
  const runningProcesses: ReturnType<typeof child>[] = [];
  try {
    await mkdir(join(root, 'source')); await writeFile(join(root, 'source/value.txt'), 'seed');
    const running = child(root, `journal-${mode}-${phase}`); runningProcesses.push(running); const [code] = await running.exited;
    assert.equal(code, 0, running.output().stderr); const result = JSON.parse(running.output().stdout);
    assert.equal(result.status, 'failed'); assert.deepEqual(result.created, created); assert.deepEqual(result.started, started);
    const store = await SqliteRunRecordStore.open(join(root, 'db'));
    try {
      const record = (await store.read('run'))!.content as any, attempt = record.attempts[0];
      assert.equal(attempt.launch, previous); assert.equal(attempt.resultStep, null); assert.deepEqual(record.snapshot.steps, []);
      assert.equal(await docker(['container', 'ls', '--all', '--filter', `name=^/${attempt.resource.resource.id}$`, '--format', '{{.ID}}']), '');
    } finally { store.close(); }
    removable = true;
  } finally {
    for (const p of runningProcesses) if (p.process.exitCode === null && p.process.signalCode === null) { p.process.kill('SIGKILL'); await p.exited; }
    if (removable) await rm(root, { recursive: true, force: true }); else process.stderr.write(`Retained launch failure evidence: ${root}\n`);
  }
});
