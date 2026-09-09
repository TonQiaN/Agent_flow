import type { CredentialStore } from '@agentflow/engine';
import { ClaudeAdapter, CLAUDE_VERSION } from '../harness/claude.js';
import { CLAUDE_SUBSCRIPTION_HOSTS, ClaudeCredentialRedactor, claudeSubscriptionProfile } from '../auth/claude-subscription.js';
import type { ClaudeSubscriptionProfile } from '../auth/claude-subscription.js';
import { SubscriptionHarnessRunner } from './subscription-runner.js';
import type { SubscriptionRunRequest, SubscriptionExecutionResult } from './subscription-runner.js';
export { SubscriptionExecution as ClaudeExecution } from './subscription-runner.js';
export type ClaudeRunRequest = SubscriptionRunRequest<ClaudeSubscriptionProfile>;
export type ClaudeExecutionResult = SubscriptionExecutionResult;

export class ClaudeSubscriptionRunner extends SubscriptionHarnessRunner<ClaudeSubscriptionProfile> {
  constructor(store: CredentialStore, options: { workspaceRoot: string; image: string; proxyImage: string }) {
    super(store, options, {
      systemConfigMounts: [{ name: 'claude-managed.json', target: '/etc/claude-code/managed-settings.json' }],
      version: CLAUDE_VERSION, hosts: CLAUDE_SUBSCRIPTION_HOSTS, stateFile: 'claude/.credentials.json', versionCommand: ['claude', '--version'],
      adapter: () => new ClaudeAdapter(), profile: claudeSubscriptionProfile, redactor: () => new ClaudeCredentialRedactor(),
      parseVersion: stdout => /^([0-9]+\.[0-9]+\.[0-9]+) \(Claude Code\)\s*$/.exec(stdout)?.[1] ?? null,
      stateEnvironment: plan => ({ CLAUDE_CONFIG_DIR: plan.environment['CLAUDE_CONFIG_DIR']! }),
      // Fixed non-secret switches use separate argv elements. No shell parsing or arbitrary task environment.
      invocation: plan => ({ argv: ['/usr/bin/env', ...Object.entries(plan.environment).filter(([key]) => key !== 'CLAUDE_CONFIG_DIR').map(([key, value]) => `${key}=${value}`), ...plan.argv], configFiles: plan.configFiles }),
    });
  }
}
