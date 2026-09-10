import type { InvocationResourcePlan, InvocationPhaseSink, InvocationPhaseHandle, RunnerResourceCheckpoint, RestoredRunnerResource } from '@agentflow/engine';
import type { JsonValue } from '@agentflow/domain';
import { ArtifactError } from '@agentflow/engine';
import type { CredentialIdentity, HarnessAdapter, AgentExecutionDriver, AgentExecutionFacts, AgentExecutionHandle, ArtifactStore, Cancellation, FileManifest, HarnessTask } from '@agentflow/engine';
import type { CredentialHarnessRunner } from './credential-runner.js';
import type { CredentialExecution } from './credential-runner.js';

/** Composition bridge: provider/auth details stay outside the portable acceptance engine. */
export class CredentialAgentDriver<P extends CredentialIdentity> implements AgentExecutionDriver {
  readonly harness: string;
  readonly #profile: P;
  readonly #options: { timeoutMs: number };
  constructor(private readonly runtime: CredentialHarnessRunner<P>, private readonly artifacts: ArtifactStore,
    profile: P, options: { timeoutMs: number }, private readonly adapter: HarnessAdapter) {
    this.#profile = Object.freeze(structuredClone(profile)); this.harness = adapter.id;
    if (!options || Object.keys(options).sort().join(',') !== 'timeoutMs'
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000) throw new Error('INVALID_SUBSCRIPTION_DRIVER');
    this.#options = Object.freeze({ ...options });
  }
  dispatchBinding() { return this.runtime.dispatchBinding(this.#profile); }
  validate(task: HarnessTask): void { this.adapter.plan(task); }
  async definitionSnapshot(task: HarnessTask): Promise<JsonValue> {
    this.validate(task);
    return this.runtime.definitionSnapshot(task, this.#profile, this.#options.timeoutMs);
  }
  async resourcePlan(task: HarnessTask): Promise<InvocationResourcePlan | null> {
    this.validate(task);
    let execution: JsonValue;
    try { execution = await this.runtime.executionResourceDefinition(this.#profile); }
    catch (error) { if (error instanceof Error && error.message === 'CREDENTIAL_RESOURCE_RESTORE_UNAVAILABLE') return null; throw error; }
    const probe = await this.runtime.versionProbeDefinition() as { backend: JsonValue };
    return { schema: 'agentflow-invocation-resources/v1', phases: [
      { id: 'version', kind: 'resource', execution: probe.backend },
      ...(this.runtime.credentialAcquisitionIsResourceOwned() ? [] : [{ id: 'credential', kind: 'operation' as const }]),
      { id: 'execution', kind: 'resource', execution } ] };
  }
  async restorePhaseResource(task: HarnessTask, phase: string, record: RunnerResourceCheckpoint): Promise<RestoredRunnerResource> {
    this.validate(task);
    if (phase === 'version') return this.runtime.restoreVersionResource({ schema: 'agentflow-credential-version-resource/v1', definition: await this.runtime.versionProbeDefinition(), runner: record });
    if (phase === 'execution') return this.runtime.restoreExecutionResource(record, this.#profile);
    throw new Error('INVALID_AGENT_RESOURCE_PHASE');
  }
  async receiptDefinition(task: HarnessTask): Promise<{ harness: string; version: string; imageId: string }> {
    const definition = await this.definitionSnapshot(task) as { version: string; environment: { options: { image: string } } };
    return { harness: this.harness, version: definition.version, imageId: definition.environment.options.image };
  }
  async run(task: HarnessTask, input: FileManifest, cancellation: Cancellation, phases?: InvocationPhaseSink): Promise<AgentExecutionHandle> {
    this.validate(task);
    if (phases && !await this.resourcePlan(task)) throw new Error('CREDENTIAL_RESOURCE_RESTORE_UNAVAILABLE');
    const version = await phases?.enter('version');
    let acquisition: InvocationPhaseHandle | undefined, executionPhase: InvocationPhaseHandle | undefined;
    let execution: CredentialExecution;
    try {
      const snapshotId = input.id;
      execution = await this.runtime.run({ task, profile: this.#profile, inputSource: null, timeoutMs: this.#options.timeoutMs }, cancellation, phases ? {
        version: { save: record => version!.resource!.save(record.runner), launch: state => version!.resource!.launch!(state), complete: () => version!.complete() },
        ...(this.runtime.credentialAcquisitionIsResourceOwned() ? {} : { acquisition: { enter: async () => { acquisition = await phases.enter('credential'); }, complete: async () => { await acquisition!.complete(); } } }),
        execution: { save: async record => { executionPhase = await phases.enter('execution'); await executionPhase.resource!.save(record); },
          launch: state => executionPhase!.resource!.launch!(state) },
      } : undefined, { materialize: destination => this.artifacts.materialize(snapshotId, destination) });
    } catch (error) { if (error instanceof ArtifactError) throw error; throw new Error('SUBSCRIPTION_AGENT_START_FAILED'); }
    return new CredentialAgentHandle(execution, executionPhase);
  }
}

class CredentialAgentHandle implements AgentExecutionHandle {
  constructor(private readonly execution: CredentialExecution, private phase?: InvocationPhaseHandle) {}
  get facts(): AgentExecutionFacts {
    const result = this.execution.result;
    return { runner: result.runner, harness: result.harness, version: result.version.actual,
      finalized: result.stage === 'execution' && result.authentication?.status === 'released'
        && (result.authentication.refresh === 'unchanged' || result.authentication.refresh === 'updated'),
      diagnostics: result.diagnostics };
  }
  // Cleanup retries cannot publish a completion through an ended invocation or upgrade its result.
  async retryCleanup(): Promise<void> { await this.execution.retryCleanup(); this.phase = undefined; }
  async release(): Promise<void> { await this.execution.release(); if (this.phase) { await this.phase.complete(); this.phase = undefined; } }
}
