import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '@agentflow/engine';
import { DockerBackend, systemClock } from '@agentflow/integrations';
import { deepseekConfiguration, deepseekHeadlessArguments } from '../../packages/integrations/harness/deepseek-configuration.js';
const image = process.env['AGENTFLOW_DEEPSEEK_IMAGE'];
async function assets() {
  const manifest = JSON.parse(await readFile(new URL('../../apps/deepseek-tools/package.json', import.meta.url), 'utf8'));
  return Promise.all((manifest.files as string[]).map(async name => ({ name: `deepseek-policy/${name}`,
    content: await readFile(new URL(`../../apps/deepseek-tools/${name}`, import.meta.url), 'utf8') })));
}
const steps = [
  { id: 'bash_write', name: 'bash', input: { command: 'printf "修改副本" > /task/input/original.txt; printf "批改完成" > /task/outputs/result.txt; printf "共享临时文件" > /tmp/shared.txt; pwd', workdir: '/task/input' } },
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
].map(step => step.name === 'bash' ? { ...step, input: { ...step.input, description: 'Verify isolated tool behavior' } } : step);
test('DeepSeek native Bash, grep and glob share the isolated task view with file tools', { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-process-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input); await writeFile(join(input, 'original.txt'), '原始答案');
    const config = deepseekConfiguration({ model: 'deepseek-v4-flash', reasoning: 'off', search: false, subagents: false });
    const patches = JSON.parse(config.configFiles[0].content);
    patches.push(...['fs-sandbox', 'subprocess', 'bash-sandbox', 'sandbox-policy'].map(id => ({ id, disabled: true })), { insert: [
      { id: 'agentflow-tool-space', name: '/task/config/deepseek-policy/tool-space.mjs' },
      { id: 'agentflow-isolated-fs', name: '/task/config/deepseek-policy/fs-service.mjs' },
      { id: 'agentflow-isolated-process', name: '/task/config/deepseek-policy/subprocess-service.mjs' },
      { id: 'agentflow-task-policy', name: '/task/config/deepseek-policy/sandbox-policy.mjs' },
      { id: 'agentflow-isolated-bash', name: '/task/config/deepseek-policy/bash-service.mjs', config: { cwd: '/task/work', timeoutMs: 5000 } },
    ] });
    const runner = new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1', memoryMiB: 1024 }, {
      environment: {}, async prepare(_resource, state) { await symlink('/task/state/private-fixture.txt', join(dirname(state), 'work/state-link')); }, async beforeRelease() {},
    }), systemClock);
    const result = await runner.run({ identity: { runId: 'deepseek', nodeTaskId: 'process', attemptId: 'isolated', attemptNumber: 1 }, inputSource: input, timeoutMs: 90000,
      invocation: { argv: ['node', '/task/config/server.cjs'], configFiles: [...await assets(), { name: 'deepseek.json', content: JSON.stringify(patches) },
        { name: 'plan.json', content: JSON.stringify({ environment: config.environment, argv: deepseekHeadlessArguments('完成工具隔离测试。'), steps }) },
        { name: 'server.cjs', content: await readFile(new URL('../fixtures/deepseek-tool-server.cjs', import.meta.url), 'utf8') }] } });
    removable = result.stop === 'confirmed' && result.cleanup === 'removed';
    assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0); assert.ok(removable);
    const observed = JSON.parse(await readFile(result.capture!.stdout.path, 'utf8'));
    assert.equal(observed.code, 0, observed.stderr); assert.equal(observed.signal, null);
    assert.equal(Object.keys(observed.results).length, steps.length, JSON.stringify(observed));
    assert.match(observed.results.bash_write, /\/task\/input/);
    assert.match(observed.results.read_shared, /共享临时文件/);
    assert.match(observed.results.grep_input, /修改副本/);
    assert.match(observed.results.glob_output, /result.txt/);
    for (const id of ['bash_private_0', 'bash_private_1', 'bash_private_2', 'bash_write_private', 'bash_write_config'])
      assert.match(observed.results[id], /[Ee]xit [Cc]ode: 1|[Rr]ead-only file system|No such file/);
    const events = observed.sessions.flatMap((session: string) => session.trim().split('\n').map(line => JSON.parse(line)));
    for (const id of ['grep_private_0', 'grep_private_1', 'grep_private_2'])
      assert.equal(events.find((event: any) => event.type === 'tool/result' && event.data.message.source.callId === id)?.data.message.content[0].isError, true);
    assert.match(observed.results.bash_environment, /PATH=/);
    assert.ok(!observed.results.glob_private.includes('private-fixture.txt'));
    assert.ok(!JSON.stringify(observed.results).includes('private-fixture-content'));
    assert.ok(!JSON.stringify(observed.results).includes('fixture-deepseek-secret'));
    assert.ok(!JSON.stringify(observed.results).includes('fixture-alternate-secret'));
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
