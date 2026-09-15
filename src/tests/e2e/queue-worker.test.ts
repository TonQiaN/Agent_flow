import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore, PersistentNodeQueue } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const configuration = { roles: { producer: 1, fixer: 1 }, credentials: [], workflows: { scripts: { a: { role: 'producer', capability: 'docker' }, b: { role: 'producer', capability: 'docker' } } } };
function child(root: string, operation: string, worker = operation) {
    const process = fork(new URL('../fixtures/queue-docker-worker.mjs', import.meta.url), [root, operation, worker], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    process.stderr!.on('data', b => stderr += b);
    process.stdout!.resume();
    const messages: any[] = [];
    process.on('message', m => messages.push(m));
    const timer = setTimeout(() => process.kill('SIGKILL'), 25000), exited = once(process, 'exit').finally(() => clearTimeout(timer));
    const next = async () => { for (;;) {
        if (messages.length)
            return messages.shift();
        await Promise.race([once(process, 'message'), exited.then(() => { if (!messages.length)
                throw new Error(stderr || 'early exit'); })]);
    } };
    return { process, exited, next };
}
async function complete(root: string, operation: string) { const p = child(root, operation); const all: any[] = []; while (true) {
    const m = await p.next();
    all.push(m);
    if (m.event === 'done' || m.event === 'prepared' || m.error)
        break;
} assert.deepEqual(await p.exited, [0, null], JSON.stringify(all)); return all; }
for (const outage of [false, true])
    test(`real queued Worker SIGKILL retains A and capacity until common Runner cleanup; query outage=${outage}`, { skip: !enabled, timeout: 50000 }, async () => {
        const root = await mkdtemp(join(tmpdir(), 'af-queue-docker-'));
        await mkdir(join(root, 'source'));
        await writeFile(join(root, 'source/value.txt'), 'seed');
        const raw = await SqliteRunRecordStore.open(join(root, 'queue')), queue = new PersistentNodeQueue(raw, configuration);
        let old: ReturnType<typeof child> | undefined, id: string | undefined;
        try {
            await complete(root, 'prepare');
            const first = await complete(root, 'once');
            assert.equal(first.at(-1).result.error, null);
            assert.equal(first.at(-1).result.snapshot.steps.length, 1);
            old = child(root, 'pause');
            const started = await old.next();
            assert.equal(started.event, 'running');
            id = started.resource.id;
            assert.equal(JSON.parse(await docker(['inspect', id!]))[0].State.Running, true);
            old.process.kill('SIGKILL');
            assert.deepEqual(await old.exited, [null, 'SIGKILL']);
            const before: any = await queue.records().read('run');
            await rm(join(root, 'source'), { recursive: true, force: true });
            assert.equal(await queue.claim('early', ['docker'], 900), null);
            await new Promise(r => setTimeout(r, 1000));
            if (outage) {
                const blocked = (await complete(root, 'outage')).at(-1);
                assert.ok(blocked.result.error);
                assert.equal((await queue.query()).at(-1)!.state, 'blocked');
                assert.notEqual((await queue.query()).at(-1)!.owner, null);
                assert.equal(await queue.claim('other', ['docker'], 900), null);
                assert.equal(JSON.parse(await docker(['inspect', id!]))[0].State.Running, true);
                await queue.retryRecovery('run/task-2');
            }
            const resumed = await complete(root, 'resume'), final = resumed.at(-1);
            assert.equal(final.result.error, null);
            assert.equal(final.result.snapshot.status, 'succeeded');
            assert.equal(resumed.find(r => r.event === 'output').text, 'seedAB');
            assert.deepEqual(final.result.snapshot.steps[0], before.content.snapshot.steps[0]);
            assert.ok(final.record.content.attempts.some((a: any) => a.identity.nodeTaskId === 'task-2' && a.identity.attemptNumber === 2));
            await assert.rejects(docker(['inspect', id!]));
            assert.ok((await queue.query()).every(t => t.state === 'done'));
        }
        finally {
            if (old && old.process.exitCode === null && old.process.signalCode === null) {
                old.process.kill('SIGKILL');
                await old.exited;
            }
            if (id)
                await docker(['rm', '-f', id]).catch(() => { });
            raw.close();
            await rm(root, { recursive: true, force: true });
        }
    });
