import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { Runner, compileWorkflow, WorkflowRuntime, claimWorkflowRecovery, loadWorkflowCheckpoint } from '@agentflow/engine';
import { DockerBackend, SqliteRunRecordStore, systemClock } from '@agentflow/integrations';
const [root, operation, stage] = process.argv.slice(2);
const db = await SqliteRunRecordStore.open(join(root, 'db')), calls = [];
let paused = false;
const store = { create: db.create.bind(db), read: db.read.bind(db), compareAndSwap: async (id, revision, content) => {
  const next = await db.compareAndSwap(id, revision, content);
  const attempt = content.schema === 'agentflow-workflow-checkpoint/v5' ? content.attempts.findLast(a => a.resultStep === null && !a.interrupted) : null;
  const phase = attempt?.phases?.at(-1);
  if (!paused && ['run', 'resume-pause'].includes(operation) && attempt?.node === 'b' && phase?.id === stage
    && (phase.kind === 'operation' ? phase.status === 'active' : phase.launch === 'start_completed' && phase.status === 'active')) {
    paused = true; process.send({ event: 'paused', attempt: attempt.identity, phase: stage }); await new Promise(() => setInterval(() => {}, 1000));
  }
  return next;
} };
const backend = phase => new DockerBackend({ workspaceRoot: join(root, 'attempts', phase), image: 'alpine:3' });
const executor = {
  validate() {}, check: () => [], contract: id => ({ kind: 'json', id }), contractDefinition: id => ({ kind: 'json', id, schema: { type: 'string' } }),
  executionDefinition: async c => ({ schema: 'test-phased-execution/v1', component: c.id, command: ['sh', '-c', 'sleep 1; printf B'] }),
  resourcePlan: async c => c.id === 'a' ? null : { schema: 'agentflow-invocation-resources/v1', phases: [
    { id: 'check', kind: 'resource', execution: await backend('check').definition() }, { id: 'local', kind: 'operation' }, { id: 'execute', kind: 'resource', execution: await backend('execute').definition() } ] },
  restorePhaseResource: async (_c, phase, record) => new Runner(backend(phase), systemClock).restore(record),
  execute: async (c, input, identity, cancellation, _single, phases) => {
    calls.push({ node: c.id, identity });
    if (c.id === 'a') return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input + 'A' };
    let output;
    for (const id of ['check', 'local', 'execute']) {
      const phase = await phases.enter(id);
      if (id === 'local') { await phase.complete(); continue; }
      const runner = new Runner(backend(id), systemClock);
      const result = await runner.run({ identity, inputSource: join(root, 'source'), timeoutMs: 10000, invocation: { argv: ['sh', '-c', 'sleep 1; printf B'] } }, cancellation, phase.resource);
      if (result.phase !== 'exited' || result.exitCode !== 0 || result.stop !== 'confirmed' || result.cleanup !== 'removed') throw new Error('TEST_EXECUTION_FAILED');
      output = await readFile(result.capture.stdout.path, 'utf8'); await runner.release(result.resource); await phase.complete();
    }
    return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input + output };
  },
};
const value = { kind: 'json', id: 'value' };
const flow = compileWorkflow({ id: 'phase-workflow', start: 'a', maxSteps: 2, input: value, outcomes: { done: value }, nodes: { a: { component: 'a' }, b: { component: 'b' } },
  routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] },
  { resolve: id => ({ component: { id, kind: 'transform', implementation: id, inputContract: 'value', outcomes: { ok: 'value' } }, executor }) });
try {
  if (operation === 'run') { await mkdir(join(root, 'source'), { recursive: true }); const h = await new WorkflowRuntime().startPersisted(flow, 'run', 'seed', store); const result = await h.completion; if (result.status !== 'succeeded') throw new Error(result.reason); }
  else if (operation === 'load') { const loaded = await loadWorkflowCheckpoint(flow, 'run', store); process.stdout.write(JSON.stringify({ checkpoint: loaded.checkpoint, calls })); await loaded.dispose(); }
  else {
    const recovery = await claimWorkflowRecovery(flow, 'run', store); await recovery.cleanup();
    const handle = await new WorkflowRuntime().resumePersisted(recovery); const result = await handle.completion;
    process.stdout.write(JSON.stringify({ result, calls })); await handle.dispose();
  }
} catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
finally { db.close(); }
