import { FileCredentialStore } from '../auth/file-store.js';
import { createQueueCredentialAdmission } from './credential-admission.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { NodeWorker, loadWorkflowCheckpoint } from '@agentflow/engine';
import { SqliteRunRecordStore } from '../persistence/sqlite-store.js';
import { PersistentNodeQueue } from './node-queue.js';
import { systemClock } from '../system-clock.js';
// @ts-expect-error Deliberately shared source fixture loaded by real child processes too.
import { application, configuration } from '../../../tests/fixtures/queue-workflow.mjs';
async function setup(t: {
    after(fn: () => Promise<void>): void;
}) { const root = await mkdtemp(join(tmpdir(), 'af-node-queue-')), store = await SqliteRunRecordStore.open(join(root, 'queue')), queue = new PersistentNodeQueue(store, configuration); t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); }); return { root, store, queue }; }
async function submit(queue: PersistentNodeQueue, id: string, workflow = 'shared') { const a = application(workflow); await a.runtime.preparePersisted(a.compiled, id, 0, queue.records()); }
function child(root: string, id: string, mode = 'hold', roleCapacity = 2) {
    const process = fork(new URL('../../../tests/fixtures/queue-worker.mjs', import.meta.url), [root, mode, id, String(roleCapacity)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    process.stderr!.on('data', b => stderr += b);
    process.stdout!.resume();
    const messages: any[] = [];
    process.on('message', m => messages.push(m));
    const exited = once(process, 'exit'), next = async () => { for (;;) {
        if (messages.length)
            return messages.shift();
        await Promise.race([once(process, 'message'), exited.then(() => { if (!messages.length)
                throw new Error(stderr || 'early exit'); })]);
    } };
    return { process, exited, next };
}
test('atomic record guards prevent partial batch writes and preserve guarded records', async (t) => {
    const { store } = await setup(t);
    await store.create('a', { value: 1 });
    await store.create('b', { value: 2 });
    await assert.rejects(store.commitRecords([{ runId: 'a', revision: 1 }, { runId: 'b', revision: 9 }], [{ runId: 'a', content: 3 }]), /RUN_REVISION_CONFLICT/);
    assert.deepEqual((await store.read('a'))!.content, { value: 1 });
    await store.commitRecords([{ runId: 'a', revision: 1 }, { runId: 'b', revision: 1 }], [{ runId: 'a', content: 3 }]);
    assert.equal((await store.read('a'))!.revision, 2);
    assert.equal((await store.read('b'))!.revision, 1);
});
test('one NodeTask per worker turn, atomic successor insertion, duplicate submission and cancellation', async (t) => {
    const { queue } = await setup(t);
    await submit(queue, 'run');
    await assert.rejects(submit(queue, 'run'), /RUN_REVISION_CONFLICT/);
    assert.equal((await queue.query()).length, 1);
    // This is a turn/transaction test; a busy host must not turn it into a lease-expiry test.
    const worker = () => new NodeWorker(queue, { open: async () => {
        // Deliberately outlast the old 300 ms fixture lease without yielding to its heartbeat.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
        return application('shared');
    } }, systemClock, 'worker', ['json']);
    const first = await worker().runOnce();
    assert.equal(first!.error, null);
    assert.equal(first!.snapshot!.steps.length, 1);
    assert.equal(first!.snapshot!.currentNode, 'b');
    assert.deepEqual((await queue.query()).map(t => t.state), ['done', 'ready']);
    const loaded = await loadWorkflowCheckpoint(application('shared').compiled, 'run', queue.records());
    await loaded.dispose();
    const second = await worker().runOnce();
    assert.equal(second!.snapshot!.status, 'succeeded');
    assert.equal(second!.snapshot!.lastAccepted!.result.status, 'accepted');
    assert.deepEqual((await queue.query()).map(t => t.state), ['done', 'done']);
    assert.equal(await worker().runOnce(), null);
    await submit(queue, 'cancel');
    assert.equal(await queue.cancelReady('cancel'), true);
    assert.equal(await queue.cancelReady('cancel'), false);
    assert.equal(await worker().runOnce(), null);
    const cancelled = await loadWorkflowCheckpoint(application('shared').compiled, 'cancel', queue.records());
    assert.equal(cancelled.checkpoint.snapshot.status, 'cancelled');
    await cancelled.dispose();
});
test('actual processes share independent role and credential limits and skip a saturated profile', { timeout: 15000 }, async (t) => {
    const { root, queue } = await setup(t);
    await submit(queue, 'a');
    await submit(queue, 'b');
    await submit(queue, 'c', 'other');
    const first = child(root, 'first'), second = child(root, 'second');
    t.after(async () => { for (const p of [first, second]) {
        if (p.process.exitCode === null && p.process.signalCode === null)
            p.process.kill('SIGKILL');
        await p.exited;
    } });
    const started = await Promise.all([first.next(), second.next()]);
    assert.deepEqual(started.map(m => m.identity.runId).sort(), ['a', 'c']);
    assert.ok(started.every(m => m.component === 'a'));
    const tasks = await queue.query();
    assert.equal(tasks.filter(t => t.state === 'leased').length, 2);
    assert.equal(tasks.find(t => t.runId === 'b')!.state, 'ready');
    assert.equal(tasks.find(t => t.runId === 'b')!.reason, 'CREDENTIAL_CAPACITY');
    assert.equal(await queue.claim('third', ['json'], 1500), null);
    for (const p of [first, second])
        p.process.send('finish');
    for (const p of [first, second]) {
        assert.equal((await p.next()).result.error, null);
        assert.deepEqual(await p.exited, [0, null]);
    }
    const third = child(root, 'third', 'once');
    const invoked = await third.next();
    assert.equal(invoked.identity.runId, 'b');
    assert.equal((await third.next()).result.error, null);
    assert.deepEqual(await third.exited, [0, null]);
});
test('expired ownership stays reserved; takeover fences actual Run writes and blocking retains capacity', async (t) => {
    const { store } = await setup(t);
    let now = 1000;
    const clock = { now: () => now, sleep: async () => { } };
    const queue = new PersistentNodeQueue(store, configuration, clock);
    await submit(queue, 'a');
    await submit(queue, 'b');
    const first = (await queue.claim('old', ['json'], 300))!, initial = (await queue.records().read('a'))!, active = structuredClone(initial.content) as any;
    active.snapshot.status = 'running';
    active.snapshot.currentIdentity = { runId: 'a', nodeTaskId: 'task-1', attemptId: 'attempt-1', attemptNumber: 1 };
    active.attempts.push({ node: 'a', identity: active.snapshot.currentIdentity, resultStep: null, resource: null, launch: null, interrupted: false });
    const row = await queue.bind(first).compareAndSwap('a', initial.revision, active);
    now = 1400;
    const next = (await queue.claim('new', ['json'], 300))!;
    assert.equal(next.recovering, true);
    assert.equal(next.key, first.key);
    assert.equal(await queue.claim('third', ['json'], 300), null);
    await assert.rejects(queue.bind(first).compareAndSwap('a', row.revision, row.content), /QUEUE_CLAIM_LOST/);
    assert.deepEqual(await queue.records().read('a'), row);
    await queue.block(next, 'STOP_UNKNOWN');
    assert.equal(await queue.claim('third', ['json'], 300), null);
    assert.equal((await queue.query())[0]!.state, 'blocked');
    await queue.retryRecovery(next.key);
    assert.equal((await queue.claim('recovery', ['json'], 300))!.recovering, true);
});
test('host startup failure releases capacity without creating an Attempt or automatically retrying', async (t) => {
    const { queue } = await setup(t);
    await submit(queue, 'a');
    await submit(queue, 'b');
    const worker = new NodeWorker(queue, { open: async () => { throw new Error('fixture failure'); } }, systemClock, 'worker', ['json'], 300);
    assert.equal((await worker.runOnce())!.error, 'WORKER_EXECUTION_FAILED');
    const tasks = await queue.query();
    assert.equal(tasks[0]!.state, 'blocked');
    assert.equal(tasks[0]!.owner, null);
    assert.equal((await queue.records().read('a'))!.content && ((await queue.records().read('a'))!.content as any).attempts.length, 0);
    assert.equal((await queue.claim('next', ['json'], 300))!.runId, 'b');
});
test('an unconfirmed later node never releases capacity using the previous accepted step', async (t) => {
    const { queue } = await setup(t);
    await submit(queue, 'a');
    const worker = () => new NodeWorker(queue, { open: async () => application('shared') }, systemClock, 'worker', ['json'], 300);
    await worker().runOnce();
    const claim = (await queue.claim('next', ['json'], 300))!, row = (await queue.records().read('a'))!, c = structuredClone(row.content) as any;
    c.snapshot.status = 'failed';
    c.snapshot.reason = 'EXECUTION_STOP_UNCONFIRMED';
    c.snapshot.currentIdentity = { runId: 'a', nodeTaskId: 'task-2', attemptId: 'attempt-1', attemptNumber: 1 };
    // Queue owns dispatch, not business validation; this represents the engine's unconfirmed failure envelope.
    c.attempts.push({ identity: c.snapshot.currentIdentity, node: 'b', resultStep: null, resource: null, launch: null, interrupted: false });
    await queue.bind(claim).compareAndSwap('a', row.revision, c);
    assert.equal((await queue.query()).at(-1)!.state, 'leased');
    await queue.block(claim, 'STOP_UNKNOWN');
    assert.notEqual((await queue.query()).at(-1)!.owner, null);
});
test('worker drain finishes its one claimed node and stops before claiming the successor', async (t) => {
    const { queue } = await setup(t);
    await submit(queue, 'a');
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(r => entered = r), release = new Promise<void>(r => finish = r);
    const worker = new NodeWorker(queue, { open: async () => application('shared', async () => { entered(); await release; }) }, systemClock, 'worker', ['json'], 300);
    const pending = worker.runOnce();
    await ready;
    await worker.stop();
    assert.equal(worker.query().state, 'draining');
    finish();
    assert.equal((await pending)!.snapshot!.steps.length, 1);
    assert.equal(await worker.runOnce(), null);
    assert.equal(worker.query().state, 'stopped');
    assert.equal((await queue.query()).at(-1)!.state, 'ready');
});
test('actual processes obey the role ceiling independently of distinct available credential slots', { timeout: 15000 }, async (t) => {
    const { root, store } = await setup(t), config = structuredClone(configuration);
    config.roles.producer = 1;
    const queue = new PersistentNodeQueue(store, config);
    await submit(queue, 'a');
    await submit(queue, 'b', 'other');
    const first = child(root, 'first', 'hold', 1);
    t.after(async () => { if (first.process.exitCode === null && first.process.signalCode === null)
        first.process.kill('SIGKILL'); await first.exited; });
    assert.equal((await first.next()).identity.runId, 'a');
    const second = child(root, 'second', 'once', 1);
    assert.equal((await second.next()).result, null);
    assert.deepEqual(await second.exited, [0, null]);
    assert.equal((await queue.query()).find(t => t.runId === 'b')!.reason, 'ROLE_CAPACITY');
    first.process.send('finish');
    assert.equal((await first.next()).result.error, null);
    await first.exited;
    const third = child(root, 'third', 'once', 1);
    assert.equal((await third.next()).identity.runId, 'b');
    assert.equal((await third.next()).result.error, null);
    await third.exited;
});
test('worker cancellation uses the engine termination intent and releases its current task without a successor', async (t) => {
    const { queue } = await setup(t);
    await submit(queue, 'a');
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(r => entered = r), release = new Promise<void>(r => finish = r);
    const worker = new NodeWorker(queue, { open: async () => application('shared', async () => { entered(); await release; }) }, systemClock, 'worker', ['json'], 300);
    const pending = worker.runOnce();
    await ready;
    await worker.stop('cancel');
    finish();
    const result = await pending;
    assert.equal(result!.error, null);
    assert.equal(result!.snapshot!.status, 'cancelled');
    assert.equal((await queue.query()).length, 1);
    assert.equal((await queue.query())[0]!.state, 'done');
    const loaded = await loadWorkflowCheckpoint(application('shared').compiled, 'a', queue.records());
    assert.equal(loaded.checkpoint.snapshot.cancelRequested, true);
    await loaded.dispose();
});
test('cancellation racing a claim has one adopted result and never executes an already cancelled task', async (t) => {
    const { queue } = await setup(t);
    await submit(queue, 'a');
    const [cancel, claim] = await Promise.allSettled([queue.cancelReady('a'), queue.claim('worker', ['json'], 300)]);
    if (cancel.status === 'fulfilled' && cancel.value) {
        assert.equal(claim.status, 'fulfilled');
        assert.equal((claim as PromiseFulfilledResult<unknown>).value, null);
        assert.equal((await queue.records().read('a'))!.content && (await queue.query())[0]!.state, 'done');
    }
    else {
        assert.equal(cancel.status, 'rejected');
        assert.equal((cancel as PromiseRejectedResult).reason.code, 'QUEUE_TASK_ACTIVE');
        assert.equal(claim.status, 'fulfilled');
        assert.ok((claim as PromiseFulfilledResult<unknown>).value);
    }
});
test('a real delayed process cannot commit after another worker takes over and accepts the node', { timeout: 15000 }, async (t) => {
    const { root, queue } = await setup(t);
    await submit(queue, 'a');
    const old = fork(new URL('../../../tests/fixtures/queue-late-writer.mjs', import.meta.url), [root], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    old.stderr!.on('data', b => stderr += b);
    const exited = once(old, 'exit');
    t.after(async () => { if (old.exitCode === null && old.signalCode === null)
        old.kill('SIGKILL'); await exited; });
    assert.equal(((await once(old, 'message'))[0] as any).event, 'before-commit');
    await systemClock.sleep(350);
    // Only the abandoned worker must expire; use the normal lease for the recovering worker.
    const next = new NodeWorker(queue, { open: async () => application('shared') }, systemClock, 'new', ['json']);
    const adopted = await next.runOnce();
    assert.equal(adopted!.error, null);
    assert.equal(adopted!.claim.recovering, true);
    assert.equal(adopted!.snapshot!.steps.length, 1);
    const before = await queue.records().read('a');
    const rejected = once(old, 'message');
    old.send('resume');
    assert.deepEqual((await rejected)[0], { event: 'rejected', code: 'RUN_REVISION_CONFLICT' });
    assert.deepEqual(await exited, [0, null], stderr);
    assert.deepEqual(await queue.records().read('a'), before);
    assert.deepEqual((await queue.query()).map(t => t.state), ['done', 'ready']);
});
test('duplicate adoption cannot advance the same node twice or alter the stored successor', async (t) => {
    const { queue } = await setup(t);
    await submit(queue, 'a');
    const worker = new NodeWorker(queue, { open: async () => application('shared') }, systemClock, 'worker', ['json'], 300);
    const result = (await worker.runOnce())!, row = (await queue.records().read('a'))!;
    await assert.rejects(queue.bind(result.claim).compareAndSwap('a', row.revision, row.content), /QUEUE_CLAIM_LOST/);
    assert.deepEqual(await queue.records().read('a'), row);
    assert.deepEqual((await queue.query()).map(t => t.state), ['done', 'ready']);
});

for(const mismatch of ['harness','identity','capacity'])test(`actual dispatch ${mismatch} mismatch is rejected before an Attempt`,async t=>{
 const{store}=await setup(t), config=structuredClone(configuration);
 config.workflows.shared.a.harness=mismatch==='harness'?'different-agent':'fixture-agent';
 if(mismatch==='capacity')config.credentials[0].capacity=2;
 const queue=new PersistentNodeQueue(store,config);await submit(queue,'a');
 const binding={harness:'fixture-agent',credential:{credentialRef:'shared',service:'fixture',method:'api-key'},capacity:1};
 if(mismatch==='identity')binding.credential.credentialRef='foreign';
 const worker=new NodeWorker(queue,{open:async()=>application('shared',async()=>{},binding)},systemClock,'worker',['json'],300);
 assert.equal((await worker.runOnce())!.error,'QUEUE_NODE_BINDING_MISMATCH');
 const row=(await queue.records().read('a'))!;assert.equal((row.content as any).attempts.length,0);assert.equal((await queue.query())[0]!.owner,null);
});

test('source-busy dispatch skips to another credential without a failed Attempt',async t=>{
 const {root,queue}=await setup(t);await submit(queue,'a');await submit(queue,'b','other');
 const source=new FileCredentialStore(join(root,'credentials'),[{service:'fixture',method:'api-key',validate:s=>s==='fixture-secret'}]);
 const shared={credentialRef:'shared',service:'fixture',method:'api-key'},other={...shared,credentialRef:'other'};
 for(const identity of [shared,other])await source.configure(identity,{content:'fixture-secret'});
 const management=await source.acquireManagement(shared);
 const worker=new NodeWorker(queue,{open:async(runId,_records,claim)=>{
  const reservation=createQueueCredentialAdmission(source,claim);
  const app=application(runId==='a'?'shared':'other',async()=>{const lease=await reservation.credentials.acquire(claim.requirements.credential!);assert.equal(await lease.readSecret(),'fixture-secret');await lease.release();});
  return{...app,admission:reservation.admission};
 }},systemClock,'worker',['json'],300);
 try{
  const waiting=await worker.runOnce();assert.equal(waiting!.waiting,'CREDENTIAL_SOURCE_BUSY');assert.equal(waiting!.error,null);
  assert.equal(((await queue.records().read('a'))!.content as any).checkpoint.attempts.length,0);
  const allowed=await worker.runOnce();assert.equal(allowed!.claim.runId,'b');assert.equal(allowed!.error,null);assert.equal(allowed!.snapshot!.steps.length,1);
 }finally{await management.release();}
});

test('a correct Profile with an unadmitted source cannot start an Attempt',async t=>{
 const{store}=await setup(t),config=structuredClone(configuration);config.workflows.shared.a.harness='fixture-agent';const queue=new PersistentNodeQueue(store,config);await submit(queue,'a');
 const binding={harness:'fixture-agent',credential:{credentialRef:'shared',service:'fixture',method:'api-key'},capacity:1};
 const worker=new NodeWorker(queue,{open:async()=>({...application('shared',async()=>{},binding),admission:{acquire:async()=>{throw new Error('MUST_NOT_ACQUIRE');},release:async()=>{}}})},systemClock,'worker',['json'],300);
 assert.equal((await worker.runOnce())!.error,'QUEUE_CREDENTIAL_ADMISSION_REQUIRED');assert.equal(((await queue.records().read('a'))!.content as any).attempts.length,0);
});

for (const competingClaim of [false, true]) test(`recovered credential wait cancellation is atomic; competing claim=${competingClaim}`, { timeout: 15000 }, async t => {
    const { root, queue, store } = await setup(t);
    await submit(queue, 'a');
    const old = child(root, 'old', 'hold');
    t.after(async () => {
        if (old.process.exitCode === null && old.process.signalCode === null) old.process.kill('SIGKILL');
        await old.exited;
    });
    assert.equal((await old.next()).identity.nodeTaskId, 'task-1');
    old.process.kill('SIGKILL');
    assert.deepEqual(await old.exited, [null, 'SIGKILL']);
    await systemClock.sleep(1600);
    const recovery = new NodeWorker(queue, { open: async () => ({
        ...application('shared'), admission: { acquire: async () => false, release: async () => {} },
    }) }, systemClock, 'recovery', ['json']);
    assert.equal((await recovery.runOnce())!.waiting, 'CREDENTIAL_SOURCE_BUSY');
    const before = (await queue.records().read('a'))!.content as any;
    assert.equal(before.resourceRemoved, true);
    assert.equal(before.checkpoint.attempts.length, 1);
    assert.equal((await queue.query())[0]!.state, 'ready');
    assert.equal((await queue.query())[0]!.owner, null);
    if (competingClaim) {
        await systemClock.sleep(1100); // Make the queued credential wait eligible again.
        const commit = store.commitRecords.bind(store);
        let beforeCommit!: () => void, allowCommit!: () => void;
        const paused = new Promise<void>(resolve => beforeCommit = resolve);
        const proceed = new Promise<void>(resolve => allowCommit = resolve);
        store.commitRecords = async (checks, writes) => {
            if (writes.some(write => (write.content as any).snapshot?.status === 'cancelled')) {
                beforeCommit(); await proceed;
            }
            return commit(checks, writes);
        };
        const cancellation = queue.cancelReady('a');
        const rejected = assert.rejects(cancellation, /QUEUE_TASK_ACTIVE/);
        await paused;
        try {
            const claim = await queue.claim('competing', ['json'], 30000);
            assert.equal(claim!.nodeTaskId, 'task-1');
        } finally { allowCommit(); }
        await rejected;
        assert.deepEqual((await queue.records().read('a'))!.content, before);
        assert.equal((await queue.query())[0]!.state, 'leased');
        return;
    }
    assert.equal(await queue.cancelReady('a'), true);
    const loaded = await loadWorkflowCheckpoint(application('shared').compiled, 'a', queue.records());
    try {
        assert.equal(loaded.checkpoint.snapshot.status, 'cancelled');
        assert.equal(loaded.checkpoint.snapshot.cancelRequested, true);
        assert.deepEqual(loaded.checkpoint.attempts, before.checkpoint.attempts);
    } finally { await loaded.dispose(); }
    assert.equal(await queue.claim('next', ['json'], 30000), null);
    assert.equal((await queue.query()).length, 1);
});
