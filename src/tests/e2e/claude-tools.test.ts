import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '@agentflow/engine';
import { ClaudeAdapter, CLAUDE_VERSION, DockerBackend, systemClock } from '@agentflow/integrations';
import type { PrivateStateBinding } from '@agentflow/integrations';

const image = process.env['AGENTFLOW_CLAUDE_IMAGE'];
const credential = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-original', refreshToken: 'fixture-refresh-original',
  expiresAt: 1800000000000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } });
const secretPath = '/task/state/claude/.credentials.json';
const steps = [
  { id: 'read_input', name: 'Read', input: { file_path: '/task/input/test.txt' } },
  ...[secretPath, '../state/claude/.credentials.json', '/task/work/state-link', '/proc/self/root/task/state/claude/.credentials.json'].map((file_path, i) => ({ id: `read_secret_${i}`, name: 'Read', input: { file_path } })),
  { id: 'grep_secret', name: 'Grep', input: { pattern: 'fixture-access', path: '/task/state', output_mode: 'content' } },
  { id: 'glob_secret', name: 'Glob', input: { pattern: '**/*', path: '/task/state' } },
  { id: 'edit_secret', name: 'Edit', input: { file_path: secretPath, old_string: 'fixture-access-original', new_string: 'fixture-tamper' } },
  ...['/task/work/state-link', '/proc/self/root/task/state/claude/.credentials.json'].map((file_path, i) => ({ id: `write_alias_${i}`, name: 'Write', input: { file_path, content: 'tampered' } })),
  { id: 'write_secret', name: 'Write', input: { file_path: '/task/state/injected.txt', content: 'tampered' } },
  { id: 'write_config', name: 'Write', input: { file_path: '/etc/claude-code/managed-settings.json', content: '{}' } },
  { id: 'edit_input', name: 'Edit', input: { file_path: '/task/input/test.txt', old_string: 'original-input', new_string: 'modified-input' } },
  { id: 'write_output', name: 'Write', input: { file_path: '/task/outputs/result.txt', content: 'accepted-output' } },
  { id: 'bash_files', name: 'Bash', input: { command: `node -e 'const fs=require("fs");let r={};for(const [k,p] of [["direct","${secretPath}"],["link","/task/work/state-link"],["proc","/proc/self/root${secretPath}"]]){try{fs.readFileSync(p);r[k]="READ"}catch{r[k]="BLOCKED"}}try{fs.writeFileSync("${secretPath}","bad");r.write="WROTE"}catch{r.write="BLOCKED"}try{fs.writeFileSync("/task/state/overlay.txt","overlay")}catch{}fs.writeFileSync("/task/input/bash.txt","writable-copy");fs.writeFileSync("/task/work/bash.txt","writable-work");fs.writeFileSync("/task/outputs/bash.json",JSON.stringify(r))'`, timeout: 10000 } },
  { id: 'bash_network', name: 'Bash', input: { command: `node -e 'const http=require("http"),fs=require("fs");const r=http.get("http://127.0.0.1:FIXTURE_PORT/tool-network-probe",()=>{fs.writeFileSync("/task/outputs/network.txt","REACHED");process.exit()});r.on("error",()=>{fs.writeFileSync("/task/outputs/network.txt","BLOCKED")});r.setTimeout(1500,()=>r.destroy())'`, timeout: 5000 } },
];

