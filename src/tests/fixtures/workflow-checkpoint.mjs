import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractRegistry, FileContractRegistry, ScriptExecutor, WorkflowRuntime, compileWorkflow } from '@agentflow/engine';
import { DockerBackend, FileArtifactStore, FileArtifactArchive, FileWorkflowCatalog, SqliteRunRecordStore, systemClock } from '@agentflow/integrations';

const [root, mode] = process.argv.slice(2);
const contracts = new FileContractRegistry(new ContractRegistry());
contracts.register('files', { rules: [{ id: 'value', kind: 'file', match: 'value.txt', minCount: 1, maxCount: 1, mediaTypes: ['text/plain'], maxBytes: 1000 }], maxFiles: 1, maxTotalBytes: 1000, unmatched: 'reject' });
const archive = new FileArtifactArchive(join(root, 'archive'), contracts);
if (mode === 'archive-fail') {
  const capture = archive.capture.bind(archive); let calls = 0;
  archive.capture = async (...args) => { if (++calls === 2) throw new Error('injected archive failure'); return capture(...args); };
}
const store = await SqliteRunRecordStore.open(join(root, 'db'));
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
    const started = [];
    for (const node of ['a', 'b']) {
      class Backend extends DockerBackend {
        async start(resource) {
          await super.start(resource); started.push(node);
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
      const backend = new Backend({ workspaceRoot: join(root, 'attempts'), image: process.env.AGENTFLOW_TEST_IMAGE ?? 'alpine:3' });
      const executor = new ScriptExecutor(backend, systemClock, { read: async file => readFile(file.path, 'utf8') });
      const pause = node === 'b' && mode === 'interrupt' ? 'sleep 60; ' : '';
      files.registerScript({ id: node, kind: 'transform', inputContract: 'files', outcomes: { ok: 'files' }, implementation: node }, executor,
        { argv: ['/bin/sh', '-c', `set -eu; ${pause}cat /task/input/value.txt > /task/outputs/value.txt; printf ${node.toUpperCase()} >> /task/outputs/value.txt; printf changed > /task/input/value.txt; printf '%s' '{"schema":"agentflow-script-result/v1","outcome":"ok"}'`], timeoutMs: 70000 });
    }
    const flow = compileWorkflow({ id: 'checkpoints', start: 'a', input: { kind: 'files', id: 'files' }, maxSteps: 2,
      nodes: { a: { component: 'a' }, b: { component: 'b' } }, outcomes: { done: { kind: 'files', id: 'files' } },
      routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] }, files);
    const input = await files.prepareInput('run', join(root, 'source'), 'files');
    const handle = await new WorkflowRuntime().startPersisted(flow, 'run', input, store);
    const result = await handle.completion;
    console.log(JSON.stringify({ ...result, started }));
    await files.release(input, 'run');
    for (const step of result.steps) if (step.result.status === 'accepted') await files.release(step.result.output, 'run');
  }
} finally { store.close(); process.disconnect?.(); }
