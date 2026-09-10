import type { CredentialStore } from '@agentflow/engine';
import { CodexAdapter, CODEX_VERSION } from '../harness/codex.js';
import { CODEX_SUBSCRIPTION_HOSTS, CodexCredentialRedactor, codexSubscriptionProfile } from '../auth/codex-subscription.js';
import type { CodexSubscriptionProfile } from '../auth/codex-subscription.js';
import { CredentialHarnessRunner } from './credential-runner.js';
import type { CredentialRunRequest, CredentialExecutionResult } from './credential-runner.js';
export { CredentialExecution as CodexExecution } from './credential-runner.js';
export type CodexRunRequest = CredentialRunRequest<CodexSubscriptionProfile>;
export type CodexExecutionResult = CredentialExecutionResult;

export class CodexSubscriptionRunner extends CredentialHarnessRunner<CodexSubscriptionProfile> {
  constructor(store: CredentialStore, options: { workspaceRoot: string; image: string; proxyImage: string; maxInputBytes?: number }) {
    super(store, options, {
      binding: 'exclusive',
      resourceEnvironment: { CODEX_HOME: '/task/state/codex' },
      version: CODEX_VERSION, hosts: CODEX_SUBSCRIPTION_HOSTS, stateFile: 'codex/auth.json', versionCommand: ['codex', '--version'],
      adapter: () => new CodexAdapter(), profile: codexSubscriptionProfile, redactor: () => new CodexCredentialRedactor(),
      parseVersion: stdout => /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(stdout)?.[1] ?? null,
      stateEnvironment: plan => plan.environment, invocation: plan => ({ argv: plan.argv, configFiles: plan.configFiles }),
    });
  }
}
