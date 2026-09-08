import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Runner } from '@agentflow/engine';
import { CODEX_VERSION, CodexAdapter, DockerBackend, systemClock } from '@agentflow/integrations';

const image = process.env['AGENTFLOW_CODEX_IMAGE'];
test('Codex: actual nested sandbox permits task work and blocks synthetic credentials including path bypasses', { skip: !image, timeout: 60_000 }, async () => {
  const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image!], { encoding: 'utf8' }).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(execFileSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'codex', imageId, '--version'], { encoding: 'utf8' }).trim(), `codex-cli ${CODEX_VERSION}`);
  const root = await mkdtemp(join(tmpdir(), 'af-codex-sandbox-'));
  const input = join(root, 'input'); await mkdir(input); await writeFile(join(input, 'answer.txt'), 'original');
  const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: imageId, sandbox: 'nested-userns-v1' });
  const runner = new Runner(backend, systemClock);
  const identity = { runId: 'sandbox', nodeTaskId: 'probe', attemptId: 'attempt-1', attemptNumber: 1 };
  const plan = new CodexAdapter().plan({ identity, prompt: 'unused', config: { model: 'gpt-5.4', subagents: false, search: false } });
  const settings: string[] = [];
  for (let i = 0; i < plan.argv.length; i++) if (plan.argv[i] === '-c') settings.push('-c', plan.argv[++i]!);
  const probe = `set -eu
test "$(id -u)" != 0
echo changed > /task/input/answer.txt
mv /task/input/answer.txt /task/input/renamed
cp /task/input/renamed /task/outputs/result.txt
cat /task/config/protocol.json > /task/work/config-copy
if cat /task/state/codex/auth.json >/dev/null 2>&1; then exit 90; fi
if cat /task/state/codex/profile.json >/dev/null 2>&1; then exit 97; fi
if echo changed > /task/state/codex/auth.json 2>/dev/null; then exit 91; fi
if touch /task/config/overwrite 2>/dev/null; then exit 92; fi
ln -s /task/state/codex/auth.json /task/work/credential-link
if cat /task/work/credential-link >/dev/null 2>&1; then exit 93; fi
if ln /task/state/codex/auth.json /task/work/credential-hard 2>/dev/null; then exit 94; fi
if mv /task/state/codex /task/work/moved-home 2>/dev/null; then exit 95; fi
python3 - <<'PY'
import glob
for path in glob.glob('/proc/[0-9]*/root/task/state/codex/auth.json'):
 try:
  data=open(path,'rb').read()
 except OSError:continue
 if b'SYNTHETIC-CREDENTIAL' in data:raise SystemExit(96)
PY
echo sandbox_verified`;
  // This trusted fixture creates a synthetic marker inside private state. It is not the production credential binding.
  const bootstrap = 'set -eu; mkdir -p /task/state/codex; printf SYNTHETIC-CREDENTIAL > /task/state/codex/auth.json; printf SYNTHETIC-PROFILE > /task/state/codex/profile.json; export CODEX_HOME=/task/state/codex; exec "$@"';
  const result = await runner.run({ identity, inputSource: input, timeoutMs: 20_000,
    invocation: { argv: ['/bin/sh', '-c', bootstrap, 'fixture', 'codex', 'sandbox', '--cd', plan.cwd, '--permission-profile', 'agentflow', ...settings, '--', '/bin/sh', '-c', probe],
      configFiles: [{ name: 'protocol.json', content: '{"version":1}' }] } });
  try {
    const stderr = result.capture ? await readFile(result.capture.stderr.path, 'utf8') : '';
    assert.equal(result.exitCode, 0, JSON.stringify({ phase: result.phase, diagnostics: result.diagnostics, stderr }));
    assert.equal(result.stop, 'confirmed'); assert.equal(result.cleanup, 'removed');
    assert.equal(result.capture!.imageId, imageId);
    assert.equal(await readFile(result.capture!.stdout.path, 'utf8'), 'sandbox_verified\n');
    assert.equal(await readFile(join(result.capture!.outputsPath, 'result.txt'), 'utf8'), 'changed\n');
    assert.equal(await readFile(join(input, 'answer.txt'), 'utf8'), 'original');
    assert.equal(await readFile(join(result.capture!.outputsPath, '../state/codex/auth.json'), 'utf8'), 'SYNTHETIC-CREDENTIAL');
  } finally {
    if (result.resource) {
      if (result.cleanup !== 'removed') { assert.equal((await backend.stop(result.resource)).confirmed, true); await backend.remove(result.resource); }
      await runner.release(result.resource);
    }
    await rm(root, { recursive: true, force: true });
  }
});
