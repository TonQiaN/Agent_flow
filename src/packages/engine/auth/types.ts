/** The credential identity is shared across Profile aliases. It contains no secret. */
export interface CredentialIdentity {
  readonly credentialRef: string;
  readonly service: string;
  readonly method: string;
}
export interface CredentialMetadata extends CredentialIdentity {
  readonly generation: string;
  readonly revision: number;
  readonly remoteStatus: 'unknown';
}
export type CredentialSource = { readonly content: string; readonly file?: never }
  | { readonly file: string; readonly content?: never };
export interface CredentialLease {
  readonly metadata: CredentialMetadata;
  /** Trusted binding layer only. Do not put this return value in logs or workflow data. */
  readSecret(): Promise<string>;
  commitSecret(content: string, expectedRevision: number): Promise<CredentialMetadata>;
  release(): Promise<void>;
}
export interface CredentialStore {
  configure(identity: CredentialIdentity, source: CredentialSource, waitMs?: number): Promise<CredentialMetadata>;
  inspect(identity: CredentialIdentity): Promise<CredentialMetadata | null>;
  acquire(identity: CredentialIdentity, waitMs?: number): Promise<CredentialLease>;
  delete(identity: CredentialIdentity, waitMs?: number): Promise<{ readonly deleted: boolean; readonly remoteRevoked: false }>;
}

/** Host management can reserve an identity before its first credential exists. */
export interface CredentialManagementLease {
  readonly metadata: CredentialMetadata | null;
  configure(content: string): Promise<CredentialMetadata>;
  release(): Promise<void>;
}
export interface CredentialManagementStore extends CredentialStore {
  acquireManagement(identity: CredentialIdentity, waitMs?: number): Promise<CredentialManagementLease>;
}

/** Explicit local repair; neither a new login nor proof of remote validity. */
export interface CredentialRecoveryResult {
  readonly status: 'healthy' | 'restored' | 'not_configured' | 'unavailable';
  readonly credential: CredentialMetadata | null;
  readonly diagnostic: string | null;
}
export interface CredentialRecoveryStore extends CredentialStore {
  recover(identity: CredentialIdentity, waitMs?: number): Promise<CredentialRecoveryResult>;
}

/** Non-secret dispatch constraints exposed by the actual installed Driver/Profile. */
export interface AgentDispatchBinding {
  /** Current host pre-execution reservation; never part of the durable execution definition. */
  readonly admissionToken?: string;
  readonly harness: string;
  readonly credential: CredentialIdentity;
  readonly capacity: number | null;
}

export interface AdmittedCredentialStore extends CredentialStore { admissionToken(): string }
