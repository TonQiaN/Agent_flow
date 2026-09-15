import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentExecutionDriver, ArtifactStore } from '@agentflow/engine';
import { isIdentifier } from '@agentflow/domain';
import {
  CodexAdapter, ClaudeAdapter, DeepSeekAdapter, FileCredentialStore,
  CodexSubscriptionCodec, ClaudeSubscriptionCodec, DeepSeekApiKeyCodec,
  CodexSubscriptionRunner, ClaudeSubscriptionRunner, DeepSeekApiKeyRunner,
  CodexAgentDriver, ClaudeAgentDriver, DeepSeekAgentDriver,
} from '@agentflow/integrations';
import type { DeepSeekRuntimeAssets } from '@agentflow/integrations';

export type GradingHarness = 'codex' | 'claude' | 'deepseek';
export function gradingHarness(value: unknown): GradingHarness {
  if (value !== 'codex' && value !== 'claude' && value !== 'deepseek') throw new Error('INVALID_ACCEPTANCE_HARNESS');
  return value;
}

/** Consumer composition only: the Workflow, contracts and Gate never select a provider. */
export function selectGradingHarness(raw: GradingHarness, environment: NodeJS.ProcessEnv) {
  const harness = gradingHarness(raw);
  const required = (name: string): string => {
    const value = environment[name]; if (!value || value.includes('\0')) throw new Error('MISSING_GRADING_CONFIGURATION'); return value;
  };
  const path = (name: string): string => { const value = required(name); if (!isAbsolute(value)) throw new Error('INVALID_GRADING_PATH'); return value; };
  const acceptanceRoot = path('AGENTFLOW_ACCEPTANCE_ROOT'), storeRoot = path('AGENTFLOW_CREDENTIAL_STORE');
  const credentialRef = required('AGENTFLOW_CREDENTIAL_REF');
  if (!isIdentifier(credentialRef)) throw new Error('INVALID_GRADING_REFERENCE');
  const prefix = harness.toUpperCase(), image = required(`AGENTFLOW_${prefix}_IMAGE`), proxyImage = required('AGENTFLOW_PROXY_IMAGE');
  const config = { model: required(`AGENTFLOW_${prefix}_MODEL`), reasoning: harness === 'deepseek' ? 'off' : 'low', subagents: false, search: false };
  const adapter = harness === 'codex' ? new CodexAdapter() : harness === 'claude' ? new ClaudeAdapter() : new DeepSeekAdapter();
  const plan = adapter.plan({ identity: { runId: 'preflight', nodeTaskId: 'preflight', attemptId: 'preflight', attemptNumber: 1 }, prompt: 'Validate configuration only.', config });
  // Fixed trusted deployment exporter, not a task-selected file or shell command. No credential access.
  const assets: DeepSeekRuntimeAssets | undefined = harness === 'deepseek'
    ? JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../apps/deepseek-tools/export-assets.mjs', import.meta.url))], { encoding: 'utf8', maxBuffer: 1024 * 1024 })) : undefined;
  const store = new FileCredentialStore(storeRoot, [new CodexSubscriptionCodec(), new ClaudeSubscriptionCodec(), new DeepSeekApiKeyCodec()]);
  const options = (root: string) => ({ workspaceRoot: join(root, 'attempts'), image, proxyImage });
  const driver = (artifacts: ArtifactStore, root: string): AgentExecutionDriver => {
    const execution = { inputRoot: join(root, 'driver-inputs'), timeoutMs: 180_000 };
    const common = { id: 'tutor-acceptance', credentialRef, endpoint: 'official' as const };
    if (harness === 'codex') return new CodexAgentDriver(new CodexSubscriptionRunner(store, options(root)), artifacts,
      { ...common, service: 'openai', method: 'subscription', capacity: 1 }, execution);
    if (harness === 'claude') return new ClaudeAgentDriver(new ClaudeSubscriptionRunner(store, options(root)), artifacts,
      { ...common, service: 'anthropic', method: 'subscription', capacity: 1 }, execution);
    return new DeepSeekAgentDriver(new DeepSeekApiKeyRunner(store, options(root), assets!), artifacts,
      { ...common, service: 'deepseek', method: 'api-key', capacity: null }, execution);
  };
  return { acceptanceRoot, config, driver, preflight: {
    harness, expectedVersion: plan.version, image, proxyImage, model: config.model,
    authentication: plan.authentication.method, endpoint: 'official', fixtureMaterial: true,
    harnessInvocationsPerNode: 1, timeoutPerNodeMs: 180_000, maximumAgentNodes: 4,
    validated: 'configuration-only', imageInspected: false, credentialsRead: false, networkCalled: false,
  } };
}
