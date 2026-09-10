import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Runner } from '@agentflow/engine';
import type { RunnerRequest, RunnerResult } from '@agentflow/engine';
import { DockerBackend, systemClock } from '@agentflow/integrations';

const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const image = process.env['AGENTFLOW_TEST_IMAGE'] ?? 'alpine:3';
const realTest = (name: string, body: () => Promise<void>) => test(name, { skip: !enabled, timeout: 60_000 }, body);
async function fixture(logBytes = 1024 * 1024, selectedImage = image) {
  const root = await mkdtemp(join(tmpdir(), 'agentflow-e2e-'));
  const input = join(root, 'original'); await mkdir(input); await writeFile(join(input, 'answer.txt'), 'original');
  const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: selectedImage, logBytes,
    uid: process.getuid?.() || 1000, gid: process.getgid?.() ?? 1000 });
  const runner = new Runner(backend, systemClock);
  let number = 0;
  const request = (script: string, timeoutMs = 15_000): RunnerRequest => ({ inputSource: input, timeoutMs,
    identity: { runId: 'docker-test', nodeTaskId: `task-${++number}`, attemptId: `attempt-${number}`, attemptNumber: 1 },
    invocation: { argv: ['/bin/sh', '-c', script] } });
  const results: RunnerResult[] = [];
  const run = async (value: RunnerRequest, cancel?: { requested(): boolean }) => { const result = await runner.run(value, cancel); results.push(result); return result; };
  const cleanup = async () => {
    for (const result of results) if (result.resource && result.cleanup === 'removed') await runner.release(result.resource);
    // Failed assertions must still terminate only this fixture's owned resources.
    for (const result of results) if (result.resource && result.cleanup !== 'removed') {
      await backend.stop(result.resource); await backend.remove(result.resource); await runner.release(result.resource);
    }
    await rm(root, { recursive: true, force: true });
  };
  return { root, input, backend, runner, request, run, cleanup };
}

