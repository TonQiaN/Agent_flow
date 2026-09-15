import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
import { ContractRegistry } from '../contracts/registry.js';
import type { ContractIssue } from '../contracts/registry.js';
import { ComponentRegistry } from './registry.js';
import type { EffectRecord, EffectRecordStore } from '../persistence/effects.js';
import type { Cancellation } from '../runner/types.js';

export const EFFECT_RECEIPT_SCHEMA = 'agentflow-effect-receipt/v1';
export type EffectMode = 'dry-run' | 'apply';
export type EffectStatus = 'simulated' | 'applied' | 'already-applied';
export interface EffectRequest {
  readonly identity: ExecutionIdentity;
  readonly componentId: string;
  readonly target: string;
  readonly key: string;
  readonly input: JsonValue;
  readonly mode?: EffectMode;
}
export interface EffectAdapterRequest {
  readonly requestId: string;
  readonly componentId: string;
  readonly target: string;
  readonly key: string;
  readonly input: JsonValue;
  readonly serviceIdentity: string;
  readonly mode: EffectMode;
}
export interface EffectReceipt {
  readonly schema: typeof EFFECT_RECEIPT_SCHEMA;
  readonly requestId: string;
  readonly componentId: string;
  readonly target: string;
  readonly key: string;
  readonly serviceIdentity: string;
  readonly mode: EffectMode;
  readonly status: EffectStatus;
  readonly reference: string | null;
}
/** Trusted service capability; business credentials remain inside this adapter. */
export interface EffectAdapter {
  readonly implementation: string;
  readonly serviceIdentity: string;
  /** Actual installed service implementation/version; no credentials or external operation. */
  definition?(): Promise<JsonValue>;
  simulate(request: EffectAdapterRequest): Promise<EffectReceipt>;
  apply(request: EffectAdapterRequest): Promise<EffectReceipt>;
}
/** The matching object must be present in this executor's private authorization registry. */
export interface EffectApproval { readonly kind: 'effect-approval' }
export type EffectResult = { readonly identity: ExecutionIdentity; readonly componentId: string } & (
  { readonly status: 'accepted'; readonly outcome: EffectStatus; readonly output: EffectReceipt }
  | { readonly status: 'failed'; readonly code: string; readonly stopped: boolean; readonly issues: readonly ContractIssue[] });
export interface EffectRecordView {
  readonly key: string;
  readonly requestId: string;
  readonly componentId: string;
  readonly target: string;
  readonly serviceIdentity: string;
  readonly state: 'pending' | 'applied' | 'unknown';
  readonly receipt: EffectReceipt | null;
}
interface RecordEntry { readonly fingerprint: string; readonly request: EffectAdapterRequest; state: EffectRecordView['state']; receipt: EffectReceipt | null }
const clone = <T>(v: T): T => copyJson(v) as unknown as T;
const canonical = (v: JsonValue): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k]!)).join(',') + '}';
};
const attemptKey = (i: ExecutionIdentity): string => JSON.stringify([i.runId, i.nodeTaskId, i.attemptId]);
const outcomeNames = ['already-applied', 'applied', 'simulated'];
let nextExecutorId = 0;

