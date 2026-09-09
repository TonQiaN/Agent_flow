import type { ComponentDefinition, ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { ComponentRegistry, FunctionRegistry } from '../components/registry.js';
import { ComponentExecutor } from '../components/executor.js';
import { ContractRegistry } from '../contracts/registry.js';
import type { Cancellation } from '../runner/types.js';
import type { WorkflowCatalog, WorkflowContract, WorkflowIssue, WorkflowNodeExecutor, WorkflowNodeResult } from './types.js';

/** Portable adapter for the existing JSON gate/transform execution path. */
export class JsonFunctionWorkflowCatalog implements WorkflowCatalog, WorkflowNodeExecutor {
  readonly #executor: ComponentExecutor;
  constructor(private readonly contracts: ContractRegistry, private readonly components: ComponentRegistry, private readonly functions: FunctionRegistry) {
    this.#executor = new ComponentExecutor(contracts, components, functions);
  }
  resolve(id: string): { component: ComponentDefinition; executor: WorkflowNodeExecutor } { return { component: this.components.get(id), executor: this }; }
  validate(component: ComponentDefinition): void {
    if (!['gate', 'transform'].includes(component.kind)) throw new DefinitionError('UNSUPPORTED_WORKFLOW_EXECUTOR');
    this.functions.get(component.implementation);
    for (const id of [component.inputContract, ...Object.values(component.outcomes)]) this.contract(id);
  }
  contract(id: string): WorkflowContract { if (!this.contracts.has(id)) throw new DefinitionError('UNKNOWN_CONTRACT'); return { kind: 'json', id }; }
  contractDefinition(id: string): import('./structure.js').WorkflowContractDefinition {
    this.contract(id); return { kind: 'json', id, schema: this.contracts.definition(id) };
  }
  check(id: string, value: JsonValue): readonly WorkflowIssue[] {
    const result = this.contracts.check(id, value); return result.valid ? [] : result.issues.map(issue => ({ contractId: issue.contractId, path: issue.instancePath, rule: issue.schemaPath, code: issue.keyword }));
  }
  async execute(component: ComponentDefinition, input: JsonValue, identity: ExecutionIdentity, cancellation: Cancellation): Promise<WorkflowNodeResult> {
    if (cancellation.requested()) return { identity, componentId: component.id, status: 'failed', code: 'CANCELLED', stopped: true, issues: [] };
    const result = await this.#executor.execute(component.id, input, identity);
    if (result.status === 'accepted') return result;
    return { ...result, stopped: true, issues: result.issues.map(issue => ({ contractId: issue.contractId, path: issue.instancePath, rule: issue.schemaPath, code: issue.keyword })) };
  }
}
