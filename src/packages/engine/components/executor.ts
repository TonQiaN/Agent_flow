import { isExecutionIdentity } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { ContractRegistry } from '../contracts/registry.js';
import type { ContractIssue } from '../contracts/registry.js';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
import { ComponentRegistry, FunctionRegistry } from './registry.js';

export type ExecutionFailureCode = 'INVALID_INPUT' | 'IMPLEMENTATION_FAILED' | 'INVALID_RESULT' | 'UNDECLARED_OUTCOME' | 'INVALID_OUTPUT';
export type ExecutionResult = {
  readonly identity: Readonly<ExecutionIdentity>;
  readonly componentId: string;
} & ({ readonly status: 'accepted'; readonly outcome: string; readonly output: JsonValue }
  | { readonly status: 'failed'; readonly code: ExecutionFailureCode; readonly issues: readonly ContractIssue[] });

/** Coordinates one invocation. It neither allocates attempts nor routes the workflow. */
export class ComponentExecutor {
  constructor(
    private readonly contracts: ContractRegistry,
    private readonly components: ComponentRegistry,
    private readonly functions: FunctionRegistry,
  ) {}

  async execute(componentId: string, input: unknown, identity: ExecutionIdentity): Promise<ExecutionResult> {
    // Resolve before invoking user code. Definition errors are not execution outcomes.
    if (!isExecutionIdentity(identity)) throw new DefinitionError('INVALID_EXECUTION_IDENTITY');
    const definition = this.components.get(componentId);
    if (definition.kind !== 'gate' && definition.kind !== 'transform') throw new DefinitionError('UNSUPPORTED_EXECUTION_KIND');
    const implementation = this.functions.get(definition.implementation);
    const capturedIdentity: ExecutionIdentity = Object.freeze({ runId: identity.runId, nodeTaskId: identity.nodeTaskId,
      attemptId: identity.attemptId, attemptNumber: identity.attemptNumber });
    const base = { identity: capturedIdentity, componentId };
    const failed = (code: ExecutionFailureCode, issues: readonly ContractIssue[] = []): ExecutionResult => ({ ...base, status: 'failed', code, issues });
    let privateInput: JsonValue;
    try { privateInput = copyJson(input); }
    catch { return failed('INVALID_INPUT'); }
    const inputCheck = this.contracts.check(definition.inputContract, privateInput);
    if (!inputCheck.valid) return failed('INVALID_INPUT', inputCheck.issues);
    let raw: unknown;
    try { raw = await implementation(privateInput, capturedIdentity); }
    catch { return failed('IMPLEMENTATION_FAILED'); }
    let result: JsonValue;
    try { result = copyJson(raw); }
    catch { return failed('INVALID_RESULT'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).length !== 2 || typeof result['outcome'] !== 'string' || !Object.hasOwn(result, 'output')) return failed('INVALID_RESULT');
    const outcome = result['outcome'];
    if (!Object.hasOwn(definition.outcomes, outcome)) return failed('UNDECLARED_OUTCOME');
    const output = result['output']!;
    const outputCheck = this.contracts.check(definition.outcomes[outcome]!, output);
    if (!outputCheck.valid) return failed('INVALID_OUTPUT', outputCheck.issues);
    return { ...base, status: 'accepted', outcome, output };
  }
}
