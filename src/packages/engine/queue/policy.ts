import { isIdentifier } from '@agentflow/domain';
import { canonicalJson, copyJson } from '../json.js';
import { DefinitionError } from '../errors.js';
import type { CredentialIdentity } from '../auth/types.js';
import type { QueueConfiguration, QueuedNodeTask } from './types.js';
export const credentialCapacityKey = (identity: CredentialIdentity): string => canonicalJson(copyJson(identity));
export function validateQueueConfiguration(input: QueueConfiguration): QueueConfiguration {
    const value = copyJson(input) as unknown as QueueConfiguration;
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const capacity = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= 1024;
    if (!object(value) || Object.keys(value).sort().join(',') !== 'credentials,roles,workflows' || !object(value.roles) || !Object.keys(value.roles).length
        || Object.entries(value.roles).some(([id, n]) => !isIdentifier(id) || !capacity(n)) || !Array.isArray(value.credentials) || !object(value.workflows))
        throw new DefinitionError('INVALID_QUEUE_CONFIGURATION');
    const credentials = new Set<string>();
    for (const credential of value.credentials) {
        if (!object(credential) || Object.keys(credential).sort().join(',') !== 'capacity,identity' || !object(credential.identity)
            || Object.keys(credential.identity).sort().join(',') !== 'credentialRef,method,service' || !Object.values(credential.identity).every(isIdentifier)
            || credential.capacity !== null && !capacity(credential.capacity))
            throw new DefinitionError('INVALID_QUEUE_CONFIGURATION');
        const key = credentialCapacityKey(credential.identity as unknown as CredentialIdentity);
        if (credentials.has(key))
            throw new DefinitionError('DUPLICATE_QUEUE_CREDENTIAL');
        credentials.add(key);
    }
    for (const [workflow, nodes] of Object.entries(value.workflows)) {
        if (!isIdentifier(workflow) || !object(nodes) || !Object.keys(nodes).length)
            throw new DefinitionError('INVALID_QUEUE_CONFIGURATION');
        for (const [node, r] of Object.entries(nodes))
            if (!isIdentifier(node) || !object(r) || Object.keys(r).some(k => !['role', 'capability', 'credential'].includes(k))
                || !isIdentifier(r.role) || !Object.hasOwn(value.roles, r.role) || !isIdentifier(r.capability) || r.credential !== undefined && !credentials.has(credentialCapacityKey(r.credential)))
                throw new DefinitionError('INVALID_QUEUE_CONFIGURATION');
    }
    return value;
}
/** Capacity occupied by lost/blocked workers is still capacity. Expiry alone never releases it. */
export function waitingReason(task: QueuedNodeTask, tasks: readonly QueuedNodeTask[], config: QueueConfiguration, capabilities: readonly string[]): string | null {
    if (!capabilities.includes(task.requirements.capability))
        return 'CAPABILITY_UNAVAILABLE';
    const held = tasks.filter(t => t.state === 'leased' || t.state === 'blocked' && t.owner !== null);
    if (held.filter(t => t.requirements.role === task.requirements.role).length >= config.roles[task.requirements.role]!)
        return 'ROLE_CAPACITY';
    if (task.requirements.credential) {
        const key = credentialCapacityKey(task.requirements.credential), limit = config.credentials.find(c => credentialCapacityKey(c.identity) === key)!.capacity;
        if (limit !== null && held.filter(t => t.requirements.credential && credentialCapacityKey(t.requirements.credential) === key).length >= limit)
            return 'CREDENTIAL_CAPACITY';
    }
    return null;
}
