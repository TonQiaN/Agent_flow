import type { CredentialIdentity } from '../auth/types.js';
import type { RunRecordStore } from '../persistence/types.js';
export interface NodeRequirements {
    readonly role: string;
    readonly capability: string;
    readonly credential?: CredentialIdentity;
    readonly harness?: string;
}
export interface QueueConfiguration {
    readonly roles: Readonly<Record<string, number>>;
    readonly credentials: readonly {
        readonly identity: CredentialIdentity;
        readonly capacity: number | null;
    }[];
    readonly workflows: Readonly<Record<string, Readonly<Record<string, NodeRequirements>>>>;
}
export interface NodeTaskClaim {
    readonly key: string;
    readonly runId: string;
    readonly nodeTaskId: string;
    readonly node: string;
    readonly worker: string;
    readonly token: string;
    readonly recovering: boolean;
    readonly admissionTokens: readonly string[];
    readonly requirements: NodeRequirements;
    readonly credentialCapacity: number | null;
}
export interface QueuedNodeTask {
    readonly key: string;
    readonly sequence: number;
    readonly runId: string;
    readonly workflowId: string;
    readonly nodeTaskId: string;
    readonly node: string;
    readonly requirements: NodeRequirements;
    readonly state: 'ready' | 'leased' | 'blocked' | 'done';
    readonly admissionTokens: readonly string[];
    readonly notBefore: number;
    readonly owner: {
        readonly worker: string;
        readonly token: string;
        readonly deadline: number;
    } | null;
    readonly reason: string | null;
}
export interface NodeTaskQueue {
    records(): RunRecordStore;
    query(): Promise<readonly QueuedNodeTask[]>;
    claim(worker: string, capabilities: readonly string[], leaseMs: number): Promise<NodeTaskClaim | null>;
    heartbeat(claim: NodeTaskClaim, leaseMs: number): Promise<boolean>;
    bind(claim: NodeTaskClaim): RunRecordStore;
    block(claim: NodeTaskClaim, reason: string): Promise<void>;
    retryRecovery(key: string): Promise<void>;
    waitForCredential(claim: NodeTaskClaim): Promise<void>;
    cancelReady(runId: string): Promise<boolean>;
}

/** Host capability: acquire before an Attempt, finalize only after normal resource cleanup. */
export interface NodeCredentialAdmission {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}
