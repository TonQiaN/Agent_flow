import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractRegistry, FileContractRegistry, ScriptExecutor, WorkflowRuntime, Runner, compileWorkflow, loadWorkflowCheckpoint, claimWorkflowRecovery } from '@agentflow/engine';
import { DockerBackend, FileArtifactStore, FileArtifactArchive, FileWorkflowCatalog, SqliteRunRecordStore, systemClock } from '@agentflow/integrations';

const [root, operation, definitionMode = 'run'] = process.argv.slice(2);
const recoveryOperation = operation.startsWith('claim');
const readingOperation = ['load', 'recover-resource'].includes(operation) || recoveryOperation;
const mode = readingOperation ? definitionMode : operation;
const contracts = new FileContractRegistry(new ContractRegistry());
contracts.register('files', { rules: [{ id: 'value', kind: 'file', match: 'value.txt', minCount: 1, maxCount: 1, mediaTypes: ['text/plain'], maxBytes: 1000 }], maxFiles: 1, maxTotalBytes: 1000, unmatched: 'reject' });
const archive = new FileArtifactArchive(join(root, 'archive'), contracts);
if (mode === 'archive-fail') {
  const capture = archive.capture.bind(archive); let calls = 0;
  archive.capture = async (...args) => { if (++calls === 2) throw new Error('injected archive failure'); return capture(...args); };
}
const store = await SqliteRunRecordStore.open(join(root, 'db'));
if ((!readingOperation || operation === 'claim-resume-pause') && (['resource-fail', 'resource-pause'].includes(mode) || mode.startsWith('journal-') || mode.startsWith('recovery-') || ['resume-running', 'network-resume'].includes(mode))) {
  const cas = store.compareAndSwap.bind(store);
  store.compareAndSwap = async (runId, revision, content) => {
    const attempt = content.attempts?.at(-1), resource = attempt?.resource;
    if (mode === `journal-fail-${attempt?.launch}`) throw new Error('launch CAS failure');
    if (mode === `journal-conflict-${attempt?.launch}`) {
      const competing = await SqliteRunRecordStore.open(join(root, 'db'));
      try { const current = await competing.read(runId); await competing.compareAndSwap(runId, current.revision, current.content); }
      finally { competing.close(); }
    }
    if (resource && mode === 'resource-fail') throw new Error('resource CAS failure');
    const record = await cas(runId, revision, content);
    const recoveryPause = (['resume-running', 'network-resume'].includes(mode) && attempt?.node === 'b' && attempt.launch === 'start_completed' && attempt.resultStep === null && !attempt.interrupted)
      || (mode === 'recovery-running' && attempt?.node === 'b' && attempt.launch === 'start_completed')
      || (mode === 'recovery-allocated' && attempt?.node === 'a' && attempt.launch === 'allocated')
      || (mode === 'recovery-pending' && attempt?.node === 'a' && attempt.launch === 'create_pending');
    if (resource && (mode === 'resource-pause' || mode === `journal-pause-${attempt.launch}` || recoveryPause)) {
      process.send({ event: 'resource-saved', resource: resource.resource, launch: attempt.launch, identity: attempt.identity });
      if (recoveryPause) await new Promise(resolve => process.once('message', resolve));
      else await new Promise(() => { setInterval(() => {}, 1000); });
    }
    return record;
  };
}
try {
  if (mode === 'read') {
    const record = await store.read('run'), texts = [];
    for (const [index, value] of record.content.values.entries()) {
      const path = join(root, `restored-${index}`); await archive.materialize(value.saved.archive, path);
      texts.push(await readFile(join(path, 'value.txt'), 'utf8'));
    }
    console.log(JSON.stringify({ record, texts }));
  } else {
    const artifacts = new FileArtifactStore(join(root, 'temporary'), contracts);
    const files = new FileWorkflowCatalog(contracts, artifacts, join(root, 'work'), archive);
    const started = [], created = [], identities = [], restored = [], backends = new Map();
    for (const node of ['a', 'b']) {
      class Backend extends DockerBackend {
        async restoreResource(...args) {
          const record = (await store.read('run')).content;
          if (recoveryOperation) { assert.equal(record.schema, 'agentflow-workflow-recovery/v1'); assert.ok(record.claimRevision >= 2); }
          restored.push(node); return super.restoreResource(...args);
        }
        async create(resource, request) {
          created.push(node); identities.push(request.identity);
          const attempt = (await store.read('run')).content.attempts.at(-1);
          assert.equal(attempt.node, node); assert.deepEqual(attempt.identity, request.identity);
          assert.deepEqual(attempt.resource.resource, resource); assert.equal(attempt.resultStep, null);
          assert.equal(attempt.launch, 'create_pending');
          await super.create(resource, request);
          if (mode === 'journal-inside-create') {
            process.send({ event: 'inside-operation', resource, launch: 'create_pending' });
            await new Promise(() => { setInterval(() => {}, 1000); });
          }
        }
        async start(resource) {
          assert.equal((await store.read('run')).content.attempts.at(-1).launch, 'start_pending');
          await super.start(resource); started.push(node);
          if (mode === 'journal-inside-start') {
            const deadline = Date.now() + 5000;
            while ((await super.observe(resource)).state !== 'running') {
              if (Date.now() > deadline) throw new Error('test container did not start');
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            process.send({ event: 'inside-operation', resource, launch: 'start_pending' });
            await new Promise(() => { setInterval(() => {}, 1000); });
          }
          if (node === 'b' && mode === 'interrupt') {
            const deadline = Date.now() + 5000;
            while ((await super.observe(resource)).state !== 'running') {
              if (Date.now() > deadline) throw new Error('test container did not start');
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            process.send({ event: 'b-started', resource });
          }
        }
      }
      const backend = new Backend({ workspaceRoot: join(root, 'attempts'), image: process.env.AGENTFLOW_TEST_IMAGE ?? 'alpine:3',
        ...(mode === 'network-resume' ? { network: { kind: 'connect-proxy', proxyImage: 'node:22-bookworm-slim', allowedHosts: ['example.com'] } } : {}) });
      backends.set(node, backend);
      const executor = new ScriptExecutor(backend, systemClock, { read: async file => readFile(file.path, 'utf8') });
      const pause = ['resume-running', 'network-resume'].includes(mode) && node === 'b' ? 'sleep 3; ' : (node === 'b' && ['interrupt', 'recovery-running'].includes(mode) || mode.startsWith('journal-')) ? 'sleep 60; ' : '';
      files.registerScript({ id: node, kind: 'transform', inputContract: 'files', outcomes: { ok: 'files' }, implementation: node }, executor,
        { argv: ['/bin/sh', '-c', `set -eu; ${pause}cat /task/input/value.txt > /task/outputs/value.txt; printf ${node.toUpperCase()} >> /task/outputs/value.txt; printf changed > /task/input/value.txt; printf '%s' '{"schema":"agentflow-script-result/v1","outcome":"ok"}'`], timeoutMs: 70000 });
    }
    const flow = compileWorkflow({ id: 'checkpoints', start: 'a', input: { kind: 'files', id: 'files' }, maxSteps: 2,
      nodes: { a: { component: 'a' }, b: { component: 'b' } }, outcomes: { done: { kind: 'files', id: 'files' } },
      routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] }, files);
    if (recoveryOperation) {
      if (operation === 'claim-barrier') {
        const read = store.read.bind(store); let first = true;
        store.read = async id => { const record = await read(id); if (first) { first = false; process.send({ event: 'read', revision: record.revision }); await new Promise(resolve => process.once('message', resolve)); } return record; };
      }
      if (['claim-before-complete', 'claim-after-complete'].includes(operation)) {
        const cas = store.compareAndSwap.bind(store);
        store.compareAndSwap = async (...args) => {
          const complete = args[2].resourceRemoved === true;
          if (complete && operation === 'claim-before-complete') { process.send({ event: 'cleanup-paused' }); await new Promise(() => { setInterval(() => {}, 1000); }); }
          const result = await cas(...args);
          if (complete && operation === 'claim-after-complete') { process.send({ event: 'cleanup-paused' }); await new Promise(() => { setInterval(() => {}, 1000); }); }
          return result;
        };
      }
      let recovery;
      try {
        recovery = await claimWorkflowRecovery(flow, 'run', store);
        if (operation === 'claim-pause') { process.send({ event: 'claimed' }); await new Promise(() => { setInterval(() => {}, 1000); }); }
        if (operation === 'claim-query-fail') process.env.DOCKER_HOST = `unix://${join(root, 'missing-test-docker.sock')}`;
        const texts = [];
        for (const [index, value] of recovery.query().checkpoint.values.entries()) {
          const path = join(root, `claim-${process.pid}-${index}`); await files.materialize(value.value, 'run', path); texts.push(await readFile(join(path, 'value.txt'), 'utf8'));
        }
        const result = await recovery.cleanup();
        if (operation.startsWith('claim-resume')) {
          const resumed = await new WorkflowRuntime().resumePersisted(recovery);
          try {
            await recovery.dispose(); // The resumed handle now owns the inherited file values.
            const completed = await resumed.completion;
            const path = join(root, `final-${process.pid}`);
            await files.materialize(completed.lastAccepted.result.output, 'run', path);
            const text = await readFile(join(path, 'value.txt'), 'utf8');
            console.log(JSON.stringify({ result: completed, text, checkpoint: (await store.read('run')).content, started, created, restored, identities }));
            for (const step of completed.steps.slice(result.checkpoint.snapshot.steps.length)) if (step.result.status === 'accepted') await files.release(step.result.output, 'run');
          } finally { await resumed.dispose(); }
        } else console.log(JSON.stringify({ result, texts, started, created, restored }));
      } catch (error) { console.log(JSON.stringify({ error: error.code ?? 'RECOVERY_FAILED', started, created, restored })); }
      finally { await recovery?.dispose(); }
    } else if (['load', 'recover-resource'].includes(operation)) {
      const before = await store.read('run');
      let loaded;
      try { loaded = await loadWorkflowCheckpoint(flow, 'run', store); }
      catch (error) {
        assert.deepEqual(await store.read('run'), before); assert.deepEqual(started, []);
        for (const name of ['temporary', 'work']) assert.deepEqual(await readdir(join(root, name)).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []);
        console.log(JSON.stringify({ error: error.code, started }));
      }
      if (loaded) {
        const checkpoint = loaded.checkpoint, texts = [], recovered = [];
        if (operation === 'recover-resource') for (const attempt of checkpoint.attempts) if (attempt.resource && attempt.resultStep === null) {
          const handle = await new Runner(backends.get(attempt.node), systemClock).restore(attempt.resource);
          const observation = await handle.query(), stopped = await handle.stopAndRemove();
          assert.equal(stopped.confirmed, true); await handle.release();
          recovered.push({ node: attempt.node, identity: attempt.identity, observation, ...stopped });
        }
        for (const [index, record] of checkpoint.values.entries()) {
          assert.deepEqual(files.check('files', record.value), []);
          const info = files.inspect(record.value, 'run');
          assert.deepEqual(info.manifest, record.saved.manifest); assert.deepEqual(info.receipt, record.saved.receipt);
          const path = join(root, `loaded-${index}`), another = join(root, `copy-${index}`);
          await files.materialize(record.value, 'run', path); texts.push(await readFile(join(path, 'value.txt'), 'utf8'));
          await writeFile(join(path, 'value.txt'), 'caller mutation');
          await files.materialize(record.value, 'run', another);
          assert.equal(await readFile(join(another, 'value.txt'), 'utf8'), texts[index]);
          // Restored storage IDs differ, while checkpoint lineage remains stable and can be saved again.
          const savedAgain = await files.checkpointValue(record.value, 'run', 'files');
          assert.deepEqual(savedAgain.manifest, record.saved.manifest); assert.deepEqual(savedAgain.receipt, record.saved.receipt);
        }
        await Promise.all([loaded.dispose(), loaded.dispose()]); await loaded.dispose();
        for (const record of checkpoint.values) assert.notDeepEqual(files.check('files', record.value), []);
        for (const name of ['temporary', 'work']) assert.deepEqual(await readdir(join(root, name)), []);
        const again = await loadWorkflowCheckpoint(flow, 'run', store); await again.dispose();
        assert.deepEqual(await store.read('run'), before); assert.deepEqual(started, []);
        console.log(JSON.stringify({ checkpoint, revision: loaded.revision, recovery: loaded.recovery, texts, started, recovered }));
      }
    } else {
    const input = await files.prepareInput('run', join(root, 'source'), 'files');
    const handle = await new WorkflowRuntime().startPersisted(flow, 'run', input, store);
    let result;
    try { result = await handle.completion; }
    catch (error) { if (mode !== 'resource-fail' && !mode.startsWith('journal-fail-') && !mode.startsWith('journal-conflict-') && !mode.startsWith('recovery-')) throw error; result = handle.query(); }
    console.log(JSON.stringify({ ...result, started, created }));
    await files.release(input, 'run');
    for (const step of result.steps) if (step.result.status === 'accepted') await files.release(step.result.output, 'run');
    for (const step of result.steps) if (step.result.status === 'failed') await files.cleanup(step.result.identity);
    }
  }
} finally { store.close(); process.disconnect?.(); }
