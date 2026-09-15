import { isIdentifier } from '@agentflow/domain';
import type { ComponentDefinition, ComponentResult, ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { ContractRegistry } from '../contracts/registry.js';
import { copyJson } from '../json.js';

/** Trusted application code. Sandbox execution is a separate integration. */
export type ComponentFunction = (input: JsonValue, identity: Readonly<ExecutionIdentity>) => ComponentResult | Promise<ComponentResult>;

/** Installed trusted pure code. Bump revision when code or dependency behavior changes.
 * No IO, external mutable state, time, randomness, or detached writers are permitted.
 * This contract is an installation attestation, not a sandbox or purity proof. */
export interface DeterministicFunctionImplementation {
  readonly revision: string;
  readonly run: (input: JsonValue, config: JsonValue) => ComponentResult | Promise<ComponentResult>;
}

export class FunctionRegistry {
  readonly #functions = new Map<string, ComponentFunction>();
  readonly #definitions = new Map<string, JsonValue>();

  registerDeterministic(id: string, implementation: DeterministicFunctionImplementation, config: JsonValue = null): void {
    const revision = implementation?.revision, run = implementation?.run;
    if (typeof revision !== 'string' || !revision.trim() || revision.length > 256 || /[\u0000-\u001f\u007f]/.test(revision)
      || typeof run !== 'function') throw new DefinitionError('INVALID_DETERMINISTIC_IMPLEMENTATION');
    let settings: JsonValue;
    try { settings = copyJson(config); } catch { throw new DefinitionError('INVALID_DETERMINISTIC_CONFIG'); }
    // Capture code and configuration together. Never hydrate code from a saved definition.
    this.register(id, input => run(input, copyJson(settings)));
    this.#definitions.set(id, { schema: 'agentflow-deterministic-function/v1', implementation: id, revision, config: settings, recovery: 'recompute' });
  }

  definition(id: string): JsonValue {
    this.get(id);
    const definition = this.#definitions.get(id);
    if (!definition) throw new DefinitionError('FUNCTION_EXECUTION_DEFINITION_UNAVAILABLE');
    return copyJson(definition);
  }

  register(id: string, implementation: ComponentFunction): void {
    if (!isIdentifier(id) || typeof implementation !== 'function') throw new DefinitionError('INVALID_IMPLEMENTATION');
    if (this.#functions.has(id)) throw new DefinitionError('DUPLICATE_IMPLEMENTATION');
    this.#functions.set(id, implementation);
  }

  get(id: string): ComponentFunction {
    const implementation = this.#functions.get(id);
    if (!implementation) throw new DefinitionError('UNKNOWN_IMPLEMENTATION');
    return implementation;
  }
}

export class ComponentRegistry {
  readonly #definitions = new Map<string, ComponentDefinition>();
  constructor(private readonly contracts: ContractRegistry) {}

  register(definition: ComponentDefinition): void {
    let snapshot: ComponentDefinition;
    try { snapshot = copyJson(definition) as unknown as ComponentDefinition; }
    catch { throw new DefinitionError('INVALID_COMPONENT'); }
    if (!snapshot || !isIdentifier(snapshot.id) || !isIdentifier(snapshot.implementation)
      || !['agent', 'gate', 'transform', 'effect'].includes(snapshot.kind)
      || !isIdentifier(snapshot.inputContract) || !snapshot.outcomes || Array.isArray(snapshot.outcomes)
      || typeof snapshot.outcomes !== 'object' || Object.keys(snapshot.outcomes).length === 0
      || Object.entries(snapshot.outcomes).some(([outcome, contract]) => !isIdentifier(outcome) || !isIdentifier(contract))) {
      throw new DefinitionError('INVALID_COMPONENT');
    }
    if (this.#definitions.has(snapshot.id)) throw new DefinitionError('DUPLICATE_COMPONENT');
    for (const contract of [snapshot.inputContract, ...Object.values(snapshot.outcomes)]) {
      if (!this.contracts.has(contract)) throw new DefinitionError('UNKNOWN_CONTRACT');
    }
    Object.freeze(snapshot.outcomes);
    this.#definitions.set(snapshot.id, Object.freeze(snapshot));
  }

  get(id: string): ComponentDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) throw new DefinitionError('UNKNOWN_COMPONENT');
    return definition;
  }
}
