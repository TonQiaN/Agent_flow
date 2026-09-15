import type { JsonValue } from '@agentflow/domain';

/** Strict JSON snapshot: never silently drop properties or coerce non-JSON values. */
export function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new Error('INVALID_JSON');
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error('INVALID_JSON');
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) throw new Error('INVALID_JSON');
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('INVALID_JSON');
        result.push(copyJson(descriptor.value, ancestors));
      }
      return result;
    }
    const result: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('INVALID_JSON');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('INVALID_JSON');
      Object.defineProperty(result, key, {
        value: copyJson(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Deterministic comparison encoding; call after strict JSON snapshotting. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
}
