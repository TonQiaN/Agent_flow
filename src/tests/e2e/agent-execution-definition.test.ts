import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentExecutor, ContractRegistry, FileContractRegistry, compileWorkflow, snapshotWorkflowExecution, assertWorkflowExecutionMatches, WorkflowRuntime } from '@agentflow/engine';
import { CodexSubscriptionRunner, CodexAgentDriver, ClaudeSubscriptionRunner, ClaudeAgentDriver, DeepSeekApiKeyRunner, DeepSeekAgentDriver,
  FileArtifactStore, FileWorkflowCatalog, FileArtifactArchive } from '@agentflow/integrations';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
for (const provider of ['codex', 'claude', 'deepseek']) test(`actual ${provider} Agent definition records installed choices without credential reads or execution`, { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-agent-definition-')); let credentialCalls = 0;
  const forbidden = async () => { credentialCalls++; throw new Error('credential access forbidden'); };
  const store = { acquire: forbidden, inspect: forbidden, configure: forbidden, delete: forbidden };
  try {
    const assets = provider === 'deepseek' ? JSON.parse(execFileSync(process.execPath, ['src/apps/deepseek-tools/export-assets.mjs'], { encoding: 'utf8' })) : null;
    function setup(change: { prompt?: string; model?: string; ref?: string; endpoint?: string; timeout?: number; image?: string; assets?: boolean } = {}) {
      const contracts = new FileContractRegistry(new ContractRegistry());
      contracts.register('files', { rules: [], maxFiles: 0, maxTotalBytes: 0, unmatched: 'reject' });
      const artifacts = new FileArtifactStore(join(root, 'artifacts'), contracts);
      const catalog = new FileWorkflowCatalog(contracts, artifacts, join(root, 'work'), new FileArtifactArchive(join(root, 'archive'), contracts));
      const options = { workspaceRoot: join(root, 'attempts'), image: change.image ?? 'node:22-bookworm-slim', proxyImage: 'node:22-bookworm-slim' };
      const profile: any = { id: 'test', service: provider === 'codex' ? 'openai' : provider === 'claude' ? 'anthropic' : 'deepseek',
        method: provider === 'deepseek' ? 'api-key' : 'subscription', credentialRef: change.ref ?? 'fixture', endpoint: change.endpoint ?? 'official', capacity: provider === 'deepseek' ? null : 1 };
      const localAssets = structuredClone(assets); if (change.assets) localAssets.files[0].content += '\n// changed deployment asset';
      const runtime: any = provider === 'codex' ? new CodexSubscriptionRunner(store, options) : provider === 'claude'
        ? new ClaudeSubscriptionRunner(store, options) : new DeepSeekApiKeyRunner(store, options, localAssets);
      const driverOptions = { timeoutMs: change.timeout ?? 30000 };
      const driver = provider === 'codex' ? new CodexAgentDriver(runtime, artifacts, profile, driverOptions) : provider === 'claude'
        ? new ClaudeAgentDriver(runtime, artifacts, profile, driverOptions) : new DeepSeekAgentDriver(runtime, artifacts, profile, driverOptions);
      const executor = new AgentExecutor(contracts, artifacts, driver);
      const config = { model: change.model ?? (provider === 'deepseek' ? 'deepseek-v4-flash' : 'fixture-model'), search: false, subagents: false,
        ...(provider === 'deepseek' ? { reasoning: 'off' } : {}) };
      catalog.registerAgent({ id: 'a', kind: 'agent', implementation: 'a', inputContract: 'files', outcomes: { done: 'files' } }, executor,
        { prompt: change.prompt ?? 'User-owned task', config });
      profile.credentialRef = 'caller-mutated'; config.model = 'caller-mutated';
      const value = { kind: 'files' as const, id: 'files' };
      const compiled = compileWorkflow({ id: 'agent', start: 'a', input: value, maxSteps: 1, outcomes: { done: value }, nodes: { a: { component: 'a' } },
        routes: [{ from: 'a', outcome: 'done', to: { end: 'done' } }] }, catalog);
      return { compiled, runtime };
    }
    const f = setup(), parallel = await Promise.all([snapshotWorkflowExecution(f.compiled), snapshotWorkflowExecution(f.compiled)]);
    assert.deepEqual(parallel[0], parallel[1]);
    const snapshot = parallel[0]!, binding = snapshot.bindings['a'] as any;
    assert.equal(binding.schema, 'agentflow-credential-execution/v2'); assert.equal(binding.profile.credentialRef, 'fixture');
    assert.equal(binding.task.prompt, 'User-owned task'); assert.equal(binding.plan.harness, provider);
    assert.match(binding.environment.options.image, /^sha256:[a-f0-9]{64}$/); assert.match(binding.environment.options.network.proxyImage, /^sha256:[a-f0-9]{64}$/);
    assert.equal(binding.versionProbe.backend.options.network, 'none'); assert.deepEqual(binding.versionProbe.argv, binding.versionCommand);
    assert.equal(binding.versionProbe.backend.options.image, binding.environment.options.image);
    if (provider === 'deepseek') {
      assert.equal(binding.environment.schema, 'agentflow-docker-execution/v3');
      assert.deepEqual(binding.environment.privateState.keys, ['DEEPSEEK_API_KEY']);
      assert.match(binding.environment.egress.proxySha256, /^[a-f0-9]{64}$/);
    }
    assert.equal(binding.environment.paths.work, '/task/work'); assert.equal(binding.timeoutMs, 30000);
    assert.ok(!JSON.stringify(snapshot).includes('caller-mutated'));
    await assertWorkflowExecutionMatches(setup().compiled, snapshot);
    for (const change of [{ prompt: 'Changed task' }, { ref: 'other' }, { timeout: 1000 }, { image: 'alpine:3' }, ...(provider !== 'deepseek' ? [{ model: 'other-model' }] : [{ assets: true }])])
      await assert.rejects(assertWorkflowExecutionMatches(setup(change).compiled, snapshot), /WORKFLOW_EXECUTION_MISMATCH/);
    assert.throws(() => setup({ endpoint: 'changed' }));
    await assert.rejects(snapshotWorkflowExecution(setup({ image: 'agentflow-test/missing-definition:does-not-exist' }).compiled));
    binding.profile.credentialRef = 'mutated-return'; assert.equal(((await snapshotWorkflowExecution(f.compiled)).bindings['a'] as any).profile.credentialRef, 'fixture');
    // Immutable Agent resources now have a real plan; invalid input still cannot start execution.
    let writes = 0; const failWrite = async () => { writes++; throw new Error('should not persist'); };
    await assert.rejects(new WorkflowRuntime().startPersisted(f.compiled, 'run', null, { create: failWrite, read: failWrite, compareAndSwap: failWrite }), provider === 'deepseek' ? /INVALID_WORKFLOW_FILE_REFERENCE/ : /RESOURCE_DEFINITION_UNAVAILABLE/);
    assert.equal(writes, 0); assert.equal(credentialCalls, 0); assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
