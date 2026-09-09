import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import { TASK_PATHS, snapshotJson } from '@agentflow/engine';
import type { HarnessAdapter, HarnessEvidence, HarnessEvent, HarnessPlan, HarnessResult, HarnessTask, HarnessUsage } from '@agentflow/engine';

export const CLAUDE_VERSION = '2.1.226';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const unknownUsage = (): HarnessUsage => ({ inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null });
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : object(v)
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);

/** Pure Claude mapping and protocol interpretation. Execution and credentials remain host responsibilities. */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude';
  plan(raw: HarnessTask): HarnessPlan {
    let task: HarnessTask; try { task = snapshotJson(raw) as unknown as HarnessTask; } catch { throw new Error('INVALID_HARNESS_TASK'); }
    if (!task || !isExecutionIdentity(task.identity) || Object.keys(task.identity).sort().join(',') !== 'attemptId,attemptNumber,nodeTaskId,runId' || Object.keys(task).some(k => !['identity', 'prompt', 'config', 'outcomes'].includes(k))
      || typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.includes('\0') || task.prompt.length > 65536) throw new Error('INVALID_HARNESS_TASK');
    const c = task.config;
    if (!object(c) || Object.keys(c).some(k => !['model', 'reasoning', 'subagents', 'search'].includes(k)) || !token(c['model']) || !/^[A-Za-z0-9]/.test(c['model']) || c['subagents'] !== false || c['search'] !== false
      || c['reasoning'] !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(c['reasoning']))) throw new Error('UNSUPPORTED_CLAUDE_CONFIGURATION');
    if (task.outcomes !== undefined && (!Array.isArray(task.outcomes) || task.outcomes.length < 2 || task.outcomes.length > 32
      || !task.outcomes.every(isIdentifier) || new Set(task.outcomes).size !== task.outcomes.length)) throw new Error('INVALID_HARNESS_OUTCOMES');
    const home = `${TASK_PATHS.state}/claude`, settings = `${TASK_PATHS.config}/claude-managed.json`, tools = 'Bash,Read,Write,Edit,Glob,Grep';
    const policy = { forceLoginMethod: 'claudeai', permissions: { deny: [
      ...['Read', 'Edit'].map(tool => `${tool}(/${TASK_PATHS.state}/**)`), `Edit(/${TASK_PATHS.config}/**)`, 'Agent', 'WebSearch', 'WebFetch',
    ] }, sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, enableWeakerNestedSandbox: true,
      filesystem: { allowRead: [TASK_PATHS.input, TASK_PATHS.work, TASK_PATHS.outputs], allowWrite: [TASK_PATHS.input, TASK_PATHS.work, TASK_PATHS.outputs, '/tmp'],
        denyRead: [TASK_PATHS.state], denyWrite: [TASK_PATHS.state, TASK_PATHS.config] }, network: { allowedDomains: [], allowManagedDomainsOnly: true } } };
    const argv = ['claude', '--print', '--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
      '--tools', tools, '--allowedTools', tools, '--output-format', 'stream-json', '--verbose', '--model', c['model']];
    if (c['reasoning'] !== undefined) argv.push('--effort', String(c['reasoning']));
    if (task.outcomes) argv.push('--json-schema', JSON.stringify({ type: 'object', properties: { outcome: { type: 'string', enum: task.outcomes } }, required: ['outcome'], additionalProperties: false }));
    argv.push('--', task.prompt);
    return { harness: this.id, version: CLAUDE_VERSION, identity: task.identity, argv, cwd: TASK_PATHS.work,
      environment: { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_MANAGED_SETTINGS_PATH: settings, CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
      configFiles: [{ name: 'claude-managed.json', content: JSON.stringify(policy) }], authentication: { service: 'anthropic', method: 'subscription', file: `${home}/.credentials.json` },
      requirements: ['private-state', 'readonly-config', 'subscription-refresh-lease', 'controlled-egress', 'claude-managed-policy'] };
  }
  interpret(e: HarnessEvidence): HarnessResult {
    const task = snapshotJson(e.task) as unknown as HarnessTask; this.plan(task);
    const identity = task.identity, events: HarnessEvent[] = [], diagnostics = new Set<string>(); let usage = unknownUsage(), outcome: string | null = null;
    let session: string | null = null, terminal: string | null = null;
    const fail = (code: string): void => { diagnostics.add(code); };
    const done = (): HarnessResult => ({ identity, harness: this.id, status: diagnostics.size ? 'failed' : 'completed', outcome: diagnostics.size ? null : outcome, usage, events, diagnostics: [...diagnostics] });
    const redact = (text: string): string => { try { const safe = e.redact(text); if (typeof safe !== 'string') throw new Error(); return safe; } catch { fail('EVENT_REDACTION_FAILED'); return '[unavailable]'; } };
    const emit = (sourceType: string, kind: HarnessEvent['kind'], data: JsonValue): void => {
      if (events.length >= 100000) { fail('EVENT_LIMIT_EXCEEDED'); return; }
      events.push({ identity: { ...identity }, harness: this.id, sequence: events.length, sourceType: redact(sourceType), kind, data });
    };
    if (e.version !== CLAUDE_VERSION) fail('UNSUPPORTED_HARNESS_VERSION');
    if (stable(e.runner.identity) !== stable(identity)) fail('EXECUTION_IDENTITY_MISMATCH');
    if (e.runner.phase !== 'exited' || e.runner.exitCode !== 0 || e.runner.stop !== 'confirmed' || e.runner.cleanup !== 'removed') fail('RUNNER_NOT_SUCCESSFUL');
    const capture = e.runner.capture;
    if (!capture || [capture.stdout, capture.stderr].some(s => !s.complete || s.truncated || s.error) || capture.stdout.bytes !== e.stdout.byteLength) fail('RAW_CAPTURE_INCOMPLETE');
    if (e.stdout.byteLength > 16 * 1024 * 1024) { fail('RAW_CAPTURE_TOO_LARGE'); return done(); }
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(e.stdout); } catch { fail('INVALID_EVENT_ENCODING'); return done(); }
    let lines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (++lines > 100000 || line.length > 1024 * 1024) { fail('EVENT_LIMIT_EXCEEDED'); break; }
      let value: unknown; try { value = JSON.parse(line); } catch { fail('MALFORMED_HARNESS_EVENT'); continue; }
      if (!object(value) || !token(value['type'])) { fail('MALFORMED_HARNESS_EVENT'); continue; }
      const type = value['type'];
      if (type === 'result') {
        let signature: string; try { signature = stable(value); } catch { fail('MALFORMED_HARNESS_EVENT'); continue; }
        if (terminal !== null) { if (terminal !== signature) fail('CONFLICTING_HARNESS_TERMINAL'); continue; } terminal = signature;
        if (!session || value['session_id'] !== session) fail('HARNESS_SESSION_MISMATCH');
        if (value['parent_tool_use_id'] != null) fail('UNEXPECTED_SUBAGENT_EVENT');
        try { usage = parseUsage(value['usage']); } catch { fail('INVALID_HARNESS_USAGE'); }
        if (value['subtype'] !== 'success' || value['is_error'] !== false) { fail('HARNESS_REPORTED_FAILURE'); emit(type, 'error', null); continue; }
        if (typeof value['result'] !== 'string' && value['structured_output'] === undefined) fail('MALFORMED_HARNESS_RESULT');
        if (task.outcomes) {
          const output = value['structured_output'];
          if (!object(output) || Object.keys(output).join(',') !== 'outcome' || typeof output['outcome'] !== 'string' || !task.outcomes.includes(output['outcome'])) fail('INVALID_STRUCTURED_OUTCOME');
          else outcome = output['outcome'];
        }
        emit(type, 'usage', { ...usage }); continue;
      }
      if (terminal !== null) fail('EVENT_AFTER_HARNESS_TERMINAL');
      if (type === 'system' && value['subtype'] === 'init') {
        if (session !== null || !token(value['session_id'])) fail('INVALID_HARNESS_EVENT_ORDER'); else session = value['session_id'];
        emit('system.init', 'lifecycle', null); continue;
      }
      if (value['session_id'] !== undefined && value['session_id'] !== session) fail('HARNESS_SESSION_MISMATCH');
      if (value['parent_tool_use_id'] != null) fail('UNEXPECTED_SUBAGENT_EVENT');
      if (type === 'assistant' || type === 'user') {
        if (!session || value['session_id'] !== session) fail('INVALID_HARNESS_EVENT_ORDER');
        const message = value['message'];
        if (!object(message) || !Array.isArray(message['content'])) { fail('MALFORMED_HARNESS_MESSAGE'); continue; }
        for (const block of message['content']) {
          if (!object(block) || !token(block['type'])) { fail('MALFORMED_HARNESS_MESSAGE'); continue; }
          if (block['type'] === 'text' || block['type'] === 'thinking') {
            const content = block[block['type']]; if (typeof content !== 'string') fail('MALFORMED_HARNESS_MESSAGE');
            else emit(type, 'message', { blockType: block['type'], text: redact(content) });
          } else if (block['type'] === 'tool_use') {
            if (!token(block['name']) || !token(block['id'])) fail('MALFORMED_HARNESS_MESSAGE');
            else emit(type, 'tool', { name: redact(block['name']), id: redact(block['id']) });
          } else if (block['type'] === 'tool_result') {
            if (!token(block['tool_use_id'])) fail('MALFORMED_HARNESS_MESSAGE'); else emit(type, 'tool', { id: redact(block['tool_use_id']) });
          }
          else emit(type, 'unknown', null);
        }
      } else emit(type, 'unknown', null);
    }
    if (terminal === null) fail('MISSING_HARNESS_TERMINAL'); return done();
  }
}

function parseUsage(raw: unknown): HarnessUsage {
  if (raw == null) return unknownUsage(); if (!object(raw)) throw new Error();
  const read = (name: string): number | null => { const v = raw[name]; if (v == null) return null; if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(); return v as number; };
  const input = read('input_tokens'), cached = read('cache_read_input_tokens'), created = read('cache_creation_input_tokens');
  const total = input === null || cached === null || created === null ? null : input + cached + created;
  if (total !== null && !Number.isSafeInteger(total)) throw new Error();
  return { inputTokens: total, cachedInputTokens: cached, outputTokens: read('output_tokens'), reasoningOutputTokens: null };
}
