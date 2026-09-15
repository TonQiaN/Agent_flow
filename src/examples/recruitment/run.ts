import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WorkflowRuntime, NodeWorker, snapshotJson } from '@agentflow/engine';
import type { ArtifactStore, NodeTaskClaim, CredentialIdentity, QueueConfiguration } from '@agentflow/engine';
import { SqliteRunRecordStore, PersistentNodeQueue, systemClock, FileCredentialStore, CodexSubscriptionCodec, ClaudeSubscriptionCodec, DeepSeekApiKeyCodec, createQueueCredentialAdmission, redactView } from '@agentflow/integrations';
import { createRecruitmentFlow } from './flow.js';
import { RecruitmentFixtureDriver, fixtureCredential } from './fixture-driver.js';
import { validateInput } from './contracts.js';
import { selectGradingHarness, gradingHarness } from '../tutor-grading/selected-harness.js';

export async function runRecruitment(root: string, runId: string, input: unknown, environment = process.env) {
  validateInput(input); await mkdir(root, { recursive: true, mode: 0o700 });
  const records = await SqliteRunRecordStore.open(join(root, 'records'));
  const fixture = environment['AGENTFLOW_STUDIO_FIXTURE'] === '1';
  const harness = fixture ? 'fixture' : gradingHarness(environment['AGENTFLOW_STUDIO_HARNESS'] ?? 'deepseek');
  // A mutable image tag must not alter later nodes of an already started Run.
  environment = { ...environment };
  environment['AGENTFLOW_DOCUMENTS_IMAGE'] ??= 'agentflow/studio-documents:issue39';
  for (const key of ['AGENTFLOW_DOCUMENTS_IMAGE', ...(!fixture ? [`AGENTFLOW_${harness.toUpperCase()}_IMAGE`, 'AGENTFLOW_PROXY_IMAGE'] : [])]) {
    const image = environment[key]; if (!image) throw new Error('MISSING_RUN_IMAGE');
    environment[key] = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 10000 }).trim();
  }
  const source = new FileCredentialStore(environment['AGENTFLOW_CREDENTIAL_STORE'] ?? join(root, 'credentials'), [new CodexSubscriptionCodec(), new ClaudeSubscriptionCodec(), new DeepSeekApiKeyCodec()]);
  const events = async (event: Parameters<NonNullable<ConstructorParameters<typeof RecruitmentFixtureDriver>[3]>>[0]) => { await records.appendEvent(event.identity.runId, redactView(event)); };
  const make = async (claim?: NodeTaskClaim) => {
    const admission = claim && !fixture && claim.requirements.credential ? createQueueCredentialAdmission(source, claim) : undefined;
    const selected = fixture ? undefined : selectGradingHarness(harness as 'deepseek' | 'codex' | 'claude', { ...environment, AGENTFLOW_ACCEPTANCE_ROOT: root }, { timeoutMs: 600000, maxInputBytes: 16 * 1024 ** 2, events, persistSession: true, credentials: admission?.credentials ?? source });
    const driver = (artifacts: ArtifactStore) => fixture ? new RecruitmentFixtureDriver(artifacts, join(root, 'fixture'), claim?.token, events) : selected!.driver(artifacts, root);
    const app = await createRecruitmentFlow(root, join(root, 'uploads'), records, driver, selected?.config ?? { fixture: true }, environment['AGENTFLOW_DOCUMENTS_IMAGE'] ?? 'agentflow/studio-documents:issue39', fixture);
    return { ...app, admission: admission?.admission ?? (fixture && claim?.requirements.credential ? { acquire: async () => true, release: async () => {} } : undefined) };
  };
  try {
    const initial = await make();
    const definitions = [initial.compiled.definition, ...initial.parallel.childWorkflows().map(c => c.definition)];
    const credentials = new Map<string, { identity: CredentialIdentity; capacity: number | null }>();
    const configuration: QueueConfiguration = { roles: { coordinator: 1, compute: 2 }, credentials: [], workflows: Object.fromEntries(definitions.map(definition => [definition.id, Object.fromEntries(Object.entries(definition.nodes).map(([id, node]) => {
      const resolved = initial.parallel.resolve(node.component), binding = resolved.executor.dispatchBinding?.(resolved.component);
      if (binding) credentials.set(JSON.stringify(binding.credential), { identity: binding.credential, capacity: binding.capacity });
      return [id, { role: id === 'unit' ? 'compute' : 'coordinator', capability: 'studio', ...(binding ? { credential: binding.credential, harness: binding.harness } : {}) }];
    }))])) };
    const queue = new PersistentNodeQueue(records, { ...configuration, credentials: [...credentials.values()] });
    await new WorkflowRuntime().preparePersisted(initial.compiled, runId, snapshotJson(input), queue.records());
    const host = { open: async (id: string, store: ReturnType<typeof queue.records>, claim: NodeTaskClaim) => {
      const app = await make(claim), row = await store.read(id); if (!row) throw new Error('RUN_MISSING');
      const raw = row.content as any, workflowId = (raw.checkpoint ?? raw).snapshot.workflowId;
      const compiled = workflowId === app.compiled.definition.id ? app.compiled : app.parallel.childWorkflow(workflowId);
      if (!compiled) throw new Error('WORKFLOW_MISSING');
      return { compiled, runtime: new WorkflowRuntime(), ...(app.admission ? { admission: app.admission } : {}) };
    } };
    const workers = ['first', 'second', 'third'].map(id => new NodeWorker(queue, host, systemClock, id, ['studio'], 3000));
    let cancelled = false, previousQueue = '';
    for (;;) {
      const rows = await queue.query(), serialized = JSON.stringify(redactView(rows));
      if (serialized !== previousQueue) { await records.appendEvent(runId, { kind: 'queue', tasks: JSON.parse(serialized) }); previousQueue = serialized; }
      if (fixture && input.scenario === 'cancel' && !cancelled && rows.some(r => r.children?.length)) { await queue.cancelReady(runId); cancelled = true; }
      const raw = (await queue.records().read(runId))!.content as any, snapshot = (raw.checkpoint ?? raw).snapshot;
      if (['succeeded', 'failed', 'cancelled', 'exhausted'].includes(snapshot.status)) { await writeFile(join(root, 'result.json'), JSON.stringify(redactView(snapshot)), { mode: 0o600 }); return snapshot; }
      const outcomes = await Promise.all(workers.map(w => w.runOnce()));
      const error = outcomes.find(r => r?.error)?.error;
      if (error) { await records.appendEvent(runId, { kind: 'worker_error', error }); throw new Error(error); }
      if (outcomes.every(r => r === null)) { if (rows.some(r => r.state === 'blocked')) throw new Error('QUEUE_BLOCKED'); await new Promise(r => setTimeout(r, 300)); }
    }
  } finally { records.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2]!), input = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'));
  const result = await runRecruitment(root, process.argv[3] ?? 'recruitment-run', input);
  console.log(JSON.stringify({ status: result.status, outcome: result.outcome, reason: result.reason }));
}
