import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const fixture = fileURLToPath(new URL('../fixtures/runner-resource.mjs', import.meta.url));
function child(root: string, operation: string, stage: string) {
  const process = fork(fixture, [root, operation, stage, 'network'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let stdout = '', stderr = ''; process.stdout!.on('data', b => { stdout += b; }); process.stderr!.on('data', b => { stderr += b; });
  return { process, exited: once(process, 'exit'), output: () => ({ stdout, stderr }) };
}
async function output(p: ReturnType<typeof child>) {
  const timer = setTimeout(() => p.process.kill('SIGKILL'), 25000);
  try { const [code] = await p.exited; assert.equal(code, 0, p.output().stderr); return JSON.parse(p.output().stdout); }
  finally { clearTimeout(timer); }
}
async function setup(stage: string) {
  const root = await mkdtemp(join(tmpdir(), 'af-network-resource-')); await mkdir(join(root, 'source')); await writeFile(join(root, 'source/input.txt'), 'original');
  const worker = child(root, 'run', stage), timer = setTimeout(() => worker.process.kill('SIGKILL'), 20000);
  let message;
  try { [message] = await Promise.race([once(worker.process, 'message'), worker.exited.then(() => { throw new Error(worker.output().stderr || 'early exit'); })]); }
  finally { clearTimeout(timer); if (worker.process.exitCode === null && worker.process.signalCode === null) { worker.process.kill('SIGKILL'); await worker.exited; } }
  assert.equal(message.event, 'paused'); const id = message.resource.id as string;
  return { root, id, close: async () => {
    for (const name of [id, `${id}-proxy`]) await docker(['rm', '-f', name]).catch(() => {});
    for (const name of [`${id}-internal`, `${id}-external`]) await docker(['network', 'rm', name]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  } };
}
async function assertRemoved(id: string) {
  for (const name of [id, `${id}-proxy`]) assert.equal(await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']), '');
  for (const name of [`${id}-internal`, `${id}-external`]) assert.equal(await docker(['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.ID}}']), '');
}
for (const mode of ['allocated', 'created', 'running', 'exited', 'workspace-missing', 'node-missing', 'proxy-missing'])
  test(`common Runner recovery removes task, proxy and both networks after host SIGKILL: ${mode}`, { skip: !enabled, timeout: 35000 }, async () => {
    const stage = mode.endsWith('-missing') ? 'running' : mode, f = await setup(stage);
    try {
      if (mode === 'running') {
        const store = await SqliteRunRecordStore.open(join(f.root, 'db'));
        try {
          const expected = ((await store.read('run'))!.content as any).execution.egress.proxySha256;
          const actual = await docker(['exec', `${f.id}-proxy`, 'node', '-e', 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync("/proxy.mjs")).digest("hex"))']);
          assert.equal(actual, expected);
        } finally { store.close(); }
      }
      if (mode === 'workspace-missing') await rm(join(f.root, 'attempts'), { recursive: true, force: true });
      if (mode === 'node-missing') await docker(['rm', '-f', f.id]);
      if (mode === 'proxy-missing') await docker(['rm', '-f', `${f.id}-proxy`]);
      const result = await output(child(f.root, 'restore', stage)); assert.equal(result.error, undefined); assert.equal(result.confirmed, true);
      assert.equal(result.observation.state, mode === 'allocated' || mode === 'node-missing' ? 'absent' : mode.endsWith('-missing') ? 'running' : mode);
      await assertRemoved(f.id); assert.equal(await readFile(join(f.root, 'source/input.txt'), 'utf8'), 'original');
    } finally { await f.close(); }
  });
for (const foreign of ['proxy', 'network']) test(`same resource label but wrong task ownership prevents ${foreign} cleanup`, { skip: !enabled, timeout: 25000 }, async () => {
  const f = await setup('allocated');
  try {
    const labels = ['--label', `agentflow.resource=${f.id}`, '--label', 'agentflow.run=foreign'];
    if (foreign === 'proxy') await docker(['run', '-d', '--name', `${f.id}-proxy`, ...labels, '--entrypoint', 'node', 'node:22-bookworm-slim', '-e', 'setInterval(()=>{},1000)']);
    else await docker(['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labels, `${f.id}-internal`]);
    const result = await output(child(f.root, 'restore', 'allocated'));
    assert.equal(result.error, 'EGRESS_OWNERSHIP_MISMATCH'); assert.equal(result.confirmed, false);
    assert.ok(await docker(foreign === 'proxy' ? ['inspect', '--format', '{{.Id}}', `${f.id}-proxy`] : ['network', 'inspect', '--format', '{{.Id}}', `${f.id}-internal`]));
  } finally { await f.close(); }
});
test('network recovery outage and incompatible saved proxy identity cannot be accepted as cleanup', { skip: !enabled, timeout: 35000 }, async () => {
  const f = await setup('running');
  try {
    const outage = await output(child(f.root, 'restore-unavailable', 'running')); assert.equal(outage.confirmed, false); assert.equal(typeof outage.error, 'string');
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', `${f.id}-proxy`]), 'true');
    const store = await SqliteRunRecordStore.open(join(f.root, 'db'));
    try {
      const record = (await store.read('run'))!, changed = structuredClone(record.content) as any;
      changed.execution.egress.proxySha256 = '0'.repeat(64); await store.compareAndSwap('run', record.revision, changed);
      const invalid = child(f.root, 'restore', 'running'); assert.notEqual((await invalid.exited)[0], 0);
      await store.compareAndSwap('run', (await store.read('run'))!.revision, record.content);
    } finally { store.close(); }
    const result = await output(child(f.root, 'restore', 'running')); assert.equal(result.confirmed, true); await assertRemoved(f.id);
  } finally { await f.close(); }
});

test('partial network cleanup retains resource ownership until the remaining network can be removed', { skip: !enabled, timeout: 35000 }, async () => {
  const f = await setup('running'), other = `${f.id}-test-member`;
  try {
    await docker(['run', '-d', '--name', other, '--network', `${f.id}-external`, '--entrypoint', '/bin/sh', 'alpine:3', '-c', 'sleep 60']);
    const first = await output(child(f.root, 'restore', 'running')); assert.equal(first.confirmed, false);
    assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', other]), 'true');
    const store = await SqliteRunRecordStore.open(join(f.root, 'db'));
    try { assert.ok(await readFile(join(((await store.read('run'))!.content as any).backend.directory, '.agentflow-resource.json'))); }
    finally { store.close(); }
    await docker(['rm', '-f', other]);
    const next = await output(child(f.root, 'restore', 'running')); assert.equal(next.confirmed, true); await assertRemoved(f.id);
  } finally { await docker(['rm', '-f', other]).catch(() => {}); await f.close(); }
});
