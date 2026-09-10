import { createHash, randomUUID } from 'node:crypto';
import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import { canonicalJson, snapshotJson, RunStoreError, DefinitionError, validateQueueConfiguration, waitingReason } from '@agentflow/engine';
import type { AtomicRunRecordStore, RunRecord, RunRecordStore, Clock, QueueConfiguration, QueuedNodeTask, NodeTaskQueue, NodeTaskClaim, WorkflowCheckpoint } from '@agentflow/engine';
import { systemClock } from '../system-clock.js';
type Task = {
    -readonly [K in keyof QueuedNodeTask]: QueuedNodeTask[K];
};
interface Index {
    schema: 'agentflow-node-queue/v1';
    configuration: QueueConfiguration;
    next: number;
    tasks: Task[];
}
const indexId = 'dispatch-index', runKey = (runId: string) => `run-${createHash('sha256').update(runId).digest('hex')}`;
const asJson = (v: unknown): JsonValue => snapshotJson(v);
const equal = (a: unknown, b: unknown) => canonicalJson(asJson(a)) === canonicalJson(asJson(b));
function checkpoint(content: JsonValue, runId: string): WorkflowCheckpoint {
    const raw = content as unknown as WorkflowCheckpoint | {
        schema: string;
        checkpoint: WorkflowCheckpoint;
    };
    const value = raw?.schema === 'agentflow-workflow-recovery/v1' ? (raw as {
        checkpoint: WorkflowCheckpoint;
    }).checkpoint : raw as WorkflowCheckpoint;
    if (value?.schema !== 'agentflow-workflow-checkpoint/v5' || value.snapshot?.runId !== runId || !Array.isArray(value.snapshot.steps) || !Array.isArray(value.attempts) || !value.cursor)
        throw new DefinitionError('INVALID_QUEUE_RUN');
    return value;
}
/** Single deployment namespace over the same atomic record store. Only references are duplicated. */
export class PersistentNodeQueue implements NodeTaskQueue {
    readonly #configuration: QueueConfiguration;
    constructor(private readonly store: AtomicRunRecordStore, configuration: QueueConfiguration, private readonly clock: Clock = systemClock) { this.#configuration = validateQueueConfiguration(configuration); }
    async #index(): Promise<{
        record: RunRecord | null;
        index: Index;
    }> {
        const record = await this.store.read(indexId);
        if (!record)
            return { record, index: { schema: 'agentflow-node-queue/v1', configuration: this.#configuration, next: 1, tasks: [] } };
        const index = record.content as unknown as Index;
        if (index?.schema !== 'agentflow-node-queue/v1' || !equal(index.configuration, this.#configuration) || !Array.isArray(index.tasks) || !Number.isSafeInteger(index.next) || index.next < 1)
            throw new DefinitionError('QUEUE_CONFIGURATION_OR_STATE_MISMATCH');
        if (index.tasks.length > 2048 || index.next !== index.tasks.length + 1 || new Set(index.tasks.map(t => t.key)).size !== index.tasks.length
            || index.tasks.some((t, i) => !t || Object.keys(t).sort().join(',') !== 'key,node,nodeTaskId,owner,reason,requirements,runId,sequence,state,workflowId'
                || t.sequence !== i + 1 || !isIdentifier(t.runId) || !isIdentifier(t.workflowId) || !isIdentifier(t.node) || !/^task-[1-9][0-9]*$/.test(t.nodeTaskId)
                || !Number.isSafeInteger(Number(t.nodeTaskId.slice(5))) || !['ready', 'leased', 'blocked', 'done'].includes(t.state) || t.key !== `${t.runId}/${t.nodeTaskId}`
                || t.reason !== null && !isIdentifier(t.reason) || t.state === 'ready' && t.owner !== null || t.state === 'leased' && t.owner === null
                || t.owner !== null && (!t.owner || Object.keys(t.owner).sort().join(',') !== 'deadline,token,worker' || !isIdentifier(t.owner.worker)
                    || !/^[-a-f0-9]{36}$/.test(t.owner.token) || !Number.isFinite(t.owner.deadline) || t.owner.deadline < 0)
                || !equal(t.requirements, index.configuration.workflows[t.workflowId]?.[t.node])))
            throw new DefinitionError('INVALID_QUEUE_STATE');
        return { record, index };
    }
    async #change<T>(operation: (index: Index) => T): Promise<T> {
        for (let n = 0; n < 32; n++) {
            const { record, index } = await this.#index(), result = operation(index);
            try {
                await this.store.commitRecords([{ runId: indexId, revision: record?.revision ?? null }], [{ runId: indexId, content: asJson(index) }]);
                return result;
            }
            catch (e) {
                if (!(e instanceof RunStoreError) || e.code !== 'RUN_REVISION_CONFLICT')
                    throw e;
            }
        }
        throw new DefinitionError('QUEUE_CONTENTION');
    }
    #project(index: Index, content: JsonValue, runId: string, owned?: Task): void {
        const c = checkpoint(content, runId), v = c.snapshot, last = v.steps.at(-1);
        const boundary = ['queued', 'running'].includes(v.status) && !v.cancelRequested && v.currentIdentity === null;
        const terminal = ['succeeded', 'failed', 'cancelled', 'exhausted'].includes(v.status);
        const completed = owned && v.steps.length === Number(owned.nodeTaskId.slice(5));
        const active = c.attempts.at(-1);
        const cancelledBeforeStart = v.status === 'cancelled' && (!active || active.resultStep !== null || active.resource === null && (active.phases === undefined || active.phases.length === 0));
        const safe = cancelledBeforeStart || completed && !!last && (last.result.status === 'accepted' || last.result.status === 'failed' && last.result.stopped);
        if (owned && (boundary && v.steps.length > Number(owned.nodeTaskId.slice(5)) - 1 || terminal && safe)) {
            owned.state = 'done';
            owned.reason = null;
        }
        if (!boundary)
            return;
        const node = c.cursor.node, workflow = v.workflowId, nodeTaskId = `task-${v.steps.length + 1}`, key = `${runId}/${nodeTaskId}`;
        if (!node || !this.#configuration.workflows[workflow]?.[node])
            throw new DefinitionError('QUEUE_NODE_NOT_CONFIGURED');
        if (index.tasks.some(t => t.key === key))
            return;
        if (index.tasks.length >= 2048)
            throw new DefinitionError('QUEUE_TASK_LIMIT');
        index.tasks.push({ key, sequence: index.next++, runId, workflowId: workflow, nodeTaskId, node, requirements: this.#configuration.workflows[workflow]![node]!, state: 'ready', owner: null, reason: null });
    }
    #owned(index: Index, claim: NodeTaskClaim, requireLive = true): Task {
        const task = index.tasks.find(t => t.key === claim.key);
        if (!task || task.runId !== claim.runId || task.nodeTaskId !== claim.nodeTaskId || task.node !== claim.node || task.owner?.worker !== claim.worker || task.owner?.token !== claim.token
            || requireLive && (task.state !== 'leased' || task.owner.deadline <= this.clock.now()))
            throw new DefinitionError('QUEUE_CLAIM_LOST');
        return task;
    }
    async #write(runId: string, revision: number | null, content: JsonValue, claim?: NodeTaskClaim): Promise<RunRecord> {
        if (!isIdentifier(runId) || revision !== null && !claim)
            throw new DefinitionError('QUEUE_CLAIM_REQUIRED');
        const captured = asJson(content), key = runKey(runId);
        for (let n = 0; n < 32; n++) {
            const { record, index } = await this.#index(), owned = claim ? this.#owned(index, claim) : undefined;
            if (claim && runId !== claim.runId)
                throw new DefinitionError('QUEUE_CLAIM_LOST');
            if (owned) {
                const c = checkpoint(captured, runId);
                const active = c.snapshot.currentIdentity;
                if (active && active.nodeTaskId !== owned.nodeTaskId || c.snapshot.steps.length > Number(owned.nodeTaskId.slice(5)))
                    throw new DefinitionError('QUEUE_NODE_BOUNDARY_EXCEEDED');
            }
            this.#project(index, captured, runId, owned);
            try {
                const written = await this.store.commitRecords([{ runId: indexId, revision: record?.revision ?? null }, { runId: key, revision }], [{ runId: key, content: captured }, { runId: indexId, content: asJson(index) }]);
                return { ...written[0]!, runId };
            }
            catch (e) {
                if (!(e instanceof RunStoreError) || e.code !== 'RUN_REVISION_CONFLICT')
                    throw e;
                const actual = await this.store.read(key);
                if ((actual?.revision ?? null) !== revision)
                    throw e;
            }
        }
        throw new DefinitionError('QUEUE_CONTENTION');
    }
    records(): RunRecordStore { return Object.freeze({ create: (id: string, c: JsonValue) => this.#write(id, null, c), read: async (id: string) => { if (!isIdentifier(id))
            throw new DefinitionError('INVALID_RUN_ID'); const r = await this.store.read(runKey(id)); return r ? { ...r, runId: id } : null; }, compareAndSwap: async () => { throw new DefinitionError('QUEUE_CLAIM_REQUIRED'); } }); }
    bind(claim: NodeTaskClaim): RunRecordStore { const captured = Object.freeze({ ...claim }); return Object.freeze({ create: async () => { throw new DefinitionError('QUEUE_CLAIM_REQUIRED'); }, read: this.records().read, compareAndSwap: (id: string, r: number, c: JsonValue) => this.#write(id, r, c, captured) }); }
    async query(): Promise<readonly QueuedNodeTask[]> { const { index } = await this.#index(); return snapshotJson(index.tasks) as unknown as QueuedNodeTask[]; }
    async claim(worker: string, capabilities: readonly string[], leaseMs: number): Promise<NodeTaskClaim | null> {
        if (!isIdentifier(worker) || !Array.isArray(capabilities) || !capabilities.every(isIdentifier) || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 3600000)
            throw new DefinitionError('INVALID_WORKER_CONFIGURATION');
        const allowed = [...capabilities];
        return this.#change(index => {
            const now = this.clock.now();
            for (const task of index.tasks) {
                const recovering = task.state === 'leased' && task.owner!.deadline <= now;
                if (recovering) {
                    if (!allowed.includes(task.requirements.capability))
                        continue;
                }
                else if (task.state !== 'ready')
                    continue;
                else {
                    task.reason = waitingReason(task, index.tasks, index.configuration, allowed);
                    if (task.reason)
                        continue;
                }
                task.state = 'leased';
                task.reason = null;
                task.owner = { worker, token: randomUUID(), deadline: now + leaseMs };
                return { key: task.key, runId: task.runId, nodeTaskId: task.nodeTaskId, node: task.node, worker, token: task.owner.token, recovering };
            }
            return null;
        });
    }
    async heartbeat(claim: NodeTaskClaim, leaseMs: number): Promise<boolean> {
        if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 3600000)
            throw new DefinitionError('INVALID_WORKER_CONFIGURATION');
        return this.#change(index => { const task = this.#owned(index, claim, false); if (task.state === 'done')
            return false; this.#owned(index, claim); task.owner = { ...task.owner!, deadline: this.clock.now() + leaseMs }; return true; });
    }
    async block(claim: NodeTaskClaim, reason: string): Promise<void> {
        if (!isIdentifier(reason))
            throw new DefinitionError('INVALID_QUEUE_REASON');
        for (let n = 0; n < 32; n++) {
            const { record, index } = await this.#index(), t = this.#owned(index, claim, false);
            if (t.state === 'done')
                return;
            const row = await this.store.read(runKey(claim.runId));
            if (!row)
                throw new DefinitionError('INVALID_QUEUE_RUN');
            const c = checkpoint(row.content, claim.runId), last = c.attempts.at(-1);
            // A host factory may fail before any Attempt. Block dispatch without reserving a nonexistent execution.
            if ((row.content as {
                schema?: string;
            }).schema === 'agentflow-workflow-checkpoint/v5' && c.snapshot.currentIdentity === null && (!last || last.resultStep !== null))
                t.owner = null;
            t.state = 'blocked';
            t.reason = reason;
            try {
                await this.store.commitRecords([{ runId: indexId, revision: record!.revision }, { runId: runKey(claim.runId), revision: row.revision }], [{ runId: indexId, content: asJson(index) }]);
                return;
            }
            catch (e) {
                if (!(e instanceof RunStoreError) || e.code !== 'RUN_REVISION_CONFLICT')
                    throw e;
            }
        }
        throw new DefinitionError('QUEUE_CONTENTION');
    }
    async retryRecovery(key: string): Promise<void> { await this.#change(index => { const t = index.tasks.find(t => t.key === key); if (!t || t.state !== 'blocked')
        throw new DefinitionError('QUEUE_NOT_BLOCKED'); t.state = t.owner ? 'leased' : 'ready'; if (t.owner)
        t.owner = { ...t.owner, deadline: 0 }; t.reason = null; }); }
    async cancelReady(runId: string): Promise<boolean> {
        const key = runKey(runId);
        for (let n = 0; n < 32; n++) {
            const { record, index } = await this.#index(), row = await this.store.read(key);
            if (!row)
                return false;
            const c = checkpoint(row.content, runId), task = index.tasks.find(t => t.runId === runId && (t.state === 'ready' || t.state === 'blocked' && t.owner === null));
            if (!task) {
                if (index.tasks.some(t => t.runId === runId && ['leased', 'blocked'].includes(t.state)))
                    throw new DefinitionError('QUEUE_TASK_ACTIVE');
                return false;
            }
            if (c.snapshot.currentIdentity !== null || c.snapshot.cancelRequested)
                throw new DefinitionError('QUEUE_TASK_ACTIVE');
            const value = { ...structuredClone(c), snapshot: { ...c.snapshot, status: 'cancelled', cancelRequested: true, reason: 'CANCEL_REQUESTED', currentNode: null, currentIdentity: null }, cursor: { ...c.cursor, node: null } };
            task.state = 'done';
            task.reason = 'CANCEL_REQUESTED';
            try {
                await this.store.commitRecords([{ runId: indexId, revision: record!.revision }, { runId: key, revision: row.revision }], [{ runId: indexId, content: asJson(index) }, { runId: key, content: asJson(value) }]);
                return true;
            }
            catch (e) {
                if (!(e instanceof RunStoreError) || e.code !== 'RUN_REVISION_CONFLICT')
                    throw e;
            }
        }
        throw new DefinitionError('QUEUE_CONTENTION');
    }
}
