import { canonicalJson, snapshotJson } from '@agentflow/engine';
import type { CredentialIdentity, AdmittedCredentialStore, NodeCredentialAdmission, NodeTaskClaim } from '@agentflow/engine';
import { CredentialError, FileCredentialStore } from '../auth/file-store.js';
import type { ExecutionCredentialStore } from '../auth/file-store.js';

/** One source and exact credential identity; no account selection, endpoint change or secret in the claim. */
export function createQueueCredentialAdmission(source: FileCredentialStore, claim: NodeTaskClaim): {
  admission: NodeCredentialAdmission;
  credentials: AdmittedCredentialStore & ExecutionCredentialStore;
} {
  const selected = structuredClone(claim), identity = selected.requirements.credential;
  if (!identity || !selected.admissionTokens.includes(selected.token)) throw new CredentialError('INVALID_CREDENTIAL_ADMISSION');
  const same = (value: CredentialIdentity) => {
    if (canonicalJson(snapshotJson(value)) !== canonicalJson(snapshotJson(identity))) throw new CredentialError('CREDENTIAL_ADMISSION_IDENTITY_MISMATCH');
  };
  const forbidden = async (): Promise<never> => { throw new CredentialError('CREDENTIAL_ADMISSION_MANAGEMENT_FORBIDDEN'); };
  return {
    admission: {
      async acquire() {
        for (const token of selected.admissionTokens) if (token !== selected.token) await source.releaseAdmission(identity, token);
        return source.acquireAdmission(identity, selected.token);
      },
      release: () => source.releaseAdmission(identity, selected.token),
    },
    credentials: {
      admissionToken: () => selected.token,
      configure: forbidden, delete: forbidden,
      inspect: async value => { same(value); return source.inspect(value); },
      acquire: async value => { same(value); return source.readAdmission(identity, selected.token); },
      executionDefinition: () => source.executionDefinition(),
      acquireExecution: async (value, resource) => { same(value); return source.acquireExecution(identity, resource, selected.token); },
      // Recovery restores historical resources, which may belong to earlier dispatch tokens.
      finishExecution: async (value, resource, content) => { same(value); return source.finishExecution(identity, resource, content); },
    },
  };
}
