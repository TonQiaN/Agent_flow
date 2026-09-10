import { isExecutionIdentity } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
import type { Cancellation, Clock, ExecutionBackend, ExecutionResource, RawCapture, RunnerRequest, RunnerResult } from './types.js';

export class Runner {
  constructor(private readonly backend: ExecutionBackend, private readonly clock: Clock) {}

  async run(request: RunnerRequest, cancellation: Cancellation = { requested: () => false }): Promise<RunnerResult> {
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
        resource = await this.backend.allocate();
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
}
