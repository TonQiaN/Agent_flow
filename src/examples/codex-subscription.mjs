import { mkdir, mkdtemp, readFile, writeFile, open, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexSubscriptionRunner, CodexSubscriptionCodec, FileCredentialStore } from '@agentflow/integrations';
import { ContractRegistry } from '@agentflow/engine';

const required = name => { const value = process.env[name]; if (!value) throw new Error('MISSING_ACCEPTANCE_CONFIGURATION'); return value; };
async function boundedFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('INVALID_ACCEPTANCE_FILE');
    const bytes = Buffer.alloc(65537); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('ACCEPTANCE_FILE_CHANGED'); return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
const root = required('AGENTFLOW_ACCEPTANCE_ROOT'); await mkdir(root, { recursive: true, mode: 0o700 });
const runRoot = await mkdtemp(join(root, 'run-')); const input = join(runRoot, 'input'); await mkdir(input, { mode: 0o700 });
const source = JSON.stringify({ numbers: [1, 2, 3] }) + '\n'; await writeFile(join(input, 'numbers.json'), source, { mode: 0o600 });
const store = new FileCredentialStore(required('AGENTFLOW_CREDENTIAL_STORE'), [new CodexSubscriptionCodec()]);
const runtime = new CodexSubscriptionRunner(store, { workspaceRoot: join(runRoot, 'attempts'), image: required('AGENTFLOW_CODEX_IMAGE'), proxyImage: required('AGENTFLOW_PROXY_IMAGE') });
const profile = { id: 'acceptance', service: 'openai', method: 'subscription', credentialRef: required('AGENTFLOW_CREDENTIAL_REF'), endpoint: 'official', capacity: 1 };
const task = { identity: { runId: 'codex-acceptance', nodeTaskId: 'sum', attemptId: 'first', attemptNumber: 1 },
  prompt: 'Read /task/input/numbers.json. Sum its numbers and write exactly one JSON object with the key sum to /task/outputs/answer.json. Append one extra newline to /task/input/numbers.json to demonstrate that the local input copy is writable. Do not access credentials or use network tools. Finish with a brief sentence.',
  config: { model: required('AGENTFLOW_CODEX_MODEL'), reasoning: 'low', subagents: false, search: false } };
const execution = await runtime.run({ task, profile, inputSource: input, timeoutMs: 120000 });
const result = execution.result;
await writeFile(join(runRoot, 'execution.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
let artifactAccepted = false; let artifactHash = null; let inputCopyChanged = false;
try {
  if (result.harness?.status === 'completed' && result.authentication?.status === 'released' && result.diagnostics.length === 0) {
    const bytes = await boundedFile(join(result.runner.capture.outputsPath, 'answer.json'));
    const answer = JSON.parse(bytes.toString('utf8'));
    const contracts = new ContractRegistry();
    contracts.register('answer', { type: 'object', properties: { sum: { type: 'integer', const: 6 } }, required: ['sum'], additionalProperties: false });
    artifactAccepted = contracts.check('answer', answer).valid;
    inputCopyChanged = (await boundedFile(join(result.runner.capture.outputsPath, '../input/numbers.json'))).toString('utf8') === source + '\n';
    if (artifactAccepted) { artifactHash = createHash('sha256').update(bytes).digest('hex'); await writeFile(join(runRoot, 'answer.json'), bytes, { mode: 0o600 }); }
  }
} catch { /* A missing or malformed artifact fails acceptance below. */ }
const originalUnchanged = await readFile(join(input, 'numbers.json'), 'utf8') === source;
const summary = { runRoot, runner: result.runner.phase, exitCode: result.runner.exitCode, cleanup: result.runner.cleanup,
  harness: result.harness?.status ?? null, authentication: result.authentication?.status ?? null, refresh: result.authentication?.refresh ?? null,
  diagnostics: [...result.diagnostics, ...result.runner.diagnostics, ...result.harness?.diagnostics ?? []], usage: result.harness?.usage ?? null,
  version: result.version, artifactAccepted, artifactHash, originalUnchanged, inputCopyChanged };
if (result.runner.capture) {
  for (const key of ['stdout', 'stderr']) if (result.runner.capture[key].complete) await copyFile(result.runner.capture[key].path, join(runRoot, `${key}.bin`));
}
try { await execution.retryCleanup(); await execution.release(); summary.workspaceReleased = true; }
catch { summary.workspaceReleased = false; }
await writeFile(join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
// Retained raw evidence remains private; these copies contain no credential-store paths.
console.log(JSON.stringify(summary));
process.exitCode = artifactAccepted && originalUnchanged && inputCopyChanged && summary.workspaceReleased ? 0 : 1;
