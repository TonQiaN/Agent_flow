import type { ArtifactStore } from '@agentflow/engine';
import { ClaudeAdapter } from '../harness/claude.js';
import { claudeSubscriptionProfile } from '../auth/claude-subscription.js';
import type { ClaudeSubscriptionProfile } from '../auth/claude-subscription.js';
import type { ClaudeSubscriptionRunner } from './claude-runner.js';
import { CredentialAgentDriver } from './credential-agent-driver.js';

export class ClaudeAgentDriver extends CredentialAgentDriver<ClaudeSubscriptionProfile> {
  constructor(runtime: ClaudeSubscriptionRunner, artifacts: ArtifactStore, profile: ClaudeSubscriptionProfile, options: { inputRoot: string; timeoutMs: number }) {
    super(runtime, artifacts, claudeSubscriptionProfile(profile), options, new ClaudeAdapter());
  }
}
