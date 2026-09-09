import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '@agentflow/engine';
import { DockerBackend, systemClock, DeepSeekAdapter, FileCredentialStore, FileExecutionCredentialBinding, DeepSeekApiKeyCodec, DeepSeekCredentialRedactor, deepseekApiKeyProfile } from '@agentflow/integrations';
import { deepseekConfiguration, deepseekHeadlessArguments } from '../../packages/integrations/harness/deepseek-configuration.js';
import { interpretDeepseekSession, DEEPSEEK_SESSION_RECORD } from '../../packages/integrations/harness/deepseek-session.js';
const image = process.env['AGENTFLOW_DEEPSEEK_IMAGE'];
async function assets(includeOutcome = false) {
  const manifest = JSON.parse(await readFile(new URL('../../apps/deepseek-tools/package.json', import.meta.url), 'utf8'));
  return Promise.all((manifest.files as string[]).filter(name => includeOutcome || name !== 'outcome-service.mjs').map(async name => ({ name: `deepseek-policy/${name}`,
    content: await readFile(new URL(`../../apps/deepseek-tools/${name}`, import.meta.url), 'utf8') })));
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC';
const steps = [
  { id: 'bash_write', name: 'bash', input: { command: 'printf "修改副本" > /task/input/original.txt; printf "批改完成" > /task/outputs/result.txt; printf "共享临时文件" > /tmp/shared.txt; pwd', workdir: '/task/input' } },
  { id: 'read_image', name: 'read_image', input: { file_path: '/task/input/pixel.png' } },
  { id: 'read_private_image', name: 'read_image', input: { file_path: '/task/state/private-image.png' } },
  { id: 'reserved_code', name: 'run_code', input: { code: 'console.log("reserved-code-ran")' } },
  { id: 'read_key', name: 'read', input: { file_path: '/task/state/deepseek-api-key.json' } },
  { id: 'read_shared', name: 'read', input: { file_path: '/tmp/shared.txt' } },
  { id: 'grep_input', name: 'grep', input: { pattern: '修改副本', path: '/task/input' } },
  { id: 'glob_output', name: 'glob', input: { pattern: '*.txt', path: '/task/outputs' } },
  ...['/task/state/private-fixture.txt', '/task/work/state-link', '/proc/self/root/task/state/private-fixture.txt'].flatMap((path, i) => [
    { id: `bash_private_${i}`, name: 'bash', input: { command: `cat ${path}` } },
    { id: `grep_private_${i}`, name: 'grep', input: { pattern: '.', path } },
  ]),
  { id: 'glob_private', name: 'glob', input: { pattern: '*', path: '/task/state' } },
  { id: 'bash_write_private', name: 'bash', input: { command: 'printf tamper > /task/state/private-fixture.txt' } },
  { id: 'bash_write_config', name: 'bash', input: { command: 'printf tamper > /task/config/deepseek.json' } },
  { id: 'bash_environment', name: 'bash', input: { command: 'env; cat /proc/self/environ' } },
  { id: 'bash_network', name: 'bash', input: { command: `node -e 'require("node:http").get("http://127.0.0.1:FIXTURE_PORT/tool-network-probe",r=>r.pipe(process.stdout)).on("error",()=>{console.log("network-denied");process.exitCode=1})'` } },
  { id: 'invalid_outcome', name: 'agentflow_outcome', input: { outcome: 'not-declared' } },
  { id: 'extra_outcome', name: 'agentflow_outcome', input: { outcome: 'accepted', extra: true } },
  { id: 'choose_outcome', name: 'agentflow_outcome', input: { outcome: 'accepted' } },
].map(step => step.name === 'bash' ? { ...step, input: { ...step.input, description: 'Verify isolated tool behavior' } } : step);
test('DeepSeek native Bash, grep and glob share the isolated task view with file tools', { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-process-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input); await writeFile(join(input, 'original.txt'), '原始答案'); await writeFile(join(input, 'pixel.png'), Buffer.from(png, 'base64'));
    const adapter = new DeepSeekAdapter(), task = { identity: { runId: 'deepseek', nodeTaskId: 'process', attemptId: 'isolated', attemptNumber: 1 }, prompt: '完成工具隔离测试。', config: { model: 'deepseek-v4-flash-vision-exp', reasoning: 'off', search: false, subagents: false }, outcomes: ['accepted', 'rejected'] };
    const config = adapter.plan(task);
    const profile = deepseekApiKeyProfile({ id: 'native-fixture', service: 'deepseek', method: 'api-key', credentialRef: 'native-fixture', endpoint: 'official', capacity: null });
    const credential = { credentialRef: profile.credentialRef, service: profile.service, method: profile.method };
    const store = new FileCredentialStore(join(root, 'credentials'), [new DeepSeekApiKeyCodec()]);
    await store.configure(credential, { content: JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'fixture-deepseek-secret' }) });
    const redactor = new DeepSeekCredentialRedactor();
    const binding = await FileExecutionCredentialBinding.acquireSnapshot(store, { identity: task.identity, credential, stateFile: 'deepseek-api-key.json', environment: {} }, 0, content => redactor.remember(content));
    const patches = JSON.parse(config.configFiles[0]!.content);
    patches.find((patch: any) => patch.id === 'llm-deepseek').config.baseURL = 'http://127.0.0.1:39091';
    const runner = new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1', memoryMiB: 1024 }, {
      environment: binding.environment, async prepare(resource, state) { await binding.prepare(resource, state); await symlink('/task/state/private-fixture.txt', join(dirname(state), 'work/state-link')); }, beforeRelease: resource => binding.beforeRelease(resource),
    }), systemClock);
    const result = await runner.run({ identity: { runId: 'deepseek', nodeTaskId: 'process', attemptId: 'isolated', attemptNumber: 1 }, inputSource: input, timeoutMs: 90000,
      invocation: { argv: ['node', '/task/config/server.cjs'], recordFiles: [DEEPSEEK_SESSION_RECORD], configFiles: [...await assets(true), { name: 'deepseek.json', content: JSON.stringify(patches) },
        { name: 'plan.json', content: JSON.stringify({ environment: config.environment, argv: deepseekHeadlessArguments('完成工具隔离测试。'), captureSession: true, launch: true, hostKey: true, port: 39091, prompt: '完成工具隔离测试。', privateImage: png, steps }) },
        { name: 'server.cjs', content: await readFile(new URL('../fixtures/deepseek-tool-server.cjs', import.meta.url), 'utf8') }] } });
    removable = result.stop === 'confirmed' && result.cleanup === 'removed';
    assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0); assert.ok(removable);
    const auth = await binding.finish(result); assert.equal(auth.status, 'released'); assert.equal(auth.refresh, 'unchanged');
    assert.equal((await store.inspect(credential))!.revision, 1);
    await assert.rejects(readFile(join(dirname(result.capture!.outputsPath), 'state/deepseek-api-key.json')), { code: 'ENOENT' });
    const observed = JSON.parse(await readFile(result.capture!.stdout.path, 'utf8'));
    assert.equal(observed.code, 0, observed.stderr);
    assert.deepEqual(Object.keys(observed.requestPaths).sort(), ['POST /chat/completions', 'POST /files']);
    assert.equal(observed.requestPaths['POST /chat/completions'], steps.length + 1);
    assert.ok(observed.requestPaths['POST /files'] > 0); // This fixture refuses uploads; native CLI falls back to verified inline images.
    assert.equal(observed.authenticatedRequests, Object.values(observed.requestPaths).reduce((a: number, n) => a + Number(n), 0));
    assert.equal(Object.keys(observed.requestKinds).length, 1);
    const kind = JSON.parse(Object.keys(observed.requestKinds)[0]!); assert.equal(kind.path, '/chat/completions'); assert.ok(kind.tools > 0);
    assert.equal(observed.requestKinds[Object.keys(observed.requestKinds)[0]!], steps.length + 1); assert.equal(observed.invalidAuthentication, 0);
    assert.equal(observed.captureError, undefined, JSON.stringify(observed.results));
    assert.match(observed.results.read_image, /image\/png/);
    assert.match(observed.results.reserved_code, /[Uu]nknown tool|UNKNOWN_TOOL/);
    assert.ok(!observed.results.reserved_code.includes('reserved-code-ran'));
    assert.ok(!observed.catalog.some((tool: any) => tool.function.name === 'run_code'));
    assert.equal(observed.imageUrls.length, 1); assert.match(observed.imageUrls[0], /^data:image\/png;base64,/);
    assert.deepEqual(Buffer.from(observed.imageUrls[0].split(',')[1], 'base64'), Buffer.from(png, 'base64'));
    const rawSession = await readFile(result.capture!.files[DEEPSEEK_SESSION_RECORD.id]!.path);
    const interpretation = adapter.interpret({ task, runner: result, version: config.version, records: { deepseek_session: rawSession }, stdout: await readFile(result.capture!.stdout.path), redact: text => redactor.redact(text) });
    assert.equal(interpretation.status, 'completed', JSON.stringify(interpretation.diagnostics));
    assert.equal(interpretation.outcome, 'accepted');
    assert.ok(!JSON.stringify({ auth, interpretation, binding, redactor }).includes('fixture-deepseek-secret'));
    assert.equal(interpretation.usage.inputTokens, (steps.length + 1) * 10);
    assert.equal(interpretation.usage.outputTokens, (steps.length + 1) * 2);
    assert.equal(rawSession.toString(), observed.sessions[0]);
    assert.equal(observed.code, 0, observed.stderr); assert.equal(observed.signal, null);
    assert.equal(Object.keys(observed.results).length, steps.length, JSON.stringify(observed));
    assert.match(observed.results.bash_write, /\/task\/input/);
    assert.match(observed.results.read_shared, /共享临时文件/);
    assert.match(observed.results.grep_input, /修改副本/);
    assert.match(observed.results.glob_output, /result.txt/);
    for (const id of ['bash_private_0', 'bash_private_1', 'bash_private_2', 'bash_write_private', 'bash_write_config'])
      assert.match(observed.results[id], /[Ee]xit [Cc]ode: 1|[Rr]ead-only file system|No such file/);
    const events = observed.sessions.flatMap((session: string) => session.trim().split('\n').map(line => JSON.parse(line)));
    for (const id of ['grep_private_0', 'grep_private_1', 'grep_private_2', 'read_private_image', 'reserved_code', 'read_key', 'invalid_outcome', 'extra_outcome'])
      assert.equal(events.find((event: any) => event.type === 'tool/result' && event.data.message.source.callId === id)?.data.message.content[0].isError, true);
    const chosen = events.find((event: any) => event.type === 'tool/result' && event.data.message.source.callId === 'choose_outcome');
    assert.deepEqual(chosen.data.meta, { schema: 'agentflow-outcome/v1', outcome: 'accepted' });
    assert.equal(chosen.data.message.content[0].isError, false);
    assert.match(observed.results.bash_environment, /PATH=/);
    assert.ok(!observed.results.glob_private.includes('private-fixture.txt'));
    assert.ok(!JSON.stringify(observed.results).includes('private-fixture-content'));
    assert.ok(!JSON.stringify(observed.results).includes('fixture-deepseek-secret'));
    assert.ok(!JSON.stringify(observed.results).includes('fixture-alternate-secret'));
    assert.ok(!JSON.stringify(observed.results).includes('ambient-key-must-not-be-used'));
    assert.match(observed.results.bash_network, /network-denied/); assert.equal(observed.networkHits, 0);
    assert.match(JSON.stringify(observed.contextMessages), /Host originals are separate/);
    assert.equal(await readFile(join(result.capture!.outputsPath, 'result.txt'), 'utf8'), '批改完成');
    const attempt = dirname(result.capture!.outputsPath);
    assert.equal(await readFile(join(attempt, 'input/original.txt'), 'utf8'), '修改副本');
    assert.equal(await readFile(join(input, 'original.txt'), 'utf8'), '原始答案');
    assert.equal(await readFile(join(attempt, 'state/private-fixture.txt'), 'utf8'), 'private-fixture-content');
    assert.deepEqual(JSON.parse(await readFile(join(attempt, 'config/deepseek.json'), 'utf8')), patches);
  } finally { if (removable) await rm(root, { recursive: true, force: true }); }
});

