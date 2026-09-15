import { EFFECT_RECEIPT_SCHEMA } from '@agentflow/engine';
import type { EffectAdapter, EffectAdapterRequest, EffectReceipt } from '@agentflow/engine';
import type { JsonValue } from '@agentflow/domain';
import { isIdentifier } from '@agentflow/domain';

/** In-memory target for acceptance tests and local previews; no external service or persistence. */
export class SimulatedEffectService {
  readonly #secret: string;
  readonly #values = new Map<string, { identity: string; value: JsonValue }>();
  #writes = 0;
  constructor(secret: string) { if (typeof secret !== 'string' || !secret) throw new Error('INVALID_SIMULATED_CREDENTIAL'); this.#secret = secret; }
  get writes(): number { return this.#writes; }
  read(target: string): { identity: string; value: JsonValue } | null { return structuredClone(this.#values.get(target) ?? null); }
  /** A separate business credential is captured privately; no Harness credential is accepted here. */
  connect(implementation: string, serviceIdentity: string, credential?: string): EffectAdapter {
    if (!isIdentifier(implementation) || !isIdentifier(serviceIdentity)) throw new Error('INVALID_SIMULATED_CONNECTION');
    const receipt = (r: EffectAdapterRequest, status: 'simulated' | 'applied', reference: string | null): EffectReceipt => ({ schema: EFFECT_RECEIPT_SCHEMA,
      requestId: r.requestId, componentId: r.componentId, mode: r.mode, target: r.target, key: r.key, serviceIdentity, status, reference });
    return Object.freeze({ implementation, serviceIdentity,
      definition: async () => ({ schema: 'agentflow-simulated-effect-service/v1' }),
      simulate: async (r: EffectAdapterRequest): Promise<EffectReceipt> => {
        if (r.mode !== 'dry-run' || r.serviceIdentity !== serviceIdentity) throw new Error('INVALID_SIMULATED_CONTEXT');
        return receipt(r, 'simulated', null);
      },
      apply: async (r: EffectAdapterRequest): Promise<EffectReceipt> => {
        if (credential !== this.#secret) throw new Error('SIMULATED_CREDENTIAL_REJECTED');
        if (r.mode !== 'apply' || r.serviceIdentity !== serviceIdentity) throw new Error('INVALID_SIMULATED_CONTEXT');
        this.#values.set(r.target, { identity: serviceIdentity, value: structuredClone(r.input) }); this.#writes++;
        return receipt(r, 'applied', `record-${this.#writes}`);
      },
    });
  }
}