realTest('Docker: two writable copies cannot modify each other or their source; outputs survive container removal', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      f.run(f.request('echo changed > /task/input/answer.txt; mv /task/input/answer.txt /task/input/renamed; cp /task/input/renamed /task/outputs/final.txt')),
      f.run(f.request('sleep 1; cat /task/input/answer.txt > /task/outputs/final.txt; rm /task/input/answer.txt')),
    ]);
    for (const result of [a, b]) { assert.equal(result.phase, 'exited'); assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.cleanup, 'removed'); }
    assert.equal(await readFile(join(f.input, 'answer.txt'), 'utf8'), 'original');
    assert.equal(await readFile(join(a.capture!.outputsPath, 'final.txt'), 'utf8'), 'changed\n');
    assert.equal(await readFile(join(b.capture!.outputsPath, 'final.txt'), 'utf8'), 'original');
    assert.notEqual(a.resource!.id, b.resource!.id);
    const again = await f.run(f.request('test ! -e /task/input/renamed; cat /task/input/answer.txt > /task/outputs/final.txt'));
    assert.equal(again.exitCode, 0);
    await f.runner.release(a.resource!); await f.runner.release(a.resource!);
    await assert.rejects(stat(a.capture!.outputsPath), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

realTest('Docker: nonzero exit, missing executable and invalid configuration preserve execution facts', async () => {
  const f = await fixture();
  try {
    const nonzero = await f.run(f.request('echo failed >&2; exit 7'));
    assert.equal(nonzero.phase, 'exited'); assert.equal(nonzero.exitCode, 7); assert.equal(nonzero.cleanup, 'removed');
    assert.equal(await readFile(nonzero.capture!.stderr.path, 'utf8'), 'failed\n');
    const missing = await f.run({ ...f.request('unused'), invocation: { argv: ['/does-not-exist'] } });
    // With Docker --init, tini itself starts and reports an exec failure as exit 127.
    assert.equal(missing.phase, 'exited'); assert.equal(missing.exitCode, 127); assert.equal(missing.cleanup, 'removed');
    const rejected = await f.run({ ...f.request('unused'), invocation: { argv: ['/bin/true'], env: { API_KEY: 'synthetic-secret' } } });
    assert.equal(rejected.phase, 'failed'); assert.ok(rejected.diagnostics.includes('PREPARE_FAILED'));
    assert.ok(!JSON.stringify(rejected).includes('synthetic-secret'));
  } finally { await f.cleanup(); }
  const unavailable = await fixture(1024, 'agentflow-unavailable-test-image:never-pull');
  try {
    const result = await unavailable.run(unavailable.request('exit 0'));
    assert.equal(result.phase, 'failed'); assert.ok(result.diagnostics.includes('CREATE_FAILED')); assert.equal(result.cleanup, 'removed');
  } finally { await unavailable.cleanup(); }
});

realTest('Docker: timeout and cancellation stop the target, preserve another execution and leave no owned containers', async () => {
  const f = await fixture();
  try {
    const timeout = await f.run(f.request('echo started > /task/outputs/started; sleep 30', 1500));
    assert.equal(timeout.phase, 'timed_out'); assert.equal(timeout.stop, 'confirmed'); assert.equal(timeout.cleanup, 'removed');
    assert.equal(await readFile(join(timeout.capture!.outputsPath, 'started'), 'utf8'), 'started\n');
    let cancelled = false;
    const pending = f.run(f.request('echo started > /task/outputs/started; sleep 30'), { requested: () => cancelled });
    const peer = f.run(f.request('sleep 2; echo finished > /task/outputs/peer'));
    const timer = setTimeout(() => { cancelled = true; }, 1200);
    const result = await pending; clearTimeout(timer);
    assert.equal(result.phase, 'cancelled'); assert.equal(result.stop, 'confirmed'); assert.equal(result.cleanup, 'removed');
    assert.equal(await readFile(join(result.capture!.outputsPath, 'started'), 'utf8'), 'started\n');
    assert.equal((await peer).exitCode, 0);
    for (const resource of [timeout.resource!, result.resource!]) {
      const found = execFileSync('docker', ['container', 'ls', '--all', '--filter', `name=^/${resource.id}$`, '--format', '{{.ID}}'], { encoding: 'utf8' });
      assert.equal(found.trim(), '');
    }
  } finally { await f.cleanup(); }
});

realTest('Docker: logs are streamed with bounds and declared raw files copied before release', async () => {
  const f = await fixture(1024);
  try {
    const invocation = { argv: ['/bin/sh', '-c', 'head -c 200000 /dev/zero; printf error >&2; printf "\\377\\000\\001" > /task/state/events.bin'],
      recordFiles: [{ id: 'events', path: 'events.bin', maxBytes: 10 }, { id: 'absent', path: 'absent', maxBytes: 10 }] };
    const result = await f.run({ ...f.request('unused'), invocation });
    assert.equal(result.exitCode, 0); assert.equal(result.cleanup, 'removed');
    assert.equal(result.capture!.stdout.bytes, 1024); assert.equal(result.capture!.stdout.truncated, true);
    assert.equal((await stat(result.capture!.stdout.path)).size, 1024);
    assert.equal(await readFile(result.capture!.stderr.path, 'utf8'), 'error');
    assert.deepEqual(await readFile(result.capture!.files['events']!.path), Buffer.from([255, 0, 1]));
    assert.equal(result.capture!.files['absent']!.complete, false);
    assert.match(result.capture!.imageId!, /^sha256:[a-f0-9]{64}$/);
  } finally { await f.cleanup(); }
});

realTest('Docker: effective permissions, cgroup limits, private HOME and disabled network are observable inside the container', async () => {
  const f = await fixture();
  try {
    const script = `set -eu
test "$(id -u)" != 0
test "$PWD" = /task/work
test "$HOME" = /task/state
test "$AGENTFLOW_INPUT" = /task/input
test "$AGENTFLOW_OUTPUTS" = /task/outputs
test "$(cat /sys/fs/cgroup/memory.max)" = 536870912
test "$(cat /sys/fs/cgroup/pids.max)" = 128
test "$(cat /sys/fs/cgroup/cpu.max)" = '100000 100000'
test "$(awk '/CapEff:/ {print $2}' /proc/self/status)" = 0000000000000000
test "$(awk '/NoNewPrivs:/ {print $2}' /proc/self/status)" = 1
test ! -e /sys/class/net/eth0
if touch /root-write-test 2>/dev/null; then exit 90; fi
touch /tmp/writable /task/input/extra /task/work/extra /task/state/extra
printf verified > /task/outputs/check`;
    const result = await f.run(f.request(script));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(await readFile(join(result.capture!.outputsPath, 'check'), 'utf8'), 'verified');
  } finally { await f.cleanup(); }
});