test('DeepSeek process seam: default read-only, environment, spill retrieval, background, timeout and tree cancellation', { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-process-seam-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input);
    const runner = new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1', memoryMiB: 1024 }), systemClock);
    const result = await runner.run({ identity: { runId: 'deepseek', nodeTaskId: 'process-seam', attemptId: 'isolated', attemptNumber: 1 }, inputSource: input, timeoutMs: 90000,
      invocation: { argv: ['/usr/bin/env', 'DEEPSEEK_API_KEY=fixture-parent-secret', 'PASSPHRASE=fixture-alternate-secret', 'NARB_DISABLE_NATIVE_CACHE=1', 'node', '/task/config/seam.mjs'], configFiles: [...await assets(),
        { name: 'seam.mjs', content: await readFile(new URL('../fixtures/deepseek-process-seam.mjs', import.meta.url), 'utf8') }] } });
    removable = result.stop === 'confirmed' && result.cleanup === 'removed';
    assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0, await readFile(result.capture!.stderr.path, 'utf8')); assert.ok(removable);
    assert.equal(await readFile(result.capture!.stdout.path, 'utf8'), 'isolated_process_seam_verified\n');
  } finally { if (removable) await rm(root, { recursive: true, force: true }); }
});

test('DeepSeek private session capture preserves bytes and refuses ambiguous, linked or oversized logs', { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-capture-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input);
    const runner = new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1' }), systemClock);
    const result = await runner.run({ identity: { runId: 'deepseek', nodeTaskId: 'capture', attemptId: 'isolated', attemptNumber: 1 }, inputSource: input, timeoutMs: 60000,
      invocation: { argv: ['node', '/task/config/capture.mjs'], configFiles: [...await assets(),
        { name: 'capture.mjs', content: await readFile(new URL('../fixtures/deepseek-session-capture.mjs', import.meta.url), 'utf8') }] } });
    removable = result.stop === 'confirmed' && result.cleanup === 'removed';
    assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0, await readFile(result.capture!.stderr.path, 'utf8')); assert.ok(removable);
    assert.equal(await readFile(result.capture!.stdout.path, 'utf8'), 'native_session_capture_verified\n');
  } finally { if (removable) await rm(root, { recursive: true, force: true }); }
});

