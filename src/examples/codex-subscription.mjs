import { mkdir, mkdtemp, readFile, writeFile, open, copyFile, opendir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexSubscriptionRunner, CodexSubscriptionCodec, FileCredentialStore, FileArtifactStore, CodexAgentDriver } from '@agentflow/integrations';
import { AgentExecutor, ContractRegistry, FileContractRegistry } from '@agentflow/engine';

const required = name => { const value = process.env[name]; if (!value) throw new Error('MISSING_ACCEPTANCE_CONFIGURATION'); return value; };
async function boundedFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('INVALID_ACCEPTANCE_FILE');
    const bytes = Buffer.alloc(65537); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('ACCEPTANCE_FILE_CHANGED'); return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
async function candidateInventory(root) {
  const entries = [];
  const walk = async (base, depth) => {
    if (depth > 32) throw new Error('INVENTORY_LIMIT');
    for await (const item of await opendir(join(root, base))) {
      if (entries.length >= 1000) throw new Error('INVENTORY_LIMIT');
      const path = base ? `${base}/${item.name}` : item.name; const stat = await lstat(join(root, path));
      entries.push({ path, kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', bytes: stat.size, links: stat.nlink });
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(path, depth + 1);
    }
  };
  await walk('', 0); return entries;
}
const root = required('AGENTFLOW_ACCEPTANCE_ROOT'); await mkdir(root, { recursive: true, mode: 0o700 });
const runRoot = await mkdtemp(join(root, 'run-')); const input = join(runRoot, 'input'); await mkdir(input, { mode: 0o700 });
const source = JSON.stringify({ numbers: [1, 2, 3] }) + '\n'; await writeFile(join(input, 'numbers.json'), source, { mode: 0o600 });
const store = new FileCredentialStore(required('AGENTFLOW_CREDENTIAL_STORE'), [new CodexSubscriptionCodec()]);
const runtime = new CodexSubscriptionRunner(store, { workspaceRoot: join(runRoot, 'attempts'), image: required('AGENTFLOW_CODEX_IMAGE'), proxyImage: required('AGENTFLOW_PROXY_IMAGE') });
const profile = { id: 'acceptance', service: 'openai', method: 'subscription', credentialRef: required('AGENTFLOW_CREDENTIAL_REF'), endpoint: 'official', capacity: 1 };
const task = { identity: { runId: 'codex-acceptance', nodeTaskId: 'sum', attemptId: 'first', attemptNumber: 1 },
  prompt: 'Read /task/input/numbers.json. Sum its numbers and write exactly one JSON object with the key sum to /task/outputs/answer.json. Append whitespace to /task/input/numbers.json without changing its JSON content, to demonstrate that the local input copy is writable. Do not access credentials or use network tools. Finish with a brief sentence.',
  config: { model: required('AGENTFLOW_CODEX_MODEL'), reasoning: 'low', subagents: false, search: false } };
const multi = process.env['AGENTFLOW_ACCEPTANCE_MULTI_OUTCOME'] === '1';
if (multi) task.prompt += ' For this protocol test, finish with the structured outcome rejected; the answer file must still contain the correct sum.';
const contracts = new ContractRegistry();
contracts.register('input', { type: 'object', properties: { numbers: { type: 'array', items: { type: 'integer' } } }, required: ['numbers'], additionalProperties: false });
contracts.register('answer', { type: 'object', properties: { sum: { type: 'integer', const: 6 } }, required: ['sum'], additionalProperties: false });
const files = new FileContractRegistry(contracts);
for (const [id, path, schema] of [['input-files', 'numbers.json', 'input'], ['answer-files', 'answer.json', 'answer']]) files.register(id, {
  rules: [{ id, kind: 'file', match: path, minCount: 1, maxCount: 1, mediaTypes: ['application/json'], maxBytes: 65536, jsonContract: schema }],
  maxFiles: 1, maxTotalBytes: 65536, unmatched: 'reject',
});
const artifacts = new FileArtifactStore(join(runRoot, 'artifacts'), files);
const coordinator = new AgentExecutor(files, artifacts, new CodexAgentDriver(runtime, artifacts, profile, { timeoutMs: 120000 }));
const attempt = await coordinator.execute({ ...task, componentId: 'sum', input: { source: input, contractId: 'input-files' },
  outcomes: multi ? { accepted: 'answer-files', rejected: 'answer-files' } : { completed: 'answer-files' } });
const result = attempt.result; const facts = attempt.executionFacts();
let artifactAccepted = false; let artifactHash = null; let inputCopyChanged = false; let originalUnchanged = false;
try {
  await writeFile(join(runRoot, 'execution.json'), JSON.stringify(facts, null, 2), { mode: 0o600 });
  if (result.status === 'accepted') {
    const manifest = result.receipt.output;
    await artifacts.materialize(manifest.id, join(runRoot, 'accepted'));
    await writeFile(join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await writeFile(join(runRoot, 'receipt.json'), JSON.stringify(result.receipt, null, 2), { mode: 0o600 });
    const bytes = await boundedFile(join(runRoot, 'accepted/answer.json'));
    artifactAccepted = true;
    const inputCopy = (await boundedFile(join(facts.runner.capture.outputsPath, '../input/numbers.json'))).toString('utf8');
    inputCopyChanged = inputCopy !== source && JSON.stringify(JSON.parse(inputCopy)) === JSON.stringify(JSON.parse(source));
    if (artifactAccepted) { artifactHash = createHash('sha256').update(bytes).digest('hex'); await writeFile(join(runRoot, 'answer.json'), bytes, { mode: 0o600 }); }
  }
  if (facts?.runner.capture) {
    for (const key of ['stdout', 'stderr']) if (facts.runner.capture[key].complete) await copyFile(facts.runner.capture[key].path, join(runRoot, `${key}.bin`));
    if (result.status === 'failed' && facts.runner.stop === 'confirmed' && facts.runner.cleanup === 'removed') {
      await writeFile(join(runRoot, 'candidate-entries.json'), JSON.stringify(await candidateInventory(facts.runner.capture.outputsPath), null, 2), { mode: 0o600 });
    }
  }
  originalUnchanged = await readFile(join(input, 'numbers.json'), 'utf8') === source;
} catch { artifactAccepted = false; }
const outcomeMatched = result.status === 'accepted' && result.receipt.outcome === (multi ? 'rejected' : 'completed');
const summary = { runRoot, acceptance: result.status, outcome: result.status === 'accepted' ? result.receipt.outcome : null,
  contractId: result.status === 'failed' ? result.contractId : null, issues: result.status === 'failed' ? result.issues : [],
  runner: facts?.runner.phase ?? null, exitCode: facts?.runner.exitCode ?? null, cleanup: facts?.runner.cleanup ?? null,
  harness: facts?.harness?.status ?? null, finalized: facts?.finalized ?? false,
  diagnostics: [...(result.status === 'failed' ? [result.code] : []), ...facts?.diagnostics ?? [], ...facts?.runner.diagnostics ?? [], ...facts?.harness?.diagnostics ?? []],
  usage: facts?.harness?.usage ?? null, version: facts?.version ?? null, artifactAccepted, artifactHash, originalUnchanged, inputCopyChanged, outcomeMatched };
let artifactsReleased = true;
try { if (result.status === 'accepted') await coordinator.releaseOutput(result.receipt.id); } catch { artifactsReleased = false; }
try { await attempt.retryCleanup(); await attempt.releaseExecution(); summary.workspaceReleased = artifactsReleased; }
catch { summary.workspaceReleased = false; }
await writeFile(join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
// Retained raw evidence remains private; these copies contain no credential-store paths.
console.log(JSON.stringify(summary));
process.exitCode = artifactAccepted && outcomeMatched && originalUnchanged && inputCopyChanged && summary.workspaceReleased ? 0 : 1;
