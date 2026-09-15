import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction, AnySchema } from 'ajv';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';

export interface ContractIssue {
  readonly contractId: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
}
export type ContractCheck = { readonly valid: true } | { readonly valid: false; readonly issues: readonly ContractIssue[] };

// Schema traversal follows schema positions only: defaults/examples may contain literal $ref keys.
function checkReferences(schema: JsonValue): void {
  if (typeof schema === 'boolean') return;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('INVALID_SCHEMA');
  for (const key of ['$ref', '$dynamicRef']) {
    const ref = schema[key];
    if (ref !== undefined && (typeof ref !== 'string' || !ref.startsWith('#'))) throw new Error('EXTERNAL_SCHEMA_REFERENCE');
  }
  if (schema['$async'] !== undefined) throw new Error('ASYNC_SCHEMA_UNSUPPORTED');
  for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) {
    const map = schema[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) Object.values(map).forEach(checkReferences);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const list = schema[key];
    if (Array.isArray(list)) list.forEach(checkReferences);
  }
  for (const key of ['not', 'if', 'then', 'else', 'items', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contentSchema']) {
    if (schema[key] !== undefined) checkReferences(schema[key]);
  }
}

export class ContractRegistry {
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #definitions = new Map<string, JsonValue>();

  register(id: string, schema: unknown): void {
    if (!isIdentifier(id)) throw new DefinitionError('INVALID_CONTRACT_ID');
    if (this.#validators.has(id)) throw new DefinitionError('DUPLICATE_CONTRACT');
    try {
      const snapshot = copyJson(schema);
      checkReferences(snapshot);
      const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true, ownProperties: true });
      // CommonJS export exposes this typed function under Node ESM interop.
      addFormatsModule.default(ajv);
      const definition = copyJson(snapshot);
      const validate = ajv.compile(snapshot as AnySchema);
      this.#validators.set(id, validate);
      this.#definitions.set(id, definition);
    } catch {
      throw new DefinitionError('INVALID_CONTRACT_SCHEMA');
    }
  }

  has(id: string): boolean { return this.#validators.has(id); }

  definition(id: string): JsonValue {
    if (!this.#definitions.has(id)) throw new DefinitionError('UNKNOWN_CONTRACT');
    return copyJson(this.#definitions.get(id));
  }

  check(id: string, value: unknown): ContractCheck {
    const validate = this.#validators.get(id);
    if (!validate) throw new DefinitionError('UNKNOWN_CONTRACT');
    let snapshot: JsonValue;
    try { snapshot = copyJson(value); }
    catch { return { valid: false, issues: [{ contractId: id, instancePath: '', schemaPath: '', keyword: 'json' }] }; }
    if (validate(snapshot)) return { valid: true };
    return { valid: false, issues: (validate.errors ?? []).map(error => ({
      contractId: id, instancePath: error.instancePath, schemaPath: error.schemaPath, keyword: error.keyword,
    })) };
  }
}
