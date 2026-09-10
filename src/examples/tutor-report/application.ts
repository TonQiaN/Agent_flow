import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentExecutor, ContractRegistry, FileContractRegistry, WorkflowRuntime, compileWorkflow } from '@agentflow/engine';
import type { AgentExecutionDriver, ArtifactStore, FileManifest, WorkflowSnapshot } from '@agentflow/engine';
import type { JsonValue } from '@agentflow/domain';
import { FileArtifactStore, FileWorkflowCatalog } from '@agentflow/integrations';
import type { FileFunctionContext } from '@agentflow/integrations';

export interface ReportContext {
  readonly reportId: string;
  readonly title: string;
  readonly studentName: string;
  readonly courseName: string;
  readonly assessmentName: string;
  readonly examYear: number;
  readonly authority: string;
  readonly jurisdiction: string;
}
export interface TutorReportSetup<D extends AgentExecutionDriver> {
  /** Explicit installed code and interpreter. Never taken from a report or Agent output. */
  readonly tutorWorkspace: string;
  readonly python: string;
  readonly context: ReportContext;
  readonly source: string;
  readonly reporter: { readonly id: string; readonly prompt: string; readonly config: JsonValue };
  readonly driver: (artifacts: ArtifactStore) => D;
  readonly toolTimeoutMs?: number;
}
const toolchain = fileURLToPath(new URL('./toolchain.py', import.meta.url));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function contracts() {
  const json = new ContractRegistry();
  json.register('tutor-object', { type: 'object' });
  json.register('report-gate', { type: 'object', properties: { decision: { enum: ['passed', 'rejected'] }, code: { type: ['string', 'null'] }, reportHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['decision', 'code', 'reportHash'], additionalProperties: false });
  const files = new FileContractRegistry(json);
  const file = (id: string, path: string, schema = 'tutor-object') => ({ id, kind: 'file' as const, match: path, minCount: 1, maxCount: 1, maxBytes: 16 * 1024 ** 2, mediaTypes: ['application/json'], jsonContract: schema });
  const tree = (id: string) => ({ id, kind: 'tree' as const, match: id, minCount: 1, maxCount: 1, minFiles: 1, maxFiles: 1000, maxBytes: 128 * 1024 ** 2,
    mediaTypes: ['application/json', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'text/plain', 'text/markdown', 'text/x-python', 'application/octet-stream'] });
  const initial = [tree('source'), ...['assessment-reference', 'submission-mapping', 'marking-candidate'].map(id => file(id, `candidate/${id}.json`))];
  const prepared = [...initial, tree('report-source')], reported = [...prepared, file('report', 'report-candidate.json')];
  const checked = [...reported, file('gate', 'report-gate.json', 'report-gate')];
  for (const [id, rules] of [['tutor-marked', initial], ['tutor-report-input', prepared], ['tutor-reported', reported], ['tutor-checked', checked],
    ['tutor-rendered', [...checked, file('render-manifest', 'render-manifest.json'), { id: 'pdf', kind: 'file', match: 'report.pdf', minCount: 1, maxCount: 1, maxBytes: 128 * 1024 ** 2, mediaTypes: ['application/pdf'] }]]] as const) {
    files.register(id, { rules, maxFiles: 2100, maxTotalBytes: 768 * 1024 ** 2, unmatched: 'reject' });
  }
  return files;
}

/** Installed host function. Cancellation waits for process close before returning. */
async function invoke(python: string, workspace: string, operation: string, ctx: FileFunctionContext, config: ReportContext, timeout: number) {
  const configFile = join(ctx.workPath, 'report-context.json');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  return new Promise<{ outcome: string }>((accept, reject) => {
    const child = spawn(python, [toolchain, operation, '--workspace', workspace, '--input', ctx.inputPath, '--output', ctx.outputsPath, '--config', configFile],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' } });
    let stdout = '', exceeded = false, cancelled = false;
    const stop = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); } };
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 65536) { exceeded = true; stop(); } });
    // Avoid returning student content in tool errors. The gate emits stable codes.
    child.stderr.resume();
    const deadline = setTimeout(() => { exceeded = true; stop(); }, timeout);
    const cancellation = setInterval(() => { if (ctx.cancellation.requested()) { cancelled = true; stop(); } }, 25);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(deadline); clearInterval(cancellation);
      if (code !== 0 || exceeded || cancelled) { reject(new Error(cancelled ? 'TUTOR_TOOL_CANCELLED' : exceeded ? 'TUTOR_TOOL_LIMIT' : 'TUTOR_TOOL_FAILED')); return; }
      try {
        const result = JSON.parse(stdout);
        if (Object.keys(result).join(',') !== 'outcome' || !['completed', 'passed', 'rejected'].includes(result.outcome)) throw new Error('TUTOR_TOOL_PROTOCOL');
        accept(result);
      } catch { reject(new Error('TUTOR_TOOL_PROTOCOL')); }
    });
  });
}

