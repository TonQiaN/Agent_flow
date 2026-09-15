import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import type { CredentialIdentity, ExecutionResource } from '@agentflow/engine';
import type { PrivateStateBinding } from '../execution/state-binding.js';
import { CredentialError } from './file-store.js';

/** No secret, generation, revision or secret hash. Keys describe the trusted transport only. */
export function environmentResourceDefinition(credential: CredentialIdentity, keys: readonly string[]): JsonValue {
  if (!credential || Object.keys(credential).sort().join(',') !== 'credentialRef,method,service'
    || !Object.values(credential).every(isIdentifier) || !Array.isArray(keys) || !keys.length || keys.length > 16
    || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,55}_(?:API_KEY|TOKEN)$/.test(key) || key.startsWith('AGENTFLOW_')))
    throw new CredentialError('INVALID_ENVIRONMENT_RESOURCE_DEFINITION');
  return { schema: 'agentflow-environment-resource/v1', credential: { ...credential }, keys: [...keys].sort() };
}

/** Installs only management obligations. It cannot acquire, prepare or expose a credential. */
export function environmentRecoveryBinding(credential: CredentialIdentity, keys: readonly string[]): PrivateStateBinding {
  const definition = environmentResourceDefinition(credential, keys);
  let owned: string | null = null;
  return Object.freeze({ environment: Object.freeze({}), resourceDefinition: () => structuredClone(definition),
    async restoreResource(resource: ExecutionResource) {
      if (owned !== null || !resource || typeof resource.id !== 'string' || !resource.id) throw new CredentialError('BINDING_ALREADY_USED');
      owned = resource.id;
    },
    async prepare() { throw new CredentialError('RECOVERY_BINDING_CANNOT_EXECUTE'); },
    secretEnvironment() { throw new CredentialError('RECOVERY_BINDING_CANNOT_EXECUTE'); },
    async beforeRelease(resource: ExecutionResource) {
      if (owned === null || resource.id !== owned) throw new CredentialError('BINDING_EXECUTION_MISMATCH');
    },
  });
}
