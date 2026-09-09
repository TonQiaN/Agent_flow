import { TASK_PATHS } from '@agentflow/engine';
import type { HarnessAdapter, HarnessEvidence, HarnessPlan, HarnessResult, HarnessTask } from '@agentflow/engine';
import { deepseekConfiguration, deepseekTask } from './deepseek-configuration.js';
import { DEEPSEEK_SESSION_RECORD, interpretDeepseekSession } from './deepseek-session.js';

/** Pure declarations and interpretation. The host supplies verified assets, credentials and capture bytes. */
export class DeepSeekAdapter implements HarnessAdapter {
  readonly id = 'deepseek';
  plan(raw: HarnessTask): HarnessPlan {
    const task = deepseekTask(raw), config = deepseekConfiguration(task.config);
    const patches = JSON.parse(config.configFiles[0].content);
    const asset = (name: string) => `${TASK_PATHS.config}/deepseek-policy/${name}.mjs`;
    patches.push(...['fs-sandbox', 'subprocess', 'bash-sandbox', 'sandbox-policy'].map(id => ({ id, disabled: true })), { insert: [
      { id: 'agentflow-tool-space', name: asset('tool-space') },
      { id: 'agentflow-isolated-fs', name: asset('fs-service') },
      { id: 'agentflow-isolated-process', name: asset('subprocess-service') },
      { id: 'agentflow-task-policy', name: asset('sandbox-policy') },
      { id: 'agentflow-isolated-bash', name: asset('bash-service'), config: { cwd: TASK_PATHS.work, timeoutMs: 120000 } },
      ...(task.outcomes ? [{ id: 'agentflow-outcome', name: asset('outcome-service'), config: { outcomes: task.outcomes } }] : []),
    ] });
    return { harness: this.id, version: config.version, identity: task.identity, argv: ['node', asset('launch'), '--', task.prompt], cwd: TASK_PATHS.work,
      environment: config.environment, configFiles: [{ name: 'deepseek.json', content: JSON.stringify(patches) }],
      authentication: { service: 'deepseek', method: 'api-key', variable: 'DEEPSEEK_API_KEY' },
      requirements: ['private-state', 'readonly-config', 'controlled-egress', 'deepseek-runtime-assets', 'deepseek-session-record'] };
  }
  interpret(e: HarnessEvidence): HarnessResult {
    this.plan(e.task);
    const session = e.records?.[DEEPSEEK_SESSION_RECORD.id];
    const result = interpretDeepseekSession({ ...e, session: session ?? new Uint8Array() });
    const diagnostics = new Set(result.diagnostics);
    if (!session || e.runner.capture?.stdout.bytes !== e.stdout.byteLength) diagnostics.add('RAW_CAPTURE_INCOMPLETE');
    return { ...result, status: diagnostics.size ? 'failed' : 'completed', outcome: diagnostics.size ? null : result.outcome, diagnostics: [...diagnostics] };
  }
}
