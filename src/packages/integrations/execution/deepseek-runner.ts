import { snapshotJson } from '@agentflow/engine';
import type { CredentialStore, HarnessPlan } from '@agentflow/engine';
import { DeepSeekAdapter } from '../harness/deepseek.js';
import { DEEPSEEK_VERSION } from '../harness/deepseek-configuration.js';
import { DEEPSEEK_SESSION_RECORD } from '../harness/deepseek-session.js';
import { DeepSeekCredentialRedactor, deepseekApiKeyProfile, DEEPSEEK_API_KEY_HOSTS } from '../auth/deepseek-api-key.js';
import type { DeepSeekApiKeyProfile } from '../auth/deepseek-api-key.js';
import { CredentialHarnessRunner } from './credential-runner.js';
import type { CredentialRunRequest, CredentialExecutionResult } from './credential-runner.js';
export { CredentialExecution as DeepSeekExecution } from './credential-runner.js';
export type DeepSeekRunRequest = CredentialRunRequest<DeepSeekApiKeyProfile>;
export type DeepSeekExecutionResult = CredentialExecutionResult;
export interface DeepSeekRuntimeAssets {
  readonly schema: 'agentflow-deepseek-assets/v1'; readonly version: typeof DEEPSEEK_VERSION; readonly files: HarnessPlan['configFiles'];
}
const assetNames = ['sdk', 'fs-worker', 'fs-service', 'tool-isolate', 'tool-space', 'process-policy', 'process-sdk', 'subprocess-service',
  'bash-service', 'sandbox-policy', 'session-capture', 'launch', 'outcome-service'].map(name => `deepseek-policy/${name}.mjs`);

/** Assets are an explicit trusted deployment input, separate from host options and Workflow task JSON. */
export class DeepSeekApiKeyRunner extends CredentialHarnessRunner<DeepSeekApiKeyProfile> {
  constructor(store: CredentialStore, options: { workspaceRoot: string; image: string; proxyImage: string }, rawAssets: DeepSeekRuntimeAssets) {
    let assets: DeepSeekRuntimeAssets;
    try { assets = snapshotJson(rawAssets) as unknown as DeepSeekRuntimeAssets; } catch { throw new Error('INVALID_DEEPSEEK_ASSETS'); }
    if (!assets || Object.keys(assets).sort().join(',') !== 'files,schema,version' || assets.schema !== 'agentflow-deepseek-assets/v1' || assets.version !== DEEPSEEK_VERSION
      || !Array.isArray(assets.files) || assets.files.length !== assetNames.length || new Set(assets.files.map(file => file?.name)).size !== assetNames.length
      || assets.files.some(file => !file || Object.keys(file).sort().join(',') !== 'content,name' || !assetNames.includes(file.name)
        || typeof file.content !== 'string' || !file.content || file.content.includes('\0') || Buffer.byteLength(file.content) > 65536)) throw new Error('INVALID_DEEPSEEK_ASSETS');
    super(store, options, {
      binding: 'snapshot', memoryMiB: 1024,
      version: DEEPSEEK_VERSION, hosts: DEEPSEEK_API_KEY_HOSTS, stateFile: 'deepseek-api-key.json', versionCommand: ['dsh', '--version'],
      adapter: () => new DeepSeekAdapter(), profile: deepseekApiKeyProfile, redactor: () => new DeepSeekCredentialRedactor(),
      parseVersion: stdout => /^([0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+)\s*$/.exec(stdout)?.[1] ?? null,
      stateEnvironment: () => ({}),
      invocation: plan => ({ argv: plan.argv, configFiles: [...plan.configFiles, ...assets.files], recordFiles: [DEEPSEEK_SESSION_RECORD] }),
    });
  }
}
