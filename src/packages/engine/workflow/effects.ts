import type { ComponentDefinition, ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { isIdentifier } from '@agentflow/domain';
import { consumeWorkflowValueRestore } from './restore-value.js';
import type { WorkflowValueRestoreRequest, WorkflowRestoredValue } from './restore-value.js';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
import { ComponentRegistry } from '../components/registry.js';
import { ContractRegistry } from '../contracts/registry.js';
import type { EffectApproval, EffectExecutor, EffectMode, EffectRequest, EffectResult } from '../components/effect-executor.js';
import type { Cancellation } from '../runner/types.js';
import type { WorkflowCatalog, WorkflowContract, WorkflowIssue, WorkflowNodeExecutor, WorkflowNodeResult } from './types.js';

export interface EffectWorkflowBinding {
  readonly mode?: EffectMode;
  /** Trusted application mapping. No command or expression language in Workflow JSON. */
  readonly operation: ((input: JsonValue, identity: ExecutionIdentity) => { readonly target: string; readonly key: string })
    | { readonly target: string; readonly key: string };
  /** Explicit host policy, never an automatic authorization based on model output. */
  readonly approval?: (request: EffectRequest) => EffectApproval | undefined;
}
export class EffectWorkflowCatalog implements WorkflowCatalog, WorkflowNodeExecutor {
  readonly #bindings = new Map<string, EffectWorkflowBinding>();
  constructor(private readonly contracts: ContractRegistry, private readonly components: ComponentRegistry, private readonly executor: EffectExecutor) {}
  register(componentId: string, binding: EffectWorkflowBinding): void {
    this.executor.validateComponent(componentId);
    if (this.#bindings.has(componentId)) throw new DefinitionError('DUPLICATE_EFFECT_BINDING');
    if (!binding || Object.keys(binding).some(k => !['mode', 'operation', 'approval'].includes(k)) || (typeof binding.operation !== 'function' && (!binding.operation || Object.keys(binding.operation).sort().join(',') !== 'key,target'
        || !isIdentifier(binding.operation.key) || !isIdentifier(binding.operation.target)))
      || binding.mode !== undefined && !['dry-run', 'apply'].includes(binding.mode) || binding.approval !== undefined && typeof binding.approval !== 'function'
      || binding.approval !== undefined && binding.mode !== 'apply') throw new DefinitionError('INVALID_EFFECT_BINDING');
    this.#bindings.set(componentId, Object.freeze({ mode: binding.mode ?? 'dry-run', operation: typeof binding.operation === 'function' ? binding.operation : Object.freeze(copyJson(binding.operation) as unknown as { target: string; key: string }), ...(binding.approval ? { approval: binding.approval } : {}) }));
  }
  resolve(id: string): { component: ComponentDefinition; executor: WorkflowNodeExecutor } {
    if (!this.#bindings.has(id)) throw new DefinitionError('UNKNOWN_EFFECT_BINDING');
    return { component: this.components.get(id), executor: this };
  }
  validate(component: ComponentDefinition): void {
    if (!this.#bindings.has(component.id) || JSON.stringify(this.components.get(component.id)) !== JSON.stringify(component)) throw new DefinitionError('INVALID_EFFECT_BINDING');
    this.executor.validateComponent(component.id);
  }
  contract(id: string): WorkflowContract { if (!this.contracts.has(id)) throw new DefinitionError('UNKNOWN_CONTRACT'); return { kind: 'json', id }; }
  contractDefinition(id: string): import('./structure.js').WorkflowContractDefinition {
    this.contract(id); return { kind: 'json', id, schema: this.contracts.definition(id) };
  }
  check(id: string, value: JsonValue): readonly WorkflowIssue[] {
    const result = this.contracts.check(id, value); return result.valid ? [] : result.issues.map(i => ({ contractId: i.contractId, path: i.instancePath, rule: i.schemaPath, code: i.keyword }));
  }
  private persistentBinding(componentId: string): EffectWorkflowBinding & { operation: { target: string; key: string } } {
    const binding = this.#bindings.get(componentId);
    if (!binding || typeof binding.operation === 'function' || binding.mode !== 'apply') throw new DefinitionError('EFFECT_EXECUTION_DEFINITION_UNAVAILABLE');
    return binding as EffectWorkflowBinding & { operation: { target: string; key: string } };
  }
  private persistentRequest(componentId: string, input: JsonValue, identity: ExecutionIdentity): EffectRequest {
    const binding = this.persistentBinding(componentId);
    return { componentId, identity: copyJson(identity) as unknown as ExecutionIdentity, input: copyJson(input), mode: 'apply', ...binding.operation };
  }
  async executionDefinition(component: ComponentDefinition): Promise<JsonValue> {
    this.validate(component); const binding = this.persistentBinding(component.id);
    return copyJson({ schema: 'agentflow-effect-workflow/v1', mode: 'apply', operation: binding.operation, execution: await this.executor.definitionSnapshot() });
  }
  async checkRecovery(component: ComponentDefinition, input: JsonValue, identity: ExecutionIdentity): Promise<void> {
    this.validate(component); await this.executor.checkRecovery(this.persistentRequest(component.id, input, identity));
  }
  async restoreValue(request: WorkflowValueRestoreRequest): Promise<WorkflowRestoredValue> {
    const data = consumeWorkflowValueRestore(request), expected = data.expected;
    if (!expected) throw new DefinitionError('INVALID_EFFECT_VALUE_RESTORE');
    await this.executor.validateDurableReceipt(this.persistentRequest(expected.componentId, expected.predecessor, expected.identity), expected.outcome, data.record.value);
    return Object.freeze({ value: copyJson(data.record.value), dispose: async () => {} });
  }
  async execute(component: ComponentDefinition, input: JsonValue, identity: ExecutionIdentity, cancellation: Cancellation): Promise<WorkflowNodeResult> {
    this.validate(component);
    const ownIdentity = copyJson(identity) as unknown as ExecutionIdentity, componentId = component.id;
    const failed = (code: string): WorkflowNodeResult => ({ identity: ownIdentity, componentId, status: 'failed', code, stopped: true, issues: [] });
    let request: EffectRequest, approval: EffectApproval | undefined;
    try {
      if (cancellation.requested()) return failed('CANCELLED');
      const b = this.#bindings.get(componentId)!, op = copyJson(typeof b.operation === 'function' ? b.operation(copyJson(input), copyJson(identity) as unknown as ExecutionIdentity) : b.operation) as { target: string; key: string };
      if (!op || Object.keys(op).sort().join(',') !== 'key,target') return failed('INVALID_EFFECT_OPERATION');
      request = { identity: ownIdentity, componentId, target: op.target, key: op.key, input: copyJson(input), mode: b.mode! };
      approval = b.approval?.(copyJson(request) as unknown as EffectRequest);
    } catch { return failed('EFFECT_POLICY_FAILED'); }
    let result: EffectResult;
    try { result = await this.executor.execute(request, approval, cancellation); }
    catch (error) { if (error instanceof DefinitionError) return failed(error.code); throw error; }
    if (result.status === 'accepted') return { ...result, output: copyJson(result.output) };
    return { ...result, issues: result.issues.map(i => ({ contractId: i.contractId, path: i.instancePath, rule: i.schemaPath, code: i.keyword })) };
  }
}
