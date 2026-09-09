import type { ArtifactStore } from '@agentflow/engine';
import { CodexAdapter } from '../harness/codex.js';
import { codexSubscriptionProfile } from '../auth/codex-subscription.js';
import type { CodexSubscriptionProfile } from '../auth/codex-subscription.js';
import type { CodexSubscriptionRunner } from './codex-runner.js';
import { CredentialAgentDriver } from './credential-agent-driver.js';

export class CodexAgentDriver extends CredentialAgentDriver<CodexSubscriptionProfile> {
  constructor(runtime: CodexSubscriptionRunner, artifacts: ArtifactStore, profile: CodexSubscriptionProfile, options: { inputRoot: string; timeoutMs: number }) {
    super(runtime, artifacts, codexSubscriptionProfile(profile), options, new CodexAdapter());
  }
}