test('Claude real tools: system policy blocks credential paths while input, work and output remain writable',
  { skip: !image, timeout: 120000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'af-claude-tools-')); let removable = true;
    try {
      const input = join(root, 'input'); await mkdir(input); await writeFile(join(input, 'test.txt'), 'original-input');
      // Negative control proves that merely generating a policy and naming an environment variable was insufficient.
      for (const mounted of [false, true]) {
        const identity = { runId: 'tools', nodeTaskId: 'probe', attemptId: mounted ? 'mounted' : 'legacy', attemptNumber: 1 };
        const plan = new ClaudeAdapter().plan({ identity, prompt: 'Execute the supplied test tool requests and finish.', config: { model: 'sonnet', subagents: false, search: false } });
        const binding: PrivateStateBinding = { environment: { CLAUDE_CONFIG_DIR: '/task/state/claude' },
          async prepare(_resource, state) { await mkdir(join(state, 'claude'), { mode: 0o700 }); await writeFile(join(state, 'claude/.credentials.json'), credential, { mode: 0o600 });
            await symlink(secretPath, join(dirname(state), 'work/state-link')); }, async beforeRelease() {} };
        const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none', sandbox: 'nested-userns-v1', memoryMiB: 1024,
          systemConfigMounts: mounted ? [{ name: 'claude-managed.json', target: '/etc/claude-code/managed-settings.json' }] : [] }, binding);
        const runner = new Runner(backend, systemClock);
        const legacyPlan = { ...plan, environment: { ...plan.environment, CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/task/config/claude-managed.json' } };
        const result = await runner.run({ identity, inputSource: input, timeoutMs: 55000, invocation: { argv: ['node', '/task/config/server.cjs'], configFiles: [...plan.configFiles,
          { name: 'plan.json', content: JSON.stringify(mounted ? plan : legacyPlan) }, { name: 'steps.json', content: JSON.stringify(mounted ? steps : [steps[1]]) },
          { name: 'server.cjs', content: await readFile(new URL('../fixtures/claude-tool-server.cjs', import.meta.url), 'utf8') }] } });
        try {
          assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0); assert.equal(result.stop, 'confirmed'); assert.equal(result.cleanup, 'removed');
          const observed = JSON.parse(await readFile(result.capture!.stdout.path, 'utf8'));
          assert.equal(observed.code, 0, observed.stderr); assert.equal(observed.signal, null);
          const events = observed.stdout.trim().split('\n').map((line: string) => JSON.parse(line));
          assert.equal(events.find((e: { type: string; subtype?: string }) => e.type === 'system' && e.subtype === 'init').claude_code_version, CLAUDE_VERSION);
          assert.equal(events.at(-1).is_error, false);
          if (!mounted) { assert.ok(JSON.stringify(observed.results.read_secret_0).includes('fixture-access-original')); continue; }
          assert.equal(Object.keys(observed.results).length, steps.length);
          for (const id of ['read_secret_0', 'read_secret_1', 'read_secret_2', 'read_secret_3', 'edit_secret', 'write_alias_0', 'write_alias_1', 'write_secret', 'write_config']) assert.equal(observed.results[id]?.is_error, true, JSON.stringify({ id, result: observed.results[id] }));
          assert.ok(!JSON.stringify(observed.results).includes('fixture-access-original')); for (const id of ['grep_secret', 'glob_secret']) assert.ok(!JSON.stringify(observed.results[id]).includes('.credentials.json'), JSON.stringify({ id, result: observed.results[id] }));
          assert.ok(JSON.stringify(observed.results.read_input).includes('original-input')); assert.ok(!observed.results.edit_input.is_error); assert.ok(!observed.results.write_output.is_error);
          assert.equal(await readFile(join(result.capture!.outputsPath, 'result.txt'), 'utf8'), 'accepted-output');
          assert.deepEqual(JSON.parse(await readFile(join(result.capture!.outputsPath, 'bash.json'), 'utf8')), { direct: 'BLOCKED', link: 'BLOCKED', proc: 'BLOCKED', write: 'BLOCKED' });
          assert.equal(await readFile(join(result.capture!.outputsPath, 'network.txt'), 'utf8'), 'BLOCKED'); assert.equal(observed.networkHits, 0);
          const attempt = dirname(result.capture!.outputsPath);
          assert.equal(await readFile(join(attempt, 'state/claude/.credentials.json'), 'utf8'), credential);
          await assert.rejects(lstat(join(attempt, 'state/overlay.txt')), { code: 'ENOENT' }); await assert.rejects(lstat(join(attempt, 'state/injected.txt')), { code: 'ENOENT' });
          assert.equal(await readFile(join(attempt, 'config/claude-managed.json'), 'utf8'), plan.configFiles[0]!.content);
          assert.equal(await readFile(join(attempt, 'input/test.txt'), 'utf8'), 'modified-input'); assert.equal(await readFile(join(attempt, 'input/bash.txt'), 'utf8'), 'writable-copy');
          assert.equal(await readFile(join(attempt, 'work/bash.txt'), 'utf8'), 'writable-work'); assert.equal(await readFile(join(input, 'test.txt'), 'utf8'), 'original-input');
        } finally { if (result.stop !== 'confirmed' || result.cleanup !== 'removed') { removable = false; throw new Error('PROBE_RESOURCES_RETAINED'); } await runner.release(result.resource!); }
      }
    } finally { if (removable) await rm(root, { recursive: true, force: true }); }
  });
