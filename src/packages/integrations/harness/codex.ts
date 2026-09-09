import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { TASK_PATHS } from '@agentflow/engine';
import type { HarnessAdapter, HarnessEvidence, HarnessEvent, HarnessPlan, HarnessResult, HarnessTask, HarnessUsage } from '@agentflow/engine';

export const CODEX_VERSION = '0.153.4';
const unknownUsage = (): HarnessUsage => ({ inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_.:-]/.test(value);
const identityOf = (identity: ExecutionIdentity): ExecutionIdentity => Object.freeze({ runId: identity.runId, nodeTaskId: identity.nodeTaskId, attemptId: identity.attemptId, attemptNumber: identity.attemptNumber });
const sameIdentity = (a: ExecutionIdentity, b: ExecutionIdentity): boolean => a.runId === b.runId && a.nodeTaskId === b.nodeTaskId && a.attemptId === b.attemptId && a.attemptNumber === b.attemptNumber;

/** Pure mapping/parsing. No process, filesystem, authentication store or contract dependency. */
export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex';

  plan(task: HarnessTask): HarnessPlan {
    if (!isExecutionIdentity(task.identity) || typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.includes('\0')
      || task.prompt.length > 64 * 1024 || Object.keys(task).some(key => !['identity', 'prompt', 'config', 'outcomes'].includes(key))) throw new Error('INVALID_HARNESS_TASK');
    const config = task.config;
    if (!record(config) || Object.keys(config).some(key => !['model', 'reasoning', 'subagents', 'search'].includes(key))
      || !validToken(config['model']) || config['subagents'] !== false || config['search'] !== false
      || config['reasoning'] !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(String(config['reasoning']))) throw new Error('UNSUPPORTED_CODEX_CONFIGURATION');
    if (task.outcomes !== undefined && (!Array.isArray(task.outcomes) || task.outcomes.length < 2 || task.outcomes.length > 32
      || !Array.from(task.outcomes).every(isIdentifier) || new Set(task.outcomes).size !== task.outcomes.length)) throw new Error('INVALID_HARNESS_OUTCOMES');
    const home = `${TASK_PATHS.state}/codex`;
    const argv = ['codex', 'exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral',
      '--skip-git-repo-check', '--color', 'never', '--cd', TASK_PATHS.work, '--model', config['model']];
    // These TOML values are generated from fixed paths and validated scalars, never arbitrary task config.
    const settings = ['approval_policy="never"', 'cli_auth_credentials_store="file"', 'features.multi_agent=false', 'web_search="disabled"',
      'default_permissions="agentflow"', 'permissions.agentflow.extends=":workspace"', 'permissions.agentflow.network.enabled=false',
      `permissions.agentflow.filesystem={ ${JSON.stringify(TASK_PATHS.input)}="write", ${JSON.stringify(TASK_PATHS.outputs)}="write", ${JSON.stringify(`${home}/auth.json`)}="deny", ${JSON.stringify(`${home}/profile.json`)}="deny", ${JSON.stringify(TASK_PATHS.config)}="read" }`];
    if (config['reasoning'] !== undefined) settings.push(`model_reasoning_effort=${JSON.stringify(config['reasoning'])}`);
    for (const setting of settings) argv.push('-c', setting);
    const configFiles: { name: string; content: string }[] = [];
    if (task.outcomes) {
      configFiles.push({ name: 'outcome.schema.json', content: JSON.stringify({ type: 'object', properties: { outcome: { type: 'string', enum: [...task.outcomes] } }, required: ['outcome'], additionalProperties: false }) });
      argv.push('--output-schema', `${TASK_PATHS.config}/outcome.schema.json`);
    }
    // The separator prevents a user-owned prompt beginning with '-' from becoming an option.
    argv.push('--', task.prompt);
    return { harness: this.id, version: CODEX_VERSION, identity: identityOf(task.identity), argv: Object.freeze(argv), cwd: TASK_PATHS.work,
      environment: Object.freeze({ CODEX_HOME: home }), configFiles,
      authentication: { service: 'openai', method: 'subscription', file: `${home}/auth.json` },
      requirements: ['private-state', 'readonly-config', 'subscription-refresh-lease', 'controlled-egress', 'codex-tool-sandbox'] };
  }

  interpret(evidence: HarnessEvidence): HarnessResult {
    this.plan(evidence.task); // Unknown configuration is rejected on both entry points.
    const { task, runner } = evidence;
    const identity = identityOf(task.identity);
    const events: HarnessEvent[] = [];
    const diagnostics = new Set<string>();
    let usage = unknownUsage();
    let outcome: string | null = null;
    let terminal: string | null = null;
    let terminalCompleted = false;
    let finalMessage: string | null = null;
    let threadStarted = false;
    let turnStarted = false;
    const fail = (code: string): void => { diagnostics.add(code); };
    const result = (): HarnessResult => ({ identity, harness: this.id, status: diagnostics.size === 0 ? 'completed' : 'failed',
      outcome: diagnostics.size === 0 ? outcome : null, usage, events, diagnostics: [...diagnostics] });
    if (evidence.version !== CODEX_VERSION) fail('UNSUPPORTED_HARNESS_VERSION');
    if (!sameIdentity(identity, runner.identity)) fail('EXECUTION_IDENTITY_MISMATCH');
    if (runner.phase !== 'exited' || runner.exitCode !== 0 || runner.stop !== 'confirmed') fail('RUNNER_NOT_SUCCESSFUL');
    const capture = runner.capture;
    if (!capture || !capture.stdout.complete || capture.stdout.truncated || capture.stdout.error
      || !capture.stderr.complete || capture.stderr.truncated || capture.stderr.error
      || capture.stdout.bytes !== evidence.stdout.byteLength) fail('RAW_CAPTURE_INCOMPLETE');
    if (evidence.stdout.byteLength > 16 * 1024 * 1024) { fail('RAW_CAPTURE_TOO_LARGE'); return result(); }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(evidence.stdout); }
    catch { fail('INVALID_EVENT_ENCODING'); return result(); }
    const emit = (type: string, kind: HarnessEvent['kind'], data: JsonValue, itemId?: string): void => {
      events.push({ identity, harness: this.id, sequence: events.length, sourceType: redact(type), kind, data, ...(itemId === undefined ? {} : { itemId: redact(itemId) }) });
    };
    const redact = (value: string): string => {
      try {
        const safe = evidence.redact(value);
        if (typeof safe !== 'string') throw new Error();
        return safe;
      } catch { fail('EVENT_REDACTION_FAILED'); return '[unavailable]'; }
    };
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (events.length >= 100_000 || line.length > 1024 * 1024) { fail('EVENT_LIMIT_EXCEEDED'); break; }
      let event: unknown;
      try { event = JSON.parse(line); } catch { fail('MALFORMED_HARNESS_EVENT'); continue; }
      if (!record(event) || !validToken(event['type'])) { fail('MALFORMED_HARNESS_EVENT'); continue; }
      const type = event['type'];
      // Repeated identical terminal receipts are idempotent; conflicting ones never replace an accepted receipt.
      if (type === 'turn.completed' || type === 'turn.failed') {
        let signature: string;
        try { signature = stable(event); } catch { fail('MALFORMED_HARNESS_EVENT'); continue; }
        if (terminal !== null) { if (terminal !== signature) fail('CONFLICTING_HARNESS_TERMINAL'); continue; }
        terminal = signature;
        if (!threadStarted || !turnStarted) fail('INVALID_HARNESS_EVENT_ORDER');
        if (type === 'turn.failed') {
          fail('HARNESS_REPORTED_FAILURE');
          emit(type, 'error', null);
          continue;
        }
        terminalCompleted = true;
        try { usage = parseUsage(event['usage']); } catch { fail('INVALID_HARNESS_USAGE'); }
        emit(type, 'usage', { ...usage });
        continue;
      }
      if (terminal !== null) fail('EVENT_AFTER_HARNESS_TERMINAL');
      if (type === 'error') {
        fail('HARNESS_REPORTED_FAILURE');
        emit(type, 'error', null); // Raw error objects may include request headers and credential values.
      } else if (type === 'thread.started') {
        if (threadStarted || turnStarted || !validToken(event['thread_id'])) fail('INVALID_HARNESS_EVENT_ORDER');
        threadStarted = true;
        emit(type, 'lifecycle', null);
      } else if (type === 'turn.started') {
        if (!threadStarted || turnStarted) fail('INVALID_HARNESS_EVENT_ORDER');
        turnStarted = true;
        emit(type, 'lifecycle', null);
      } else if (['item.started', 'item.updated', 'item.completed'].includes(type)) {
        const item = event['item'];
        if (!record(item) || !validToken(item['type']) || !validToken(item['id'])) { fail('MALFORMED_HARNESS_ITEM'); continue; }
        const itemType = item['type'];
        // Codex emits initialization warnings as completed error items before turn.started.
        const initializationWarning = threadStarted && type === 'item.completed' && itemType === 'error';
        if (!turnStarted && !initializationWarning) fail('INVALID_HARNESS_EVENT_ORDER');
        if (itemType === 'error') {
          emit(type, 'error', null, item['id']);
          continue;
        }
        const data: Record<string, JsonValue> = { itemType: redact(itemType) };
        let kind: HarnessEvent['kind'] = 'unknown';
        if (['agent_message', 'reasoning'].includes(itemType)) {
          kind = 'message';
          if (typeof item['text'] !== 'string') { fail('MALFORMED_HARNESS_ITEM'); continue; }
          data['text'] = redact(item['text']);
          if (type === 'item.completed' && itemType === 'agent_message') finalMessage = item['text'];
        } else if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list'].includes(itemType)) {
          kind = 'tool';
          for (const key of ['command', 'aggregated_output', 'status', 'server', 'tool', 'query']) {
            if (typeof item[key] === 'string') data[key] = redact(item[key]);
          }
          if (Number.isSafeInteger(item['exit_code'])) data['exitCode'] = item['exit_code'] as number;
          // Unknown nested objects are deliberately not copied into ordinary events.
        }
        emit(type, kind, data, item['id']);
      } else {
        // Preserve an unknown event's source type, but don't interpret it as success or expose its payload.
        emit(type, 'unknown', null);
      }
    }
    if (terminal === null) fail('MISSING_HARNESS_TERMINAL');
    if (task.outcomes && terminalCompleted) {
      try {
        const answer: unknown = JSON.parse(finalMessage ?? 'null');
        if (!record(answer) || Object.keys(answer).length !== 1 || typeof answer['outcome'] !== 'string'
          || !task.outcomes.includes(answer['outcome'])) throw new Error();
        outcome = answer['outcome'];
      } catch { fail('INVALID_STRUCTURED_OUTCOME'); }
    }
    return result();
  }
}

function parseUsage(raw: unknown): HarnessUsage {
  if (raw === undefined || raw === null) return unknownUsage();
  if (!record(raw)) throw new Error();
  const token = (key: string): number | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error();
    return value as number;
  };
  const usage = { inputTokens: token('input_tokens'), cachedInputTokens: token('cached_input_tokens'), outputTokens: token('output_tokens'), reasoningOutputTokens: token('reasoning_output_tokens') };
  if (usage.inputTokens !== null && usage.cachedInputTokens !== null && usage.cachedInputTokens > usage.inputTokens) throw new Error();
  return usage;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
