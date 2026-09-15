import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '@agentflow/engine';
import { DockerBackend, systemClock } from '@agentflow/integrations';
import { DEEPSEEK_VERSION, deepseekConfiguration, deepseekHeadlessArguments } from '../../packages/integrations/harness/deepseek-configuration.js';

const image = process.env['AGENTFLOW_DEEPSEEK_IMAGE'];
const prompt = '--help is task text; execute the test and finish.';
const steps = [
  { id: 'read_input', name: 'read', input: { file_path: '/task/input/original.txt' } },
  { id: 'write_work', name: 'write', input: { file_path: '/task/work/work.txt', content: 'writable-work' } },
  { id: 'write_input', name: 'write', input: { file_path: '/task/input/original.txt', content: 'modified-input' } },
  { id: 'write_output', name: 'write', input: { file_path: '/task/outputs/result.txt', content: 'output-result' } },
  { id: 'read_state', name: 'read', input: { file_path: '/task/state/private-fixture.txt' } },
  { id: 'read_environment', name: 'read', input: { file_path: '/proc/self/environ' } },
];

// This records the stock policy's limitations. A future policy integration must separately prove the required writable copies and secret isolation.
test('DeepSeek real CLI compatibility: capability controls work but stock file policy cannot meet task layout', { skip: !image, timeout: 90000 }, async () => {
  const inspect = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image!], { encoding: 'utf8', timeout: 10000 });
  assert.equal(inspect.status, 0); const imageId = inspect.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const version = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'dsh', imageId, '--version'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), DEEPSEEK_VERSION);
  const root = await mkdtemp(join(tmpdir(), 'af-deepseek-tools-')); let removable = true;
  try {
    const input = join(root, 'input'); await mkdir(input); await writeFile(join(input, 'original.txt'), 'original-input');
    const config = deepseekConfiguration({ model: 'deepseek-v4-flash', reasoning: 'off', search: false, subagents: false });
    for (const restricted of [false, true]) {
      // Negative control retains stock web/delegation tools while preserving the same model and session mapping.
      const configFiles = config.configFiles.map(file => ({ ...file, content: restricted ? file.content : JSON.stringify(JSON.parse(file.content)
        .filter((patch: { id: string; disabled?: boolean }) => patch.id !== 'tool-web' && !patch.disabled)) }));
      const runner = new Runner(new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: imageId, network: 'none', sandbox: 'nested-userns-v1', memoryMiB: 1024 }), systemClock);
      const result = await runner.run({ identity: { runId: 'deepseek', nodeTaskId: 'compatibility', attemptId: restricted ? 'configured' : 'default', attemptNumber: 1 }, inputSource: input, timeoutMs: 65000,
        invocation: { argv: ['node', '/task/config/server.cjs'], configFiles: [...configFiles,
          { name: 'plan.json', content: JSON.stringify({ environment: config.environment, argv: deepseekHeadlessArguments(prompt), steps: restricted ? steps : [] }) },
          { name: 'server.cjs', content: await readFile(new URL('../fixtures/deepseek-tool-server.cjs', import.meta.url), 'utf8') }] } });
      removable = result.stop === 'confirmed' && result.cleanup === 'removed';
      assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0); assert.ok(removable);
      assert.ok(result.capture!.stdout.complete); assert.ok(!result.capture!.stdout.truncated); assert.ok(!result.capture!.stdout.error);
      const observed = JSON.parse(await readFile(result.capture!.stdout.path, 'utf8'));
      assert.equal(observed.code, 0, observed.stderr); assert.equal(observed.signal, null);
      const names = observed.catalog.map((tool: { function: { name: string } }) => tool.function.name);
      for (const name of ['read', 'write', 'bash']) assert.ok(names.includes(name));
      if (!restricted) {
        assert.ok(names.some((name: string) => /search/.test(name))); assert.ok(names.includes('subagent')); continue;
      }
      assert.ok(!names.some((name: string) => /web|search|fetch|subagent|fork|workflow|ralph|agent_control|list_agents/.test(name)), JSON.stringify(names));
      assert.equal(Object.keys(observed.results).length, steps.length);
      assert.match(observed.results.read_input, /original-input/); assert.match(observed.results.write_work, /Created file/);
      for (const id of ['write_input', 'write_output']) assert.match(observed.results[id], /sandbox: file access denied/);
      assert.match(observed.results.read_state, /private-fixture-content/);
      // Binary-format refusal is not a secret-read permission rule.
      assert.match(observed.results.read_environment, /binary file/);
      const attempt = dirname(result.capture!.outputsPath);
      assert.equal(await readFile(join(attempt, 'work/work.txt'), 'utf8'), 'writable-work');
      assert.equal(await readFile(join(attempt, 'input/original.txt'), 'utf8'), 'original-input');
      assert.deepEqual(await readdir(result.capture!.outputsPath), []);
      assert.equal(observed.sessions.length, 1);
      const events = observed.sessions[0].trim().split('\n').map((line: string) => JSON.parse(line));
      assert.equal(events[0].type, 'session'); assert.equal(events[0].version, 0); assert.equal(events[0].cwd, '/task/work');
      assert.equal(events[0].delegationDepth, 0);
      assert.ok(events.some((event: { type: string; data?: { source?: { kind: string }; content?: unknown } }) => event.type === 'user/message'
        && event.data?.source?.kind === 'user' && JSON.stringify(event.data.content) === JSON.stringify([{ type: 'text', text: prompt }])));
      for (let i = 1; i < events.length; i++) assert.equal(events[i].seq, i - 1);
      assert.equal(events.at(-1).type, 'turn/end'); assert.equal(events.at(-1).data.reason.kind, 'completed');
      // Completed Harness + no outputs is a reproduced acceptance gap, not successful delivery.
      assert.equal(await readFile(join(input, 'original.txt'), 'utf8'), 'original-input');
    }
  } finally { if (removable) await rm(root, { recursive: true, force: true }); }
});
