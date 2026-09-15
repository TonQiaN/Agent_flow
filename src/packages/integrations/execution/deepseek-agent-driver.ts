import type { ArtifactStore } from '@agentflow/engine';
import { DeepSeekAdapter } from '../harness/deepseek.js';
import { deepseekApiKeyProfile } from '../auth/deepseek-api-key.js';
import type { DeepSeekApiKeyProfile } from '../auth/deepseek-api-key.js';
import type { DeepSeekApiKeyRunner } from './deepseek-runner.js';
import { CredentialAgentDriver } from './credential-agent-driver.js';

export class DeepSeekAgentDriver extends CredentialAgentDriver<DeepSeekApiKeyProfile> {
  constructor(runtime: DeepSeekApiKeyRunner, artifacts: ArtifactStore, profile: DeepSeekApiKeyProfile, options: { timeoutMs: number }) {
    super(runtime, artifacts, deepseekApiKeyProfile(profile), options, new DeepSeekAdapter());
  }
}
