import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ExecutionIdentity } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
import { Runner } from '../runner/runner.js';
import type { Cancellation, CapturedFile, Clock, ExecutionBackend, RunnerResult } from '../runner/types.js';

export const SCRIPT_RESULT_SCHEMA = 'agentflow-script-result/v1';
export const SCRIPT_RESULT_MAX_BYTES = 65536;
export interface ScriptDefinition { readonly argv: readonly string[]; readonly timeoutMs: number; readonly outcomes: readonly string[] }
export interface ScriptRequest { readonly identity: ExecutionIdentity; readonly inputSource: string; readonly definition: ScriptDefinition }
/** Trusted reader for stopped, complete raw capture. Never read business output as execution proof. */
export interface ScriptRecordReader { read(file: CapturedFile, maxBytes: number): Promise<string> }
export interface ScriptEvidence { readonly identity: ExecutionIdentity; readonly imageId: string | null; readonly exitCode: 0; readonly outcome: string }
export type ScriptResult = { readonly identity: ExecutionIdentity } & (
  { readonly status: 'accepted'; readonly evidence: ScriptEvidence }
  | { readonly status: 'failed'; readonly code: string });
const clone = <T>(value: T): T => copyJson(value) as unknown as T;
const identityKey = (i: ExecutionIdentity): string => JSON.stringify([i.runId, i.nodeTaskId, i.attemptId]);
const sameIdentity = (a: ExecutionIdentity, b: ExecutionIdentity): boolean => identityKey(a) === identityKey(b) && a.attemptNumber === b.attemptNumber;
const complete = (file: CapturedFile): boolean => file.complete === true && file.truncated === false && !file.error
  && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && typeof file.path === 'string';

const utf8Length = (text: string): number => { let count = 0; for (const ch of text) { const cp = ch.codePointAt(0)!; count += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; } return count; };

/** Parse one bounded decoded envelope; the reader rejects invalid UTF-8. */
export function parseScriptResult(text: string, outcomes: readonly string[]): string {
  try {
    if (typeof text !== 'string' || !text.length || text.length > SCRIPT_RESULT_MAX_BYTES || utf8Length(text) > SCRIPT_RESULT_MAX_BYTES) throw new Error();
    const value = JSON.parse(text) as { schema?: unknown; outcome?: unknown };
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'outcome,schema'
      || value.schema !== SCRIPT_RESULT_SCHEMA || typeof value.outcome !== 'string' || !outcomes.includes(value.outcome)) throw new Error();
    // JSON.parse accepts duplicate keys. Count only structural colons, excluding escaped string content.
    let quoted = false, escaped = false, properties = 0;
    for (const ch of text) {
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true; else if (ch === ':') properties++;
    }
    if (properties !== 2) throw new Error();
    return value.outcome;
  } catch { throw new DefinitionError('INVALID_SCRIPT_RESULT'); }
}

