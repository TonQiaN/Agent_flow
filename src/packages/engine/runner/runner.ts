import { isExecutionIdentity } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { copyJson, canonicalJson } from '../json.js';
import type { Cancellation, Clock, ExecutionBackend, ExecutionResource, RawCapture, RunnerRequest, RunnerResult, RunnerResourceSink, RunnerResourceCheckpoint, RestoredRunnerResource } from './types.js';

export class Runner {
  constructor(private readonly backend: ExecutionBackend, private readonly clock: Clock) {}

  async run(request: RunnerRequest, cancellation: Cancellation = { requested: () => false }, persistence?: RunnerResourceSink): Promise<RunnerResult> {
    let input: RunnerRequest;
    try { input = copyJson(request) as unknown as RunnerRequest; }
    catch { throw new DefinitionError('INVALID_RUNNER_REQUEST'); }
    if (!isExecutionIdentity(input?.identity) || !Number.isSafeInteger(input.timeoutMs)
      || input.timeoutMs < 1 || input.timeoutMs > 86_400_000 || typeof input.inputSource !== 'string'
      || !input.invocation || !Array.isArray(input.invocation.argv) || input.invocation.argv.length === 0
      || input.invocation.argv.length > 128 || input.invocation.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || !input.invocation.argv[0] || input.invocation.argv.join('').length > 32_768) throw new DefinitionError('INVALID_RUNNER_REQUEST');
    const startedAt = this.clock.now();
    const deadline = startedAt + input.timeoutMs;
    let resource: ExecutionResource | null = null;
    let phase: RunnerResult['phase'] = 'failed';
    let stop: RunnerResult['stop'] = 'not_started';
    let cleanup: RunnerResult['cleanup'] = 'not_created';
    let exitCode: number | null = null;
    let capture: RawCapture | null = null;
    let stage = 'ALLOCATE';
    const diagnostics: string[] = [];
    const interruption = (): 'cancelled' | 'timed_out' | null => cancellation.requested() ? 'cancelled' : this.clock.now() >= deadline ? 'timed_out' : null;
    try {
      const initial = interruption();
      if (initial) phase = initial;
      else {
        let execution;
        if (persistence) {
          stage = 'RESOURCE_PERSISTENCE';
          if (typeof persistence.save !== 'function' || !this.backend.definition || !this.backend.snapshotResource) throw new DefinitionError('RUNNER_RESOURCE_PERSISTENCE_UNAVAILABLE');
          execution = copyJson(await this.backend.definition());
        }
        stage = 'ALLOCATE';
        resource = await this.backend.allocate();
        if (persistence) {
          stage = 'RESOURCE_PERSISTENCE';
          const backend = copyJson(await this.backend.snapshotResource!(resource, input.identity));
          await persistence.save(copyJson({ schema: 'agentflow-runner-resource/v1', identity: input.identity, resource, execution, backend }) as unknown as RunnerResourceCheckpoint);
        }
        stage = 'PREPARE';
        await this.backend.prepare(resource, input);
        let interrupted = interruption();
        if (interrupted) phase = interrupted;
        else {
          stage = 'CREATE';
          await this.backend.create(resource, input);
          interrupted = interruption();
          if (interrupted) phase = interrupted;
          else {
            stage = 'START';
            await this.backend.start(resource);
            stage = 'OBSERVE';
            for (;;) {
              const observed = await this.backend.observe(resource);
              if (observed.state === 'exited') { phase = 'exited'; exitCode = observed.exitCode; stop = 'confirmed'; break; }
              if (observed.state === 'absent') throw new Error('EXECUTION_DISAPPEARED');
              interrupted = interruption();
              if (interrupted) { phase = interrupted; break; }
              await this.clock.sleep(Math.min(25, Math.max(1, deadline - this.clock.now())));
            }
          }
        }
      }
    } catch { diagnostics.push(`${stage}_FAILED`); }
    if (resource) {
      if (stop !== 'confirmed') {
        try { stop = (await this.backend.stop(resource)).confirmed ? 'confirmed' : 'unknown'; }
        catch { stop = 'unknown'; }
        if (stop === 'unknown') diagnostics.push('STOP_UNCONFIRMED');
      }
      try { capture = await this.backend.capture(resource); }
      catch { diagnostics.push('CAPTURE_FAILED'); }
      if (stop === 'confirmed') {
        try { await this.backend.remove(resource); cleanup = 'removed'; }
        catch { cleanup = 'failed'; diagnostics.push('CLEANUP_FAILED'); }
      } else cleanup = 'blocked';
    }
    return { identity: Object.freeze(input.identity), resource, phase, exitCode, stop, capture, cleanup,
      diagnostics, startedAt, finishedAt: this.clock.now() };
  }

  /** Call only after the receiver has validated/copied outputs and retained needed raw evidence. */
  async release(resource: ExecutionResource): Promise<void> { await this.backend.release(resource); }

  /** Trusted storage facts only. The caller must fence recovery before using this handle. */
  async restore(value: RunnerResourceCheckpoint): Promise<RestoredRunnerResource> {
    let record: RunnerResourceCheckpoint;
    try { record = copyJson(value) as unknown as RunnerResourceCheckpoint; }
    catch { throw new DefinitionError('INVALID_RUNNER_RESOURCE_CHECKPOINT'); }
    if (!record || Object.keys(record).sort().join(',') !== 'backend,execution,identity,resource,schema'
      || record.schema !== 'agentflow-runner-resource/v1' || !isExecutionIdentity(record.identity)
      || Object.keys(record.identity).sort().join(',') !== 'attemptId,attemptNumber,nodeTaskId,runId'
      || !record.resource || Object.keys(record.resource).join(',') !== 'id' || typeof record.resource.id !== 'string' || !record.resource.id) throw new DefinitionError('INVALID_RUNNER_RESOURCE_CHECKPOINT');
    if (!this.backend.definition || !this.backend.restoreResource) throw new DefinitionError('RUNNER_RESOURCE_RESTORE_UNAVAILABLE');
    if (canonicalJson(copyJson(await this.backend.definition())) !== canonicalJson(record.execution)) throw new DefinitionError('RUNNER_RESOURCE_EXECUTION_MISMATCH');
    const resource = await this.backend.restoreResource(record.backend, record.identity, record.resource);
    if (canonicalJson(copyJson(resource)) !== canonicalJson(copyJson(record.resource))) throw new DefinitionError('RUNNER_RESTORED_RESOURCE_MISMATCH');
    let removed = false, released = false, closing: Promise<{ confirmed: boolean }> | null = null, releasing: Promise<void> | null = null;
    const stopAndRemove = (): Promise<{ confirmed: boolean }> => {
      if (closing) return closing;
      if (removed) return Promise.resolve({ confirmed: true });
      closing = (async () => {
        try {
          if (!(await this.backend.stop(resource)).confirmed) return { confirmed: false };
          await this.backend.remove(resource);
          if ((await this.backend.observe(resource)).state !== 'absent') return { confirmed: false };
          removed = true; return { confirmed: true };
        } catch { return { confirmed: false }; }
      })().finally(() => { closing = null; });
      return closing;
    };
    return Object.freeze({ identity: Object.freeze({ ...record.identity }), resource: Object.freeze({ ...resource }),
      query: () => this.backend.observe(resource), stopAndRemove,
      release: async () => {
        if (released) return;
        if (!removed || closing) throw new DefinitionError('RESTORED_EXECUTION_NOT_REMOVED');
        if (releasing) return releasing;
        releasing = this.backend.release(resource).then(() => { released = true; }).finally(() => { releasing = null; });
        return releasing;
      } });
  }
}
