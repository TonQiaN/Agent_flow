import { isExecutionIdentity } from '@agentflow/domain';
import type { ExecutionIdentity } from '@agentflow/domain';
import type { Cancellation, CredentialIdentity, CredentialManagementLease, CredentialManagementStore, CredentialMetadata, RunnerResult } from '@agentflow/engine';

/** Trusted execution port, never Workflow JSON. Provider commands and interactive IO belong to the driver. */
export interface SubscriptionLoginDriver {
  run(identity: ExecutionIdentity, cancellation: Cancellation): Promise<RunnerResult>;
  readCredential(result: RunnerResult): Promise<string>;
  recover(previous: RunnerResult | null): Promise<RunnerResult>;
  /** Remove private temporary material only after the execution is stopped and its resources removed. */
  release(result: RunnerResult): Promise<void>;
}
export interface SubscriptionLoginResult {
  readonly identity: ExecutionIdentity;
  readonly status: 'configured' | 'failed' | 'pending_cleanup';
  readonly credential: CredentialMetadata | null;
  readonly diagnostics: readonly string[];
}

export class SubscriptionLoginCoordinator {
  constructor(private readonly store: CredentialManagementStore) {}
  async run(options: { readonly identity: ExecutionIdentity; readonly credential: CredentialIdentity }, driver: SubscriptionLoginDriver,
    cancellation: Cancellation = { requested: () => false }): Promise<SubscriptionLoginAttempt> {
    if (!options || Object.keys(options).sort().join(',') !== 'credential,identity' || !isExecutionIdentity(options.identity)
      || options.credential?.method !== 'subscription' || !driver || ['run', 'readCredential', 'recover', 'release'].some(key => typeof driver[key as keyof SubscriptionLoginDriver] !== 'function'))
      throw new Error('INVALID_SUBSCRIPTION_LOGIN');
    const identity = Object.freeze({ ...options.identity }), credential = Object.freeze({ ...options.credential });
    const lease = await this.store.acquireManagement(credential);
    const attempt = new SubscriptionLoginAttempt(identity, lease, driver, cancellation);
    await attempt.execute(); return attempt;
  }
}

/** Retains management ownership after uncertain execution or private-material cleanup. No implicit re-login. */
export class SubscriptionLoginAttempt {
  #execution: RunnerResult | null = null;
  #canSave = false;
  #saveAttempted = false;
  #saved = false;
  #privateReleased = false;
  #released = false;
  #started = false;
  #diagnostics: string[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  readonly #identity: ExecutionIdentity; readonly #lease: CredentialManagementLease;
  readonly #driver: SubscriptionLoginDriver; readonly #cancellation: Cancellation;
  constructor(identity: ExecutionIdentity, lease: CredentialManagementLease, driver: SubscriptionLoginDriver, cancellation: Cancellation) {
    this.#identity = Object.freeze({ ...identity }); this.#lease = lease; this.#driver = driver; this.#cancellation = cancellation;
  }
  get result(): SubscriptionLoginResult {
    return structuredClone({ identity: this.#identity, status: this.#released ? this.#saved ? 'configured' : 'failed' : 'pending_cleanup',
      credential: this.#lease.metadata, diagnostics: this.#diagnostics });
  }
  toJSON(): SubscriptionLoginResult { return this.result; }
  #note(code: string): void { if (!this.#diagnostics.includes(code)) this.#diagnostics.push(code); }
  #serial(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(operation); this.#queue = next.catch(() => undefined); return next;
  }
  #accept(result: RunnerResult): void {
    const proof = structuredClone(result);
    if (!proof || !isExecutionIdentity(proof.identity)
      || proof.resource !== null && (!proof.resource || typeof proof.resource.id !== 'string' || !proof.resource.id || proof.resource.id.length > 256 || proof.resource.id.includes('\0'))
      || !['exited', 'failed', 'cancelled', 'timed_out'].includes(proof.phase) || proof.exitCode !== null && !Number.isSafeInteger(proof.exitCode)
      || !['confirmed', 'unknown', 'not_started'].includes(proof.stop) || !['removed', 'failed', 'blocked', 'not_created'].includes(proof.cleanup)
      || Object.entries(this.#identity).some(([key, value]) => proof.identity[key as keyof ExecutionIdentity] !== value)
      || this.#execution?.resource && proof.resource?.id !== this.#execution.resource.id) throw new Error('LOGIN_EXECUTION_MISMATCH');
    this.#execution = proof;
  }
  execute(): Promise<void> {
    return this.#serial(async () => {
      if (this.#started) throw new Error('LOGIN_ALREADY_STARTED'); this.#started = true;
      try {
        this.#accept(await this.#driver.run(this.#identity, this.#cancellation));
        this.#canSave = this.#execution!.resource !== null && this.#execution!.phase === 'exited' && this.#execution!.exitCode === 0
          && this.#execution!.stop === 'confirmed' && !this.#cancellation.requested();
        if (!this.#canSave) this.#note('LOGIN_EXECUTION_NOT_SUCCESSFUL');
      } catch { this.#note('LOGIN_EXECUTION_NOT_CONFIRMED'); }
      await this.#settle();
    });
  }
  async #settle(): Promise<void> {
    if (this.#released) return;
    const proof = this.#execution;
    if (!proof || (proof.resource ? proof.stop !== 'confirmed' || proof.cleanup !== 'removed' : proof.stop !== 'not_started' || proof.cleanup !== 'not_created')) {
      this.#note('LOGIN_CLEANUP_NOT_CONFIRMED'); return;
    }
    if (this.#canSave && !this.#saveAttempted) {
      this.#saveAttempted = true;
      try {
        const content = await this.#driver.readCredential(structuredClone(proof));
        if (this.#cancellation.requested()) this.#note('LOGIN_CANCELLED_BEFORE_SAVE');
        else { await this.#lease.configure(content); this.#saved = true; }
      } catch { this.#note('LOGIN_CONFIGURATION_NOT_CONFIRMED'); }
    }
    if (!this.#privateReleased) {
      try { await this.#driver.release(structuredClone(proof)); this.#privateReleased = true; }
      catch { this.#note('LOGIN_PRIVATE_CLEANUP_FAILED'); return; }
    }
    try { await this.#lease.release(); this.#released = true; }
    catch { this.#note('LOGIN_MANAGEMENT_RELEASE_FAILED'); }
  }
  retryCleanup(): Promise<void> {
    return this.#serial(async () => {
      if (this.#released) return;
      // Private release already proved and consumed the workspace; only the lease release remains.
      if (this.#privateReleased) { await this.#settle(); return; }
      try { this.#accept(await this.#driver.recover(this.#execution ? structuredClone(this.#execution) : null)); }
      catch { this.#note('LOGIN_RECOVERY_NOT_CONFIRMED'); return; }
      // Recovery proves cleanup; it never turns the original failed login into a successful one.
      await this.#settle();
    });
  }
}
