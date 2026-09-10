import { getPlan } from '../workflow/compiler.js';
import { canonicalJson, copyJson } from '../json.js';
import { isIdentifier } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import type { RunRecordStore } from '../persistence/types.js';
import type { Clock } from '../runner/types.js';
import { claimWorkflowRecovery } from '../workflow/recovery.js';
import type { WorkflowRecoveryHandle } from '../workflow/recovery.js';
import { WorkflowRuntime } from '../workflow/runtime.js';
import type { WorkflowResumedRunHandle } from '../workflow/runtime.js';
import type { CompiledWorkflow, WorkflowSnapshot } from '../workflow/types.js';
import type { NodeTaskQueue, NodeTaskClaim, NodeCredentialAdmission } from './types.js';
export interface NodeWorkerHost {
    open(runId: string, records: RunRecordStore, claim: NodeTaskClaim): Promise<{
        compiled: CompiledWorkflow;
        runtime: WorkflowRuntime;
        admission?: NodeCredentialAdmission;
        dispose?(snapshot?: WorkflowSnapshot): Promise<void>;
    }>;
}
export interface NodeWorkerResult {
    readonly claim: NodeTaskClaim;
    readonly snapshot: WorkflowSnapshot | null;
    readonly error: string | null;
    readonly waiting?: string;
}
/** One Attempt per claim. Application composition, routing and resource implementation stay outside. */
export class NodeWorker {
    #stopping = false;
    #cancel = false;
    #busy = false;
    #active: WorkflowResumedRunHandle | undefined;
    readonly #capabilities: readonly string[];
    constructor(private readonly queue: NodeTaskQueue, private readonly host: NodeWorkerHost, private readonly clock: Clock, private readonly worker: string, capabilities: readonly string[], private readonly leaseMs = 30000) {
        if (!isIdentifier(worker) || !Array.isArray(capabilities) || !capabilities.every(isIdentifier) || !Number.isSafeInteger(leaseMs) || leaseMs < 300 || leaseMs > 3600000)
            throw new DefinitionError('INVALID_WORKER_CONFIGURATION');
        this.#capabilities = Object.freeze([...capabilities]);
    }
    query(): {
        worker: string;
        state: 'idle' | 'working' | 'draining' | 'stopped';
    } { return { worker: this.worker, state: this.#stopping ? (this.#busy ? 'draining' : 'stopped') : (this.#busy ? 'working' : 'idle') }; }
    async stop(mode: 'drain' | 'cancel' = 'drain'): Promise<void> {
        if (mode !== 'drain' && mode !== 'cancel')
            throw new DefinitionError('INVALID_WORKER_STOP');
        this.#stopping = true;
        if (mode === 'cancel') {
            this.#cancel = true;
            await this.#active?.cancel();
        }
    }
    async runOnce(): Promise<NodeWorkerResult | null> {
        if (this.#stopping)
            return null;
        if (this.#busy)
            throw new DefinitionError('WORKER_ALREADY_RUNNING');
        this.#busy = true;
        let claim: NodeTaskClaim | null = null, heartbeat: Promise<void> | undefined, live = true, recovery: WorkflowRecoveryHandle | undefined, opened: Awaited<ReturnType<NodeWorkerHost['open']>> | undefined, snapshot: WorkflowSnapshot | undefined, lost = false;
        try {
            claim = await this.queue.claim(this.worker, this.#capabilities, this.leaseMs);
            if (!claim)
                return null;
            const selected = claim;
            heartbeat = (async () => {
                while (live) {
                    await this.clock.sleep(Math.min(1000, Math.floor(this.leaseMs / 3)));
                    if (!live)
                        break;
                    try {
                        if (!await this.queue.heartbeat(selected, this.leaseMs))
                            break;
                    }
                    catch {
                        lost = true;
                        await this.#active?.cancel().catch(() => { });
                        break;
                    }
                }
            })();
            const records = this.queue.bind(claim);
            opened = await this.host.open(claim.runId, records, claim);
            if (lost)
                throw new DefinitionError('QUEUE_CLAIM_LOST');
            const node = getPlan(opened.compiled).bindings.get(claim.node);
            if (!node) throw new DefinitionError('QUEUE_NODE_BINDING_MISMATCH');
            const actual = node.executor.dispatchBinding?.(node.component);
            if (node.component.kind === 'agent' && !actual) throw new DefinitionError('QUEUE_AGENT_BINDING_UNAVAILABLE');
            if (actual) {
                if (actual.harness !== claim.requirements.harness || !claim.requirements.credential
                    || canonicalJson(copyJson(actual.credential)) !== canonicalJson(copyJson(claim.requirements.credential))
                    || actual.capacity !== null && (claim.credentialCapacity === null || claim.credentialCapacity > actual.capacity))
                    throw new DefinitionError('QUEUE_NODE_BINDING_MISMATCH');
                if (!opened.admission || actual.admissionToken !== claim.token) throw new DefinitionError('QUEUE_CREDENTIAL_ADMISSION_REQUIRED');
            }

            recovery = await claimWorkflowRecovery(opened.compiled, claim.runId, records);
            await recovery.cleanup();
            if (opened.admission && !await opened.admission.acquire()) {
                await opened.admission.release();
                await this.queue.waitForCredential(selected);
                return { claim, snapshot: null, error: null, waiting: 'CREDENTIAL_SOURCE_BUSY' };
            }
            this.#active = await opened.runtime.resumePersistedNode(recovery);
            if (this.#cancel)
                await this.#active.cancel();
            snapshot = await this.#active.completion;
            await opened.admission?.release();
            const task = (await this.queue.query()).find(t => t.key === selected.key);
            if (task?.state !== 'done') {
                await this.queue.block(selected, 'WORKER_RESULT_UNCONFIRMED');
                return { claim, snapshot, error: 'WORKER_RESULT_UNCONFIRMED' };
            }
            return { claim, snapshot, error: null };
        }
        catch (e) {
            const code = e instanceof DefinitionError ? e.code : 'WORKER_EXECUTION_FAILED';
            await opened?.admission?.release().catch(() => {});
            if (claim)
                await this.queue.block(claim, code).catch(() => { });
            if (!claim)
                throw e;
            return { claim, snapshot: snapshot ?? null, error: code };
        }
        finally {
            live = false;
            try {
                await heartbeat;
                try {
                    await opened?.dispose?.(snapshot);
                }
                finally {
                    await this.#active?.dispose();
                    await recovery?.dispose();
                }
            }
            finally {
                this.#active = undefined;
                this.#busy = false;
            }
        }
    }
    async runUntilIdle(): Promise<readonly NodeWorkerResult[]> { const results: NodeWorkerResult[] = []; while (!this.#stopping) {
        const r = await this.runOnce();
        if (!r)
            break;
        results.push(r);
    } return results; }
    async runUntilStopped(pollMs = 1000): Promise<void> {
        if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60000)
            throw new DefinitionError('INVALID_WORKER_POLL');
        while (!this.#stopping) {
            if (!await this.runOnce() && !this.#stopping)
                await this.clock.sleep(pollMs);
        }
    }
}