/** Tutor-specific application. No core imports of Tutor code, schemas or PDF libraries. */
export async function createTutorReportApplication<D extends AgentExecutionDriver>(root: string, setup: TutorReportSetup<D>) {
  const context = structuredClone(setup.context), reporter = structuredClone(setup.reporter), workspace = resolve(setup.tutorWorkspace), python = resolve(setup.python);
  const timeout = setup.toolTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000 || ['prepare', 'report-gate', 'render'].includes(reporter.id)) throw new Error('INVALID_TUTOR_REPORT_SETUP');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const registered = contracts(), store = new FileArtifactStore(join(root, 'artifacts'), registered), files = new FileWorkflowCatalog(registered, store, join(root, 'nodes'));
  const driver = setup.driver(store), agents = new AgentExecutor(registered, store, driver), runtime = new WorkflowRuntime();
  const originals = new Map<string, FileManifest>(), prepared = new Map<string, FileManifest>();
  const component = (id: string, kind: 'transform' | 'gate' | 'agent', inputContract: string, outcomes: Record<string, string>) => ({ id, kind, implementation: id, inputContract, outcomes });
  const verify = async (ctx: FileFunctionContext, manifest: FileManifest) => {
    // Protect the full source/candidate/prepared tree, including added files.
    const last = runtime.query(ctx.identity.runId).lastAccepted?.result;
    if (last?.status === 'accepted') {
      const current = files.inspect(last.output, ctx.identity.runId).manifest;
      const protectedFile = (path: string) => ['source/', 'candidate/', 'report-source/'].some(prefix => path.startsWith(prefix));
      const names = (value: FileManifest) => value.files.filter(file => protectedFile(file.path)).map(file => file.path).sort().join('\n');
      if (names(current) !== names(manifest)) throw new Error('TUTOR_SOURCE_CHANGED');
    }
    for (const file of manifest.files) if (hash(await readFile(join(ctx.inputPath, file.path))) !== file.sha256) throw new Error('TUTOR_SOURCE_CHANGED');
  };
  files.registerFunction(component('prepare', 'transform', 'tutor-marked', { completed: 'tutor-report-input' }), async ctx => {
    await verify(ctx, originals.get(ctx.identity.runId)!);
    return invoke(python, workspace, 'prepare', ctx, context, timeout);
  });
  files.registerAgent(component(reporter.id, 'agent', 'tutor-report-input', { completed: 'tutor-reported' }), agents, { prompt: reporter.prompt, config: reporter.config });
  files.registerFunction(component('report-gate', 'gate', 'tutor-reported', { passed: 'tutor-checked', rejected: 'tutor-checked' }), async ctx => {
    const snapshot = runtime.query(ctx.identity.runId), preparation = snapshot.steps.find(step => step.node === 'prepare')?.result;
    if (preparation?.status !== 'accepted') throw new Error('TUTOR_PREPARATION_REQUIRED');
    const trusted = files.inspect(preparation.output, ctx.identity.runId).manifest;
    prepared.set(ctx.identity.runId, trusted); await verify(ctx, trusted);
    return invoke(python, workspace, 'gate', ctx, context, timeout);
  });
  files.registerFunction(component('render', 'transform', 'tutor-checked', { completed: 'tutor-rendered' }), async ctx => {
    await verify(ctx, prepared.get(ctx.identity.runId)!);
    return invoke(python, workspace, 'render', ctx, context, timeout);
  });
  const definition = { id: 'tutor-report', start: 'prepare', maxSteps: 4, input: { kind: 'files' as const, id: 'tutor-marked' },
    outcomes: { completed: { kind: 'files' as const, id: 'tutor-rendered' }, rejected: { kind: 'files' as const, id: 'tutor-checked' } },
    nodes: { prepare: { component: 'prepare' }, reporter: { component: reporter.id }, gate: { component: 'report-gate' }, render: { component: 'render' } },
    routes: [{ from: 'prepare', outcome: 'completed', to: { node: 'reporter' } }, { from: 'reporter', outcome: 'completed', to: { node: 'gate' } },
      { from: 'gate', outcome: 'passed', to: { node: 'render' } }, { from: 'gate', outcome: 'rejected', to: { end: 'rejected' } }, { from: 'render', outcome: 'completed', to: { end: 'completed' } }] };
  const compiled = compileWorkflow(definition, files);
  return { files, driver, runtime, compiled,
    async run(runId: string) {
      if (originals.has(runId)) throw new Error('DUPLICATE_TUTOR_RUN');
      const input = await files.prepareInput(runId, setup.source, 'tutor-marked'); originals.set(runId, files.inspect(input, runId).manifest);
      try { return { input, snapshot: await runtime.start(compiled, runId, input).completion }; }
      catch (error) { await files.release(input, runId); throw error; }
    },
    async release(run: { input: JsonValue; snapshot: WorkflowSnapshot }) {
      for (const step of run.snapshot.steps) {
        if (step.result.status === 'accepted') await files.release(step.result.output, run.snapshot.runId);
        else await files.cleanup(step.result.identity);
      }
      await files.release(run.input, run.snapshot.runId); originals.delete(run.snapshot.runId); prepared.delete(run.snapshot.runId);
    },
  };
}
