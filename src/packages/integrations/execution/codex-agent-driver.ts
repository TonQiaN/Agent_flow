import type { ArtifactStore, HarnessTask, FileManifest, Cancellation, InvocationPhaseSink } from '@agentflow/engine';
import { CodexAdapter, codexInputImages } from '../harness/codex.js';
import { codexSubscriptionProfile } from '../auth/codex-subscription.js';
import type { CodexSubscriptionProfile } from '../auth/codex-subscription.js';
import type { CodexSubscriptionRunner } from './codex-runner.js';
import { CredentialAgentDriver } from './credential-agent-driver.js';

export class CodexAgentDriver extends CredentialAgentDriver<CodexSubscriptionProfile> {
  constructor(runtime: CodexSubscriptionRunner, artifacts: ArtifactStore, profile: CodexSubscriptionProfile, options: { timeoutMs: number }) {
    super(runtime, artifacts, codexSubscriptionProfile(profile), options, new CodexAdapter());
  }
  override async run(task: HarnessTask, input: FileManifest, cancellation: Cancellation, phases?: InvocationPhaseSink) {
    this.validate(task);
    const images = codexInputImages(task.config);
    let bytes = 0;
    for (const path of images) {
      const file = input.files.find(file => file.path === path);
      if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mediaType) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 20 * 1024 ** 2) throw new Error('INVALID_CODEX_IMAGE_MANIFEST');
      bytes += file.bytes;
    }
    if (bytes > 64 * 1024 ** 2) throw new Error('CODEX_IMAGE_BUDGET_EXCEEDED');
    return super.run(task, input, cancellation, phases);
  }

}
