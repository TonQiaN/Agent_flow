import { join } from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { ContractRegistry, FileContractRegistry, ScriptExecutor, WorkflowRuntime, compileWorkflow, NodeWorker } from '@agentflow/engine';
import { DockerBackend, FileArtifactStore, FileArtifactArchive, FileWorkflowCatalog, SqliteRunRecordStore, PersistentNodeQueue, systemClock } from '@agentflow/integrations';
const [root, operation, worker = 'worker'] = process.argv.slice(2);
export const configuration = { roles: { producer: 1, fixer: 1 }, credentials: [], workflows: { scripts: { a: { role: 'producer', capability: 'docker' }, b: { role: 'producer', capability: 'docker' } } } };
const raw = await SqliteRunRecordStore.open(join(root, 'queue')), queue = new PersistentNodeQueue(raw, configuration);
const host = { open: async (runId, records) => {
        const contracts = new FileContractRegistry(new ContractRegistry());
        contracts.register('files', { rules: [{ id: 'value', kind: 'file', match: 'value.txt', minCount: 1, maxCount: 1, mediaTypes: ['text/plain'], maxBytes: 1000 }], maxFiles: 1, maxTotalBytes: 1000, unmatched: 'reject' });
        const artifacts = new FileArtifactStore(join(root, `temp-${worker}`), contracts), files = new FileWorkflowCatalog(contracts, artifacts, join(root, `work-${worker}`), new FileArtifactArchive(join(root, 'archive'), contracts));
        const prior = await records.read(runId), count = (prior?.content.checkpoint ?? prior?.content)?.snapshot.steps.length ?? 0;
        for (const node of ['a', 'b']) {
            const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: 'alpine:3' }), executor = new ScriptExecutor(backend, systemClock, { read: async (file) => readFile(file.path, 'utf8') });
            files.registerScript({ id: node, kind: 'transform', inputContract: 'files', outcomes: { ok: 'files' }, implementation: node }, executor, { argv: ['/bin/sh', '-c', `set -eu; ${node === 'b' ? 'sleep 3; ' : ''}cat /task/input/value.txt > /task/outputs/value.txt; printf ${node.toUpperCase()} >> /task/outputs/value.txt; printf '%s' '{"schema":"agentflow-script-result/v1","outcome":"ok"}'`], timeoutMs: 10000 });
        }
        const compiled = compileWorkflow({ id: 'scripts', start: 'a', maxSteps: 2, input: { kind: 'files', id: 'files' }, nodes: { a: { component: 'a' }, b: { component: 'b' } }, outcomes: { done: { kind: 'files', id: 'files' } }, routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] }, files);
        return { compiled, runtime: new WorkflowRuntime(), files, dispose: async (snapshot) => {
                if (snapshot?.lastAccepted) {
                    const path = join(root, `result-${worker}`);
                    await files.materialize(snapshot.lastAccepted.result.output, runId, path);
                    process.send({ event: 'output', text: await readFile(join(path, 'value.txt'), 'utf8') });
                    await rm(path, { recursive: true, force: true });
                }
                for (const step of snapshot?.steps.slice(count) ?? [])
                    if (step.result.status === 'accepted')
                        await files.release(step.result.output, runId);
            } };
    } };
try {
    if (operation === 'prepare') {
        const app = await host.open('run', queue.records());
        const input = await app.files.prepareInput('run', join(root, 'source'), 'files');
        await app.runtime.preparePersisted(app.compiled, 'run', input, queue.records());
        await app.files.release(input, 'run');
        process.send({ event: 'prepared' });
    }
    else {
        const bound = queue.bind.bind(queue);
        queue.bind = claim => {
            const store = bound(claim);
            return { ...store, compareAndSwap: async (...args) => {
                    const r = await store.compareAndSwap(...args), a = args[2].attempts?.at(-1);
                    if (operation === 'pause' && a?.node === 'b' && a.launch === 'start_completed' && a.resultStep === null && !a.interrupted) {
                        process.send({ event: 'running', resource: a.resource.resource });
                        await new Promise(() => { });
                    }
                    return r;
                } };
        };
        if (operation === 'outage') {
            const open = host.open;
            host.open = async (...args) => {
                const app = await open(...args);
                const snapshot = app.compiled; // Freeze images before simulating the query outage.
                const engine = await import('@agentflow/engine');
                await engine.snapshotWorkflowExecution(snapshot);
                process.env.DOCKER_HOST = `unix://${join(root, 'missing.sock')}`;
                return app;
            };
        }
        const w = new NodeWorker(queue, host, systemClock, worker, ['docker'], 900);
        const result = await w.runOnce();
        process.send({ event: 'done', result, tasks: await queue.query(), record: await queue.records().read('run') });
    }
}
catch (e) {
    process.send({ error: e.code ?? e.message });
    process.exitCode = 1;
}
finally {
    raw.close();
    process.disconnect?.();
}
