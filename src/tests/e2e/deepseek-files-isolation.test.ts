import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '@agentflow/engine';
import { DockerBackend, systemClock } from '@agentflow/integrations';
import { deepseekConfiguration, deepseekHeadlessArguments } from '../../packages/integrations/harness/deepseek-configuration.js';
const image = process.env['AGENTFLOW_DEEPSEEK_IMAGE'];
const steps = [
  { id: 'read_input', name: 'read', input: { file_path: '/task/input/original.txt' } },
  { id: 'edit_input', name: 'edit', input: { file_path: '/task/input/original.txt', old_string: '原始答案', new_string: '修改副本' } },
  { id: 'write_output', name: 'write', input: { file_path: '/task/outputs/result.txt', content: '批改完成 ✓' } },
  ...['/task/state/private-fixture.txt', '/task/work/state-link', '/proc/self/root/task/state/private-fixture.txt'].map((file_path, i) => ({ id: `read_private_${i}`, name: 'read', input: { file_path } })),
  { id: 'write_private', name: 'write', input: { file_path: '/task/state/private-fixture.txt', content: 'tamper' } },
  { id: 'write_config', name: 'write', input: { file_path: '/task/config/deepseek.json', content: 'tamper' } },
];
test('DeepSeek native read/edit/write use isolated filesystem and preserve host originals', { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-isolation-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input); await writeFile(join(input, 'original.txt'), '原始答案');
    const config = deepseekConfiguration({ model: 'deepseek-v4-flash', reasoning: 'off', search: false, subagents: false });
    const patches = JSON.parse(config.configFiles[0].content); patches.push({ id: 'fs-sandbox', disabled: true }, { insert: [{ id: 'agentflow-tool-space', name: '/task/config/deepseek-policy/tool-space.mjs' }, { id: 'agentflow-isolated-fs', name: '/task/config/deepseek-policy/fs-service.mjs' }] });
    const files = await Promise.all(['tool-isolate', 'fs-service', 'fs-worker', 'sdk', 'tool-space'].map(async name => ({ name: `deepseek-policy/${name}.mjs`,
      content: await readFile(new URL(`../../apps/deepseek-tools/${name}.mjs`, import.meta.url), 'utf8') })));
    files.push({ name: 'deepseek-policy/package.json', content: '{"type":"module"}' });
    const runner = new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1', memoryMiB: 1024 }, {
      environment: {}, async prepare(_resource, state) { await symlink('/task/state/private-fixture.txt', join(dirname(state), 'work/state-link')); }, async beforeRelease() {},
    }), systemClock);
    removable = false; // Preserve bounded raw evidence if execution or assertions fail.
    const result = await runner.run({ identity: { runId: 'deepseek', nodeTaskId: 'files', attemptId: 'isolated', attemptNumber: 1 }, inputSource: input, timeoutMs: 90000,
      invocation: { argv: ['node', '/task/config/server.cjs'], configFiles: [...files, { name: 'deepseek.json', content: JSON.stringify(patches) },
        { name: 'plan.json', content: JSON.stringify({ environment: config.environment, argv: deepseekHeadlessArguments('完成隔离文件工具测试。'), steps }) },
        { name: 'server.cjs', content: await readFile(new URL('../fixtures/deepseek-tool-server.cjs', import.meta.url), 'utf8') }] } });
    await writeFile(join(root, 'runner-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    const stopped = result.stop === 'confirmed' && result.cleanup === 'removed';
    assert.equal(result.phase, 'exited', `Retained Runner evidence: ${root}`); assert.equal(result.exitCode, 0); assert.ok(stopped);
    const observed = JSON.parse(await readFile(result.capture!.stdout.path, 'utf8'));
    assert.equal(observed.code, 0, observed.stderr); assert.equal(observed.signal, null);
    assert.equal(Object.keys(observed.results).length, steps.length);
    assert.match(observed.results.read_input, /原始答案/);
    const events = observed.sessions.flatMap((session: string) => session.trim().split('\n').map(line => JSON.parse(line)));
    const toolResult = (id: string) => events.find((event: any) => event.type === 'tool/result' && event.data.message.source.callId === id)?.data.message.content[0];
    for (const id of ['read_input', 'edit_input', 'write_output']) assert.equal(toolResult(id)?.isError, false, JSON.stringify(observed.results));
    for (const id of ['read_private_0', 'read_private_1', 'read_private_2', 'write_private', 'write_config']) assert.equal(toolResult(id)?.isError, true, JSON.stringify(observed.results));
    assert.ok(!JSON.stringify(observed.results).includes('private-fixture-content'));
    assert.equal(await readFile(join(result.capture!.outputsPath, 'result.txt'), 'utf8'), '批改完成 ✓');
    const attempt = dirname(result.capture!.outputsPath);
    assert.equal(await readFile(join(attempt, 'input/original.txt'), 'utf8'), '修改副本');
    assert.equal(await readFile(join(input, 'original.txt'), 'utf8'), '原始答案');
    assert.equal(await readFile(join(attempt, 'state/private-fixture.txt'), 'utf8'), 'private-fixture-content');
    assert.deepEqual(JSON.parse(await readFile(join(attempt, 'config/deepseek.json'), 'utf8')), patches);
    removable = true;
  } finally {
    if (removable) await rm(root, { recursive: true, force: true });
    else process.stderr.write(`Retained DeepSeek test evidence: ${root}\n`);
  }
});

test('DeepSeek filesystem seam: versions, read-only, byte limits, raw environment isolation and confirmed cancellation', { skip: !image, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-seam-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input);
    const files = await Promise.all(['tool-isolate', 'fs-service', 'fs-worker', 'sdk', 'tool-space'].map(async name => ({ name: `deepseek-policy/${name}.mjs`,
      content: await readFile(new URL(`../../apps/deepseek-tools/${name}.mjs`, import.meta.url), 'utf8') })));
    const runner = new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1', memoryMiB: 1024 }), systemClock);
    removable = false; // Preserve bounded raw evidence if execution or assertions fail.
    const result = await runner.run({ identity: { runId: 'deepseek', nodeTaskId: 'seam', attemptId: 'isolated', attemptNumber: 1 }, inputSource: input, timeoutMs: 90000,
      invocation: { argv: ['/usr/bin/env', 'DEEPSEEK_API_KEY=fixture-parent-secret', 'NARB_DISABLE_NATIVE_CACHE=1', 'node', '/task/config/seam.mjs'], configFiles: [...files,
        { name: 'seam.mjs', content: await readFile(new URL('../fixtures/deepseek-fs-seam.mjs', import.meta.url), 'utf8') }] } });
    await writeFile(join(root, 'runner-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    const stopped = result.stop === 'confirmed' && result.cleanup === 'removed';
    assert.equal(result.phase, 'exited', `Retained Runner evidence: ${root}`); assert.equal(result.exitCode, 0, await readFile(result.capture!.stderr.path, 'utf8')); assert.ok(stopped);
    assert.equal(await readFile(result.capture!.stdout.path, 'utf8'), 'isolated_fs_seam_verified\n');
    removable = true;
  } finally {
    if (removable) await rm(root, { recursive: true, force: true });
    else process.stderr.write(`Retained DeepSeek test evidence: ${root}\n`);
  }
});