test('DeepSeek launcher refuses unsafe credential files and extra launch arguments without leaking key material', { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-launch-key-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input);
    const result = await new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1' }), systemClock).run({
      identity: { runId: 'deepseek', nodeTaskId: 'launch-key', attemptId: 'isolated', attemptNumber: 1 }, inputSource: input, timeoutMs: 60000,
      invocation: { argv: ['node', '/task/config/refusals.mjs'], configFiles: [...await assets(), { name: 'refusals.mjs', content: await readFile(new URL('../fixtures/deepseek-launch-credentials.mjs', import.meta.url), 'utf8') }] } });
    removable = result.stop === 'confirmed' && result.cleanup === 'removed';
    assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0, await readFile(result.capture!.stderr.path, 'utf8')); assert.ok(removable);
    assert.equal(await readFile(result.capture!.stdout.path, 'utf8'), 'private_launch_refusals_verified\n');
  } finally { if (removable) await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['failModel', 'cancelModel', 'cancelCapture']) test(`DeepSeek launcher ${mode} cannot publish successful native evidence`, { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-launch-stop-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input);
    const config = deepseekConfiguration({ model: 'deepseek-v4-flash', search: false, subagents: false });
    const patches = JSON.parse(config.configFiles[0]!.content); patches.find((patch: any) => patch.id === 'llm-deepseek').config.baseURL = 'http://127.0.0.1:39091';
    const result = await new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1' }), systemClock).run({
      identity: { runId: 'deepseek', nodeTaskId: mode, attemptId: 'isolated', attemptNumber: 1 }, inputSource: input, timeoutMs: 60000,
      invocation: { argv: ['node', '/task/config/server.cjs'], recordFiles: [DEEPSEEK_SESSION_RECORD], configFiles: [...await assets(),
        { name: 'deepseek.json', content: JSON.stringify(patches) }, { name: 'server.cjs', content: await readFile(new URL('../fixtures/deepseek-tool-server.cjs', import.meta.url), 'utf8') },
        ...(mode === 'cancelCapture' ? [{ name: 'cancel-capture.mjs', content: await readFile(new URL('../fixtures/deepseek-cancel-capture.mjs', import.meta.url), 'utf8') }] : []),
        { name: 'plan.json', content: JSON.stringify({ launch: true, prompt: 'test failure', port: 39091, environment: config.environment, steps: [], [mode]: true }) }] } });
    removable = result.stop === 'confirmed' && result.cleanup === 'removed';
    assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0); assert.ok(removable);
    const observed = JSON.parse(await readFile(result.capture!.stdout.path, 'utf8'));
    assert.equal(observed.code, 1, observed.stderr); assert.equal(observed.signal, null); assert.match(observed.stderr, /DEEPSEEK_LAUNCH_FAILED/);
    assert.equal(result.capture!.files[DEEPSEEK_SESSION_RECORD.id]!.complete, false);
    assert.ok(!observed.stderr.includes('fixture-deepseek-secret'));
  } finally { if (removable) await rm(root, { recursive: true, force: true }); }
});

