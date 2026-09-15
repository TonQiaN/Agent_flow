import { TASK_PATHS } from '@agentflow/engine';
import type { ExecutionResource } from '@agentflow/engine';

/** Trusted host capability, passed separately from JSON options and task invocations. */
export interface PrivateStateBinding {
  readonly environment: Readonly<Record<string, string>>;
  prepare(resource: ExecutionResource, stateDirectory: string): Promise<void>;
  beforeRelease(resource: ExecutionResource): Promise<void>;
  /** Trusted transport only. Values must never enter invocation JSON, argv or ordinary logs. */
  secretEnvironment?(resource: ExecutionResource): Readonly<Record<string, string>>;
}

export function stateEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16
    || Object.entries(value).some(([key, path]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key)
      || /^(HOME|PATH|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|LANG|LC_ALL|TZ)$/.test(key) || key.startsWith('AGENTFLOW_')
      || typeof path !== 'string' || path.length > 256 || !path.startsWith(`${TASK_PATHS.state}/`)
      || !path.slice(TASK_PATHS.state.length + 1).split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)))) throw new Error('INVALID_STATE_ENVIRONMENT');
  return Object.freeze({ ...value });
}

/** Separate credential channel; cannot override process configuration, proxies or task paths. */
export function credentialEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16
    || Object.entries(value).some(([key, secret]) => !/^[A-Z][A-Z0-9_]{0,55}_(?:API_KEY|TOKEN)$/.test(key)
      || key.startsWith('AGENTFLOW_') || typeof secret !== 'string' || !/^[\x21-\x7e]{8,8192}$/.test(secret))) throw new Error('INVALID_CREDENTIAL_ENVIRONMENT');
  return Object.freeze({ ...value });
}
