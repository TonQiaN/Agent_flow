import type { JsonValue } from '@agentflow/domain';
import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import { TASK_PATHS, snapshotJson } from '@agentflow/engine';
import type { HarnessTask } from '@agentflow/engine';

export const DEEPSEEK_VERSION = '0.1.1-rc.2';

export function deepseekTask(raw: HarnessTask): HarnessTask {
  let task: HarnessTask; try { task = snapshotJson(raw) as unknown as HarnessTask; } catch { throw new Error('INVALID_HARNESS_TASK'); }
  if (!task || !isExecutionIdentity(task.identity) || Object.keys(task.identity).sort().join(',') !== 'attemptId,attemptNumber,nodeTaskId,runId'
    || Object.keys(task).some(key => !['identity', 'prompt', 'config', 'outcomes'].includes(key))) throw new Error('INVALID_HARNESS_TASK');
  deepseekHeadlessArguments(task.prompt);
  if (task.outcomes !== undefined && (!Array.isArray(task.outcomes) || task.outcomes.length < 2 || task.outcomes.length > 32
    || !task.outcomes.every(isIdentifier) || new Set(task.outcomes).size !== task.outcomes.length)) throw new Error('INVALID_HARNESS_OUTCOMES');
  deepseekConfiguration(task.config);
  return task;
}

/** Internal configuration mapping. This alone does not provide an executable Harness. */
export function deepseekConfiguration(raw: JsonValue) {
  let config: JsonValue;
  try { config = snapshotJson(raw); } catch { throw new Error('UNSUPPORTED_DEEPSEEK_CONFIGURATION'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['model', 'reasoning', 'search', 'subagents'].includes(key))
    || typeof config['model'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(config['model'])
    || config['search'] !== false || config['subagents'] !== false
    || config['reasoning'] !== undefined && (typeof config['reasoning'] !== 'string' || !['off', 'low', 'high', 'max'].includes(config['reasoning']))) {
    throw new Error('UNSUPPORTED_DEEPSEEK_CONFIGURATION');
  }
  const patches = [
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: config['model'] } },
    { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com',
      ...(config['reasoning'] === undefined ? {} : { reasoningEffort: config['reasoning'] }) } },
    { id: 'session-persistence-jsonl', config: { root: `${TASK_PATHS.state}/deepseek/sessions`, compression: 'none', packChunks: false } },
    { id: 'tool-web', config: { search: false, fetch: false } },
    { id: 'session-title-llm', disabled: true },
    ...['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent-report',
      'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-workflow', 'workflow-worker-thread', 'tool-ralph']
      .map(id => ({ id, disabled: true })),
  ];
  return {
    version: DEEPSEEK_VERSION,
    environment: { DSH_HOME: `${TASK_PATHS.state}/deepseek`, DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native',
      NARB_DISABLE_NATIVE_CACHE: '1', NODE_USE_ENV_PROXY: '1' },
    configFiles: [{ name: 'deepseek.json', content: JSON.stringify(patches) }],
  } as const;
}

/** Both the outer launcher and the headless app parse options independently. */
export function deepseekHeadlessArguments(prompt: string): readonly string[] {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') || prompt.length > 65536) throw new Error('INVALID_HARNESS_PROMPT');
  return ['dsh', '--profile', 'headless', '--patch', `${TASK_PATHS.config}/deepseek.json`, '--', '--', prompt];
}