/** Scoped approval and optional durable operation reservations; never promises arbitrary-service exactly-once. */
export class EffectExecutor {
  readonly #adapter: EffectAdapter;
  readonly #store: EffectRecordStore | null;
  readonly #approvals = new WeakMap<EffectApproval, { fingerprint: string; consumed: boolean }>();
  readonly #attempts = new Set<string>();
  readonly #records = new Map<string, RecordEntry>();
  readonly #namespace = ++nextExecutorId;
  #sequence = 0;
  constructor(private readonly contracts: ContractRegistry, private readonly components: ComponentRegistry, adapter: EffectAdapter, store?: EffectRecordStore) {
    if (!isIdentifier(adapter.implementation) || !isIdentifier(adapter.serviceIdentity) || typeof adapter.simulate !== 'function' || typeof adapter.apply !== 'function' || adapter.definition !== undefined && typeof adapter.definition !== 'function') throw new DefinitionError('INVALID_EFFECT_ADAPTER');
    if (store && (!isIdentifier(store.identity) || ['read', 'create', 'compareAndSwap'].some(k => typeof store[k as 'read'] !== 'function'))) throw new DefinitionError('INVALID_EFFECT_STORE');
    this.#store = store ? Object.freeze({ identity: store.identity, read: store.read.bind(store), create: store.create.bind(store), compareAndSwap: store.compareAndSwap.bind(store) }) : null;
    this.#adapter = Object.freeze({ implementation: adapter.implementation, serviceIdentity: adapter.serviceIdentity,
      simulate: adapter.simulate.bind(adapter), apply: adapter.apply.bind(adapter), ...(adapter.definition ? { definition: adapter.definition.bind(adapter) } : {}) });
  }
  validateComponent(id: string): void {
    const c = this.components.get(id);
    if (c.kind !== 'effect' || c.implementation !== this.#adapter.implementation || Object.keys(c.outcomes).sort().join(',') !== outcomeNames.join(',')) throw new DefinitionError('INVALID_EFFECT_COMPONENT');
    for (const id of [c.inputContract, ...Object.values(c.outcomes)]) if (!this.contracts.has(id)) throw new DefinitionError('UNKNOWN_CONTRACT');
  }
  private prepare(request: EffectRequest) {
    let r: EffectRequest;
    try { r = clone(request); } catch { throw new DefinitionError('INVALID_EFFECT_REQUEST'); }
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join(',') !== ('mode' in r ? 'componentId,identity,input,key,mode,target' : 'componentId,identity,input,key,target')
      || !isExecutionIdentity(r.identity) || !isIdentifier(r.componentId) || !isIdentifier(r.target) || !isIdentifier(r.key)
      || r.mode !== undefined && r.mode !== 'dry-run' && r.mode !== 'apply') throw new DefinitionError('INVALID_EFFECT_REQUEST');
    this.validateComponent(r.componentId);
    const component = this.components.get(r.componentId), mode = r.mode ?? 'dry-run';
    const fingerprint = canonical(copyJson([r.componentId, component.implementation, this.#adapter.serviceIdentity, r.target, r.key, r.input]));
    const approvalFingerprint = canonical(copyJson([fingerprint, r.identity, mode]));
    return { r, component, mode, fingerprint, approvalFingerprint };
  }
  /** Explicit host control API. Never call automatically on data supplied by an agent. */
  authorize(request: EffectRequest): EffectApproval {
    const p = this.prepare(request);
    if (p.mode !== 'apply' || !this.contracts.check(p.component.inputContract, p.r.input).valid) throw new DefinitionError('INVALID_EFFECT_APPROVAL_REQUEST');
    const approval: EffectApproval = Object.freeze({ kind: 'effect-approval' });
    this.#approvals.set(approval, { fingerprint: p.approvalFingerprint, consumed: false }); return approval;
  }
  query(key: string): EffectRecordView | null {
    const entry = this.#records.get(key); if (!entry) return null;
    return clone({ key, requestId: entry.request.requestId, componentId: entry.request.componentId, target: entry.request.target,
      serviceIdentity: entry.request.serviceIdentity, state: entry.state, receipt: entry.receipt });
  }
  /** Durable namespace identity for installed composition checks; no paths or business credentials. */
  persistenceIdentity(): string | null { return this.#store?.identity ?? null; }
  async definitionSnapshot(): Promise<JsonValue> {
    if (!this.#store || !this.#adapter.definition) throw new DefinitionError('EFFECT_EXECUTION_DEFINITION_UNAVAILABLE');
    const actual = copyJson(await this.#adapter.definition());
    if (!actual || typeof actual !== 'object' || Array.isArray(actual) || typeof actual['schema'] !== 'string' || !actual['schema']) throw new DefinitionError('INVALID_EFFECT_EXECUTION_DEFINITION');
    return copyJson({ schema: 'agentflow-effect-execution/v1', implementation: this.#adapter.implementation,
      serviceIdentity: this.#adapter.serviceIdentity, journalIdentity: this.#store.identity, adapter: actual });
  }
  private async operationFor(request: EffectRequest): Promise<{ prepared: ReturnType<EffectExecutor['prepare']>; prior: RecordEntry | null }> {
    const prepared = this.prepare(request);
    if (!this.#store || prepared.mode !== 'apply') throw new DefinitionError('EFFECT_PERSISTENCE_UNAVAILABLE');
    const row = await this.#store.read(prepared.r.key), prior = row ? this.durable(row, prepared.r.key) : null;
    if (prior && prior.fingerprint !== prepared.fingerprint) throw new DefinitionError('EFFECT_KEY_CONFLICT');
    if (prior && prior.state !== 'applied') throw new DefinitionError('EFFECT_RESULT_UNKNOWN');
    return { prepared, prior };
  }
  /** Read-only admission check; unique durable reservation still arbitrates any late writer. */
  async checkRecovery(request: EffectRequest): Promise<void> { await this.operationFor(request); }
  /** Validate saved business facts; never authorize, call the service, or import a receipt. */
  async validateDurableReceipt(request: EffectRequest, outcome: string, output: JsonValue): Promise<void> {
    const { prepared, prior } = await this.operationFor(request);
    if (!prior || !['applied', 'already-applied'].includes(outcome)
      || canonical(copyJson({ ...prior.receipt!, status: outcome })) !== canonical(copyJson(output))
      || !this.contracts.check(prepared.component.outcomes[outcome]!, output).valid) throw new DefinitionError('INVALID_DURABLE_EFFECT_RECEIPT');
  }
  private durable(record: EffectRecord, key: string): RecordEntry {
    const fail = (): never => { throw new DefinitionError('INVALID_EFFECT_RECORD'); };
    const row = clone(record), c = row.content;
    if (Object.keys(row).sort().join(',') !== 'content,key,revision' || row.key !== key || !c || typeof c !== 'object' || Array.isArray(c)
      || Object.keys(c).sort().join(',') !== 'fingerprint,receipt,request,schema,state' || c['schema'] !== 'agentflow-effect-operation/v1'
      || !['pending', 'applied'].includes(String(c['state'])) || row.revision !== (c['state'] === 'pending' ? 1 : 2)) return fail();
    const r = c['request'] as unknown as EffectAdapterRequest;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join(',') !== 'componentId,input,key,mode,requestId,serviceIdentity,target'
      || r.key !== key || r.requestId !== key || r.mode !== 'apply' || !isIdentifier(r.componentId) || !isIdentifier(r.target)
      || r.serviceIdentity !== this.#adapter.serviceIdentity) return fail();
    this.validateComponent(r.componentId);
    const component = this.components.get(r.componentId);
    const fingerprint = canonical(copyJson([r.componentId, component.implementation, r.serviceIdentity, r.target, r.key, r.input]));
    if (c['fingerprint'] !== fingerprint || !this.contracts.check(component.inputContract, r.input).valid) return fail();
    if (c['state'] === 'pending') { if (c['receipt'] !== null) return fail(); }
    else {
      const receipt = this.receipt(c['receipt'], r, 'applied');
      if (!this.contracts.check(component.outcomes['applied']!, receipt).valid) return fail();
    }
    return { fingerprint, request: r, state: c['state'] as 'pending' | 'applied', receipt: c['receipt'] as unknown as EffectReceipt | null };
  }
  private durableContent(entry: RecordEntry): JsonValue {
    return copyJson({ schema: 'agentflow-effect-operation/v1', ...entry });
  }
  async queryDurable(key: string): Promise<EffectRecordView | null> {
    if (!this.#store) throw new DefinitionError('EFFECT_PERSISTENCE_UNAVAILABLE');
    const row = await this.#store.read(key); if (!row) return null;
    const entry = this.durable(row, key);
    return clone({ key, requestId: entry.request.requestId, componentId: entry.request.componentId, target: entry.request.target,
      serviceIdentity: entry.request.serviceIdentity, state: entry.state, receipt: entry.receipt });
  }
  private receipt(value: unknown, request: EffectAdapterRequest, status: EffectStatus): EffectReceipt {
    let receipt: EffectReceipt;
    try { receipt = clone(value) as EffectReceipt; } catch { throw new DefinitionError('INVALID_EFFECT_RECEIPT'); }
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'componentId,key,mode,reference,requestId,schema,serviceIdentity,status,target'
      || receipt.schema !== EFFECT_RECEIPT_SCHEMA || receipt.requestId !== request.requestId || receipt.componentId !== request.componentId
      || receipt.target !== request.target || receipt.key !== request.key || receipt.mode !== request.mode || receipt.serviceIdentity !== request.serviceIdentity
      || receipt.status !== status || receipt.reference !== null && !isIdentifier(receipt.reference)) throw new DefinitionError('INVALID_EFFECT_RECEIPT');
    return receipt;
  }
  async execute(request: EffectRequest, approval?: EffectApproval, cancellation: Cancellation = { requested: () => false }): Promise<EffectResult> {
    const p = this.prepare(request), { r, component, mode } = p;
    const failed = (code: string, stopped = true, issues: readonly ContractIssue[] = []): EffectResult => ({ identity: clone(r.identity), componentId: r.componentId, status: 'failed', code, stopped, issues });
    const accepted = (output: EffectReceipt): EffectResult => ({ identity: clone(r.identity), componentId: r.componentId, status: 'accepted', outcome: output.status, output: clone(output) });
    const key = attemptKey(r.identity); if (this.#attempts.has(key)) return failed('DUPLICATE_EFFECT_ATTEMPT', false); this.#attempts.add(key);
    const input = this.contracts.check(component.inputContract, r.input); if (!input.valid) return failed('INPUT_CONTRACT_FAILED', true, input.issues);
    try { if (cancellation.requested()) return failed('CANCELLED'); } catch { return failed('CANCELLATION_CHECK_FAILED'); }
    if (mode === 'dry-run' && approval !== undefined) return failed('EFFECT_APPROVAL_NOT_APPLICABLE');
    if (mode === 'apply') {
      const grant = approval && this.#approvals.get(approval);
      if (!grant || grant.consumed || grant.fingerprint !== p.approvalFingerprint) return failed('EFFECT_NOT_AUTHORIZED');
      grant.consumed = true; // Consume before any await, including reuse/conflict checks.
      let prior: RecordEntry | undefined;
      try {
        const row = this.#store ? await this.#store.read(r.key) : null;
        prior = this.#store ? row ? this.durable(row, r.key) : undefined : this.#records.get(r.key);
      } catch { return failed('EFFECT_RECORD_UNAVAILABLE', false); }
      if (prior) {
        if (prior.fingerprint !== p.fingerprint) return failed('EFFECT_KEY_CONFLICT');
        if (prior.state !== 'applied') return failed(prior.state === 'pending' && !this.#store ? 'EFFECT_IN_PROGRESS' : 'EFFECT_RESULT_UNKNOWN', false);
        try {
          const stored = this.receipt(prior.receipt, prior.request, 'applied');
          const output = { ...stored, status: 'already-applied' as const };
          const checked = this.contracts.check(component.outcomes[output.status]!, output);
          if (!checked.valid) return failed('OUTPUT_CONTRACT_FAILED', true, checked.issues);
          return accepted(output);
        } catch { return failed('INVALID_EFFECT_RECEIPT', false); }
      }
    }
    const operation: EffectAdapterRequest = { requestId: mode === 'apply' && this.#store ? r.key : `effect-${this.#namespace}-${++this.#sequence}`, componentId: r.componentId, target: r.target, key: r.key,
      input: clone(r.input), serviceIdentity: this.#adapter.serviceIdentity, mode };
    const entry: RecordEntry = { fingerprint: p.fingerprint, request: clone(operation), state: 'pending', receipt: null };
    if (mode === 'apply' && this.#store) {
      try {
        const content = this.durableContent(entry), reserved = await this.#store.create(r.key, content);
        if (canonical(copyJson(reserved)) !== canonical(copyJson({ key: r.key, revision: 1, content }))) return failed('INVALID_EFFECT_RESERVATION', false);
      } catch { return failed('EFFECT_RESERVATION_UNCONFIRMED', false); }
    }
    if (mode === 'apply') this.#records.set(r.key, entry);
    try { if (cancellation.requested()) return failed('CANCELLED'); } catch { return failed('CANCELLATION_CHECK_FAILED'); }
    try {
      const raw = await (mode === 'apply' ? this.#adapter.apply(clone(operation)) : this.#adapter.simulate(clone(operation)));
      const receipt = this.receipt(raw, operation, mode === 'apply' ? 'applied' : 'simulated');
      const checked = this.contracts.check(component.outcomes[receipt.status]!, receipt);
      if (!checked.valid) { entry.state = 'unknown'; return failed('OUTPUT_CONTRACT_FAILED', mode !== 'apply', checked.issues); }
      if (mode === 'apply' && this.#store) {
        const content = this.durableContent({ ...entry, state: 'applied', receipt: clone(receipt) });
        const completed = await this.#store.compareAndSwap(r.key, 1, content);
        if (canonical(copyJson(completed)) !== canonical(copyJson({ key: r.key, revision: 2, content }))) throw new DefinitionError('INVALID_EFFECT_COMMIT');
      }
      entry.state = 'applied'; entry.receipt = clone(receipt); return accepted(receipt);
    } catch { entry.state = 'unknown'; return failed(mode === 'apply' ? 'EFFECT_RESULT_UNKNOWN' : 'EFFECT_SIMULATION_FAILED', mode !== 'apply'); }
  }
}
