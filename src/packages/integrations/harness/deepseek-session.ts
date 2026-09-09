import type { JsonValue } from '@agentflow/domain';
import { TASK_PATHS } from '@agentflow/engine';
import type { HarnessEvidence, HarnessEvent, HarnessResult, HarnessUsage } from '@agentflow/engine';
import { deepseekTask, DEEPSEEK_VERSION } from './deepseek-configuration.js';

export const DEEPSEEK_SESSION_RECORD = { id: 'deepseek_session', path: 'deepseek-session.jsonl', maxBytes: 16 * 1024 * 1024 } as const;
type Evidence = Omit<HarnessEvidence, 'stdout'> & { readonly session: Uint8Array };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && !Object.is(v, -0);
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(v);
const emptyUsage = (): HarnessUsage => ({ inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null });
// These events carry no completion authority in this fresh, single-agent interpretation.
const metadata = new Set(['agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
  'command/done', 'command/run', 'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary', 'feedback/record',
  'goal/change', 'hook/invoked', 'hook/result', 'llm/retry', 'llm/retry-started', 'permission/preset', 'plan/mode',
  'request/context', 'request/header', 'sandbox/mode', 'schedule/change', 'session/title', 'session/title-llm-request', 'todo/write']);

/** Internal pure interpreter. Only the trusted Runner record may supply session bytes; stdout is never protocol. */
export function interpretDeepseekSession(e: Evidence): HarnessResult {
  const task = deepseekTask(e.task);
  const diagnostics = new Set<string>(), events: HarnessEvent[] = []; let usage = emptyUsage(), outcome: string | null = null, auxiliaryUsage = false;
  const fail = (code: string) => { diagnostics.add(code); };
  const done = (): HarnessResult => ({ identity: task.identity, harness: 'deepseek', status: diagnostics.size ? 'failed' : 'completed', outcome: diagnostics.size ? null : outcome, usage: auxiliaryUsage ? emptyUsage() : usage, events, diagnostics: [...diagnostics] });
  const emit = (type: string, kind: HarnessEvent['kind'], data: JsonValue = null) => { if (events.length >= 100000) { fail('EVENT_LIMIT_EXCEEDED'); return; } events.push({ identity: { ...task.identity }, harness: 'deepseek', sequence: events.length, sourceType: type, kind, data }); };
  const redact = (text: string): string => { try { const safe = e.redact(text); if (typeof safe !== 'string') throw new Error(); return safe; } catch { fail('EVENT_REDACTION_FAILED'); return '[unavailable]'; } };
  if (e.version !== DEEPSEEK_VERSION) fail('UNSUPPORTED_HARNESS_VERSION');
  if (Object.keys(task.identity).some(key => task.identity[key as keyof typeof task.identity] !== e.runner.identity[key as keyof typeof task.identity])) fail('EXECUTION_IDENTITY_MISMATCH');
  if (e.runner.phase !== 'exited' || e.runner.exitCode !== 0 || e.runner.stop !== 'confirmed' || e.runner.cleanup !== 'removed') fail('RUNNER_NOT_SUCCESSFUL');
  const capture = e.runner.capture, record = capture?.files[DEEPSEEK_SESSION_RECORD.id];
  if (!capture || !record || [capture.stdout, capture.stderr, record].some(file => !file.complete || file.truncated || file.error) || record.bytes !== e.session.byteLength) fail('RAW_CAPTURE_INCOMPLETE');
  if (e.session.byteLength > DEEPSEEK_SESSION_RECORD.maxBytes) { fail('RAW_CAPTURE_TOO_LARGE'); return done(); }
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(e.session); } catch { fail('INVALID_EVENT_ENCODING'); return done(); }
  if (!text.endsWith('\n')) fail('RAW_CAPTURE_INCOMPLETE');
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines.length > 100001 || (lines[0]?.length ?? 0) > 1024 * 1024) { fail('EVENT_LIMIT_EXCEEDED'); return done(); }
  let header: unknown; try { header = JSON.parse(lines.shift() ?? ''); } catch { fail('INVALID_SESSION_HEADER'); return done(); }
  if (!object(header) || header['type'] !== 'session' || header['version'] !== 0 || !token(header['id']) || !integer(header['createdAt'])
    || header['cwd'] !== TASK_PATHS.work || header['delegationDepth'] !== 0 || ['parentSession', 'seedLength', 'origin', 'agentPreset'].some(key => key in header)) {
    fail('INVALID_SESSION_HEADER'); return done();
  }
  let activeTurn = 0, turns = 0, activeStep = 0, steps = 0, finalStop = false, messageSeen = false, finish: string | null = null, prompts = 0, messages = 0;
  let expected = new Map<string, { name: string; arguments: string }>(), running = new Set<string>(); const seenCalls = new Set<string>();
  const total: Record<keyof HarnessUsage, number | null> = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  const account = (raw: unknown) => {
    const value = parseUsage(raw);
    for (const key of Object.keys(total) as (keyof HarnessUsage)[]) {
      const next = value[key]; total[key] = next === null || total[key] === null ? null : total[key]! + next;
      if (total[key] !== null && !Number.isSafeInteger(total[key])) { fail('INVALID_HARNESS_USAGE'); total[key] = null; }
    }
    usage = { ...total };
  };
  for (const [sequence, line] of lines.entries()) {
    if (line.length > 1024 * 1024) { fail('EVENT_LIMIT_EXCEEDED'); break; }
    let event: unknown; try { event = JSON.parse(line); } catch { fail('MALFORMED_HARNESS_EVENT'); continue; }
    if (!object(event) || !token(event['type']) || event['seq'] !== sequence || !integer(event['time']) || !object(event['data'])) { fail('MALFORMED_HARNESS_EVENT'); continue; }
    const type = event['type'], data = event['data'];
    if (type === 'turn/start') {
      if (activeTurn || activeStep || data['turn'] !== turns + 1) fail('INVALID_HARNESS_EVENT_ORDER');
      activeTurn = ++turns; steps = 0; finalStop = false; emit(type, 'lifecycle');
    } else if (type === 'turn/end') {
      if (!activeTurn || activeStep || data['turn'] !== activeTurn || !steps || !finalStop) fail('INVALID_HARNESS_EVENT_ORDER');
      if (!object(data['reason']) || data['reason']['kind'] !== 'completed') fail('HARNESS_REPORTED_FAILURE');
      activeTurn = 0; emit(type, 'lifecycle');
    } else if (type === 'step/start') {
      if (!activeTurn || activeStep || data['turn'] !== activeTurn || data['step'] !== steps + 1) fail('INVALID_HARNESS_EVENT_ORDER');
      activeStep = ++steps; messageSeen = false; finish = null; finalStop = false; expected = new Map(); running = new Set(); emit(type, 'lifecycle');
    } else if (['assistant/chunk', 'assistant/message', 'tool/call', 'tool/result', 'step/end'].includes(type)) {
      if (!activeTurn || !activeStep || data['turn'] !== activeTurn || data['step'] !== activeStep) fail('INVALID_HARNESS_EVENT_ORDER');
      if (type === 'assistant/chunk') {
        const chunk = data['chunk'];
        if (!object(chunk) || typeof chunk['type'] !== 'string' || !['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'].includes(chunk['type']) || finish !== null || messageSeen) { fail('INVALID_HARNESS_EVENT_ORDER'); continue; }
        if (chunk['type'] === 'finish') {
          finish = object(chunk['reason']) && typeof chunk['reason']['kind'] === 'string' ? chunk['reason']['kind'] : 'invalid';
          if (!['stop', 'tool-calls'].includes(finish)) fail('HARNESS_REPORTED_FAILURE');
        }
      } else if (type === 'assistant/message') {
        const message = data['message'];
        if (messageSeen || finish === null || data['interrupted'] !== undefined || !object(message) || message['role'] !== 'assistant'
          || !object(message['source']) || message['source']['kind'] !== 'model' || message['source']['provider'] !== 'deepseek-official'
          || message['source']['model'] !== (task.config as Record<string, unknown>)['model'] || !Array.isArray(message['content'])) { fail('INVALID_HARNESS_MESSAGE'); continue; }
        messageSeen = true; messages++;
        try { account(data['usage']); } catch { fail('INVALID_HARNESS_USAGE'); }
        for (const block of message['content']) {
          if (!object(block)) { fail('INVALID_HARNESS_MESSAGE'); continue; }
          if (block['type'] === 'tool-call') {
            if (!token(block['id']) || !token(block['name']) || typeof block['arguments'] !== 'string' || seenCalls.has(block['id'])) fail('INVALID_TOOL_PAIRING');
            else { seenCalls.add(block['id']); expected.set(block['id'], { name: block['name'], arguments: block['arguments'] }); }
          } else if (block['type'] === 'text' || block['type'] === 'reasoning') {
            if (typeof block['text'] !== 'string') fail('INVALID_HARNESS_MESSAGE'); else emit(type, 'message', { blockType: block['type'], text: redact(block['text']) });
          } else emit(type, 'unknown');
        }
        if ((finish === 'tool-calls') !== (expected.size > 0)) fail('INVALID_TOOL_PAIRING');
      } else if (type === 'tool/call') {
        if (outcome !== null) fail('TOOL_AFTER_STRUCTURED_OUTCOME');
        const id = data['callId'], call = typeof id === 'string' ? expected.get(id) : undefined;
        if (!messageSeen || !call || call.name !== data['name'] || call.arguments !== data['arguments'] || running.has(id as string)) fail('INVALID_TOOL_PAIRING');
        else { running.add(id as string); emit(type, 'tool', { name: redact(call.name) }); }
      } else if (type === 'tool/result') {
        const message = data['message'], source = object(message) ? message['source'] : undefined;
        const id = object(source) ? source['callId'] : undefined;
        if (!object(message) || message['role'] !== 'user' || !object(source) || source['kind'] !== 'tool' || typeof id !== 'string' || !running.delete(id)
          || !Array.isArray(message['content']) || message['content'].length !== 1 || !object(message['content'][0]) || message['content'][0]['type'] !== 'tool-result' || message['content'][0]['toolCallId'] !== id || !Array.isArray(message['content'][0]['content']) || (message['content'][0]['isError'] !== undefined && typeof message['content'][0]['isError'] !== 'boolean')) fail('INVALID_TOOL_PAIRING');
        else {
          const call = expected.get(id)!;
          if (call.name === 'agentflow_outcome' && message['content'][0]['isError'] !== true) {
            const meta = data['meta']; let args: unknown; try { args = JSON.parse(call.arguments); } catch { /* Refused below. */ }
            if (outcome !== null || expected.size !== 1 || running.size !== 0 || message['content'][0]['isError'] !== false || !task.outcomes
              || !object(args) || Object.keys(args).join(',') !== 'outcome' || !object(meta) || Object.keys(meta).sort().join(',') !== 'outcome,schema'
              || meta['schema'] !== 'agentflow-outcome/v1' || typeof meta['outcome'] !== 'string' || !task.outcomes.includes(meta['outcome']) || args['outcome'] !== meta['outcome']) fail('INVALID_STRUCTURED_OUTCOME');
            else outcome = meta['outcome'];
          }
          expected.delete(id);
        }
        emit(type, 'tool');
      } else {
        if (!messageSeen || finish === null || expected.size || running.size) fail('INVALID_HARNESS_EVENT_ORDER');
        finalStop = finish === 'stop'; activeStep = 0; emit(type, 'lifecycle');
      }
    } else if (type === 'user/message') {
      if (!activeTurn || !object(data['source']) || data['role'] !== 'user' || !Array.isArray(data['content'])) fail('INVALID_HARNESS_MESSAGE');
      else if (data['source']['kind'] === 'user') {
        prompts++; if (prompts !== 1 || data['content'].length !== 1 || !object(data['content'][0]) || data['content'][0]['type'] !== 'text' || data['content'][0]['text'] !== task.prompt) fail('TASK_PROMPT_MISMATCH');
      }
    } else if (['session/title-llm-request', 'compaction/start', 'compaction/summary', 'llm/retry', 'llm/retry-started'].includes(type)) { auxiliaryUsage = true; }
    else if (metadata.has(type)) { /* The raw record owns metadata; it is not projected. */ }
    else if (/^(subagent\/|team\/|tool-workflow\/|tool\/code-|web\/)/.test(type) || type === 'session/end-seed') fail('UNSUPPORTED_HARNESS_EVENT');
    else if (event['ignorable'] === true) emit(redact(type), 'unknown');
    else fail('UNSUPPORTED_HARNESS_EVENT');
  }
  if (!turns || activeTurn || activeStep || !messages || !finalStop) fail('MISSING_HARNESS_TERMINAL');
  if (prompts !== 1) fail('TASK_PROMPT_MISMATCH');
  if (task.outcomes && outcome === null) fail('MISSING_STRUCTURED_OUTCOME');
  return done();
}

function parseUsage(raw: unknown): HarnessUsage {
  if (raw === undefined) return emptyUsage(); if (!object(raw)) throw new Error();
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens']) if (raw[key] !== undefined && !integer(raw[key])) throw new Error();
  if (!integer(raw['inputTokens']) || !integer(raw['outputTokens']) || raw['cacheWriteTokens'] !== undefined) throw new Error();
  // rc.2 subtracts reported cache reads from inputTokens; absent cache accounting leaves inputTokens as the wire total.
  const total = raw['inputTokens'] + (raw['cacheReadTokens'] as number | undefined ?? 0);
  if (!Number.isSafeInteger(total)) throw new Error();
  return { inputTokens: total, cachedInputTokens: raw['cacheReadTokens'] as number | undefined ?? null,
    outputTokens: raw['outputTokens'], reasoningOutputTokens: raw['reasoningTokens'] as number | undefined ?? null };
}