for (const repeat of [true, false]) test(`DeepSeek native outcome rejects ${repeat ? 'duplicate selection' : 'tools after selection'}`, { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-outcome-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input);
    const adapter = new DeepSeekAdapter(), task = { identity: { runId: 'deepseek', nodeTaskId: 'outcome', attemptId: 'isolated', attemptNumber: 1 }, prompt: 'Finish the task.',
      config: { model: 'deepseek-v4-flash', reasoning: 'off', search: false, subagents: false }, outcomes: ['accepted', 'rejected'] };
    const plan = adapter.plan(task), patches = JSON.parse(plan.configFiles[0]!.content);
    patches.find((patch: any) => patch.id === 'llm-deepseek').config.baseURL = 'http://127.0.0.1:39091';
    const calls = [{ id: 'choose', name: 'agentflow_outcome', input: { outcome: 'accepted' } }, repeat
      ? { id: 'later', name: 'agentflow_outcome', input: { outcome: 'rejected' } }
      : { id: 'later', name: 'read', input: { file_path: '/task/config/deepseek.json' } }];
    const runner = new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1', memoryMiB: 1024 }), systemClock);
    const result = await runner.run({ identity: task.identity, inputSource: input, timeoutMs: 90000,
      invocation: { argv: ['node', '/task/config/server.cjs'], recordFiles: [DEEPSEEK_SESSION_RECORD], configFiles: [...await assets(true),
        { name: 'deepseek.json', content: JSON.stringify(patches) }, { name: 'plan.json', content: JSON.stringify({ launch: true, prompt: task.prompt, port: 39091, environment: plan.environment, steps: calls }) },
        { name: 'server.cjs', content: await readFile(new URL('../fixtures/deepseek-tool-server.cjs', import.meta.url), 'utf8') }] } });
    removable = result.stop === 'confirmed' && result.cleanup === 'removed'; assert.equal(result.exitCode, 0); assert.ok(removable);
    const stdout = await readFile(result.capture!.stdout.path), observed = JSON.parse(stdout.toString()); assert.equal(observed.code, 0, observed.stderr);
    const raw = await readFile(result.capture!.files[DEEPSEEK_SESSION_RECORD.id]!.path);
    const value = adapter.interpret({ task, runner: result, version: plan.version, stdout, records: { deepseek_session: raw }, redact: text => text });
    assert.equal(value.status, 'failed'); assert.equal(value.outcome, null); assert.ok(value.diagnostics.includes('TOOL_AFTER_STRUCTURED_OUTCOME'));
    const events = raw.toString().trim().split('\n').map(line => JSON.parse(line)), later = events.find((e: any) => e.type === 'tool/result' && e.data.message.source.callId === 'later');
    assert.equal(later.data.message.content[0].isError, repeat); if (repeat) assert.match(observed.results.later, /OUTCOME_ALREADY_SELECTED/);
  } finally { if (removable) await rm(root, { recursive: true, force: true }); }
});
