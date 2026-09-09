import type { CredentialStore } from '@agentflow/engine';
import { CodexAdapter, CODEX_VERSION } from '../harness/codex.js';
import { CODEX_SUBSCRIPTION_HOSTS, CodexCredentialRedactor, codexSubscriptionProfile } from '../auth/codex-subscription.js';
import type { CodexSubscriptionProfile } from '../auth/codex-subscription.js';
import { SubscriptionHarnessRunner } from './subscription-runner.js';
import type { SubscriptionRunRequest, SubscriptionExecutionResult } from './subscription-runner.js';
export { SubscriptionExecution as CodexExecution } from './subscription-runner.js';
export type CodexRunRequest = SubscriptionRunRequest<CodexSubscriptionProfile>;
export type CodexExecutionResult = SubscriptionExecutionResult;

export class CodexSubscriptionRunner extends SubscriptionHarnessRunner<CodexSubscriptionProfile> {
  constructor(store: CredentialStore, options: { workspaceRoot: string; image: string; proxyImage: string }) {
    super(store, options, {
      version: CODEX_VERSION, hosts: CODEX_SUBSCRIPTION_HOSTS, stateFile: 'codex/auth.json', versionCommand: ['codex', '--version'],
      adapter: () => new CodexAdapter(), profile: codexSubscriptionProfile, redactor: () => new CodexCredentialRedactor(),
      parseVersion: stdout => /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(stdout)?.[1] ?? null,
      stateEnvironment: plan => plan.environment, invocation: plan => ({ argv: plan.argv, configFiles: plan.configFiles }),
    });
  }
}