export class ScriptAttempt {
  #facts: RunnerResult | null;
  readonly #result: ScriptResult;
  #released = false;
  constructor(result: ScriptResult, facts: RunnerResult | null, private readonly backend: ExecutionBackend) { this.#result = clone(result); this.#facts = clone(facts); }
  get result(): ScriptResult { return clone(this.#result); }
  toJSON(): ScriptResult { return this.result; }
  executionFacts(): RunnerResult | null { return clone(this.#facts); }
  stopped(): boolean {
    const f = this.#facts;
    return !!f && sameIdentity(f.identity, this.#result.identity) && (f.resource === null && f.stop === 'not_started'
      || f.stop === 'confirmed' && f.cleanup === 'removed');
  }
  async retryCleanup(): Promise<void> {
    if (this.stopped()) return;
    const f = this.#facts;
    if (!f?.resource || !sameIdentity(f.identity, this.#result.identity)) throw new DefinitionError('SCRIPT_STOP_UNCONFIRMED');
    if (!(await this.backend.stop(f.resource)).confirmed) throw new DefinitionError('SCRIPT_STOP_UNCONFIRMED');
    await this.backend.remove(f.resource); this.#facts = { ...f, stop: 'confirmed', cleanup: 'removed' };
  }
  async releaseExecution(): Promise<void> {
    if (this.#released) return;
    if (!this.stopped()) throw new DefinitionError('SCRIPT_STOP_UNCONFIRMED');
    if (this.#facts?.resource) await this.backend.release(this.#facts.resource);
    this.#released = true;
  }
}

/** One deterministic invocation. Routing and file-contract acceptance belong to its caller. */
export class ScriptExecutor {
  readonly #attempts = new Set<string>();
  readonly #runner: Runner;
  constructor(private readonly backend: ExecutionBackend, clock: Clock, private readonly reader: ScriptRecordReader) { this.#runner = new Runner(backend, clock); }
  validate(definition: ScriptDefinition): void {
    let d: ScriptDefinition;
    try { d = clone(definition); } catch { throw new DefinitionError('INVALID_SCRIPT_DEFINITION'); }
    if (!d || Object.keys(d).sort().join(',') !== 'argv,outcomes,timeoutMs' || !Array.isArray(d.argv) || !d.argv.length || d.argv.length > 128
      || d.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !d.argv[0] || d.argv.join('').length > 32768
      || !Number.isSafeInteger(d.timeoutMs) || d.timeoutMs < 1 || d.timeoutMs > 86400000 || !Array.isArray(d.outcomes)
      || !d.outcomes.length || d.outcomes.length > 32 || d.outcomes.some(id => !isIdentifier(id)) || new Set(d.outcomes).size !== d.outcomes.length) throw new DefinitionError('INVALID_SCRIPT_DEFINITION');
  }
  async execute(request: ScriptRequest, cancellation: Cancellation = { requested: () => false }): Promise<ScriptAttempt> {
    let r: ScriptRequest;
    try { r = clone(request); } catch { throw new DefinitionError('INVALID_SCRIPT_REQUEST'); }
    if (!r || Object.keys(r).sort().join(',') !== 'definition,identity,inputSource' || !isExecutionIdentity(r.identity)
      || typeof r.inputSource !== 'string' || !r.inputSource || r.inputSource.includes('\0')) throw new DefinitionError('INVALID_SCRIPT_REQUEST');
    this.validate(r.definition);
    const key = identityKey(r.identity); if (this.#attempts.has(key)) throw new DefinitionError('DUPLICATE_SCRIPT_ATTEMPT'); this.#attempts.add(key);
    let facts: RunnerResult | null = null;
    const failed = (code: string): ScriptAttempt => new ScriptAttempt({ identity: r.identity, status: 'failed', code }, facts, this.backend);
    try { facts = clone(await this.#runner.run({ identity: r.identity, inputSource: r.inputSource, invocation: { argv: r.definition.argv }, timeoutMs: r.definition.timeoutMs }, cancellation)); }
    catch { return failed('SCRIPT_START_UNCONFIRMED'); }
    if (!isExecutionIdentity(facts.identity) || !sameIdentity(facts.identity, r.identity)) return failed('SCRIPT_IDENTITY_MISMATCH');
    if (facts.phase !== 'exited' || facts.exitCode !== 0 || facts.stop !== 'confirmed' || facts.cleanup !== 'removed' || !facts.resource || facts.diagnostics.length) return failed('SCRIPT_EXECUTION_FAILED');
    const capture = facts.capture;
    if (!capture || !complete(capture.stdout) || !complete(capture.stderr) || !capture.stdout.bytes || capture.stdout.bytes > SCRIPT_RESULT_MAX_BYTES) return failed('SCRIPT_CAPTURE_INCOMPLETE');
    if (capture.imageId !== null && !/^sha256:[a-f0-9]{64}$/.test(capture.imageId)) return failed('INVALID_SCRIPT_IMAGE');
    let outcome: string;
    try {
      const text = await this.reader.read(clone(capture.stdout), SCRIPT_RESULT_MAX_BYTES);
      if (typeof text !== 'string' || utf8Length(text) !== capture.stdout.bytes) throw new Error();
      outcome = parseScriptResult(text, r.definition.outcomes);
    } catch { return failed('INVALID_SCRIPT_RESULT'); }
    return new ScriptAttempt({ identity: r.identity, status: 'accepted', evidence: { identity: r.identity, imageId: capture.imageId, exitCode: 0, outcome } }, facts, this.backend);
  }
}
