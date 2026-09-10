import { isIdentifier } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import type { HarnessAdapter } from './types.js';

export class HarnessRegistry {
  readonly #adapters = new Map<string, HarnessAdapter>();
  register(adapter: HarnessAdapter): void {
    if (!isIdentifier(adapter.id) || typeof adapter.plan !== 'function' || typeof adapter.interpret !== 'function') {
      throw new DefinitionError('INVALID_HARNESS_ADAPTER');
    }
    if (this.#adapters.has(adapter.id)) throw new DefinitionError('DUPLICATE_HARNESS_ADAPTER');
    this.#adapters.set(adapter.id, adapter);
  }
  get(id: string): HarnessAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new DefinitionError('UNKNOWN_HARNESS_ADAPTER');
    return adapter;
  }
}
