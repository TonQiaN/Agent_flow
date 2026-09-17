import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from './server.js';
import { safeFile } from './data.js';
import { seedArtifactRun } from '../../tests/fixtures/studio-artifacts.js';
test('local service validates origin and uploads, starts original workflow once and reads history after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-studio-')); let app = await startStudio({ dataRoot: root, port: 0 });
  t.after(async () => { await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  let origin = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(origin + '/api/runs', { method: 'POST', headers: { origin: 'https://example.com' } })).status, 403);
  const catalog = await (await fetch(origin + '/api/workflows')).json() as any; assert.equal(catalog.workflows.length, 9); assert.ok(catalog.workflows.find((w: any) => w.id === 'tutor-report'));
  for (const workflow of catalog.workflows) for (const id of Object.keys(workflow.definition.nodes)) {
    assert.ok(workflow.tasks[id]?.summary, `${workflow.id}/${id} task summary`);
    assert.ok(workflow.tasks[id]?.input && workflow.tasks[id]?.output, `${workflow.id}/${id} IO requirements`);
  }
  const recruitment = catalog.workflows.find((w: any) => w.id === 'recruitment');
  assert.match(recruitment.tasks.match.prompt, /不返回岗位、原文或候选人的修改版/);
  assert.match(recruitment.tasks.audit.prompt, /最终是否放行由宿主程序校验/);
  assert.deepEqual(recruitment.tasks.parse.command, ['python3', '/opt/agentflow/documents.py']);
  assert.deepEqual(recruitment.tasks.render.command, ['python3', '/opt/agentflow/documents.py', 'render']);
  assert.equal(recruitment.execution.structure.components.parse.kind, 'transform');
  assert.equal(recruitment.execution.structure.components.match.kind, 'agent');
  assert.equal(JSON.stringify(catalog).includes('Descriptor only; never executed.'), false);
  assert.equal(JSON.stringify(catalog).includes('af-catalogue-'), false, 'temporary inspection paths are not runtime settings');
  assert.deepEqual((await (await fetch(origin + '/api/runs')).json() as any).runs, [], 'describing tasks must not start a Run');
  const form = new FormData(); form.set('manifest', JSON.stringify({ workflowId: 'repair-example', title: '原 CLI 的返工', documents: [] }));
  // Retries share a semantic fingerprint independent of the multipart boundary.
  const request = new Request(origin + '/api/runs', { method: 'POST', body: form }); const bytes = await request.arrayBuffer(); const headers = { origin, 'content-type': request.headers.get('content-type')!, 'idempotency-key': 'test-submit-1' };
  const created = await fetch(origin + '/api/runs', { method: 'POST', headers, body: bytes }); assert.equal(created.status, 201, await created.clone().text()); const { id } = await created.json() as any;
  const again = await fetch(origin + '/api/runs', { method: 'POST', headers, body: bytes }); assert.equal(again.status, 200); assert.equal((await again.json() as any).id, id);
  const rebuilt = await fetch(origin + '/api/runs', { method: 'POST', headers: { origin, 'idempotency-key': 'test-submit-1' }, body: form }); assert.equal(rebuilt.status, 200); assert.equal((await rebuilt.json() as any).id, id);
  let detail: any;
  for (let n = 0; n < 80; n++) { detail = await (await fetch(origin + `/api/runs/${id}`)).json(); if (detail.runs[0]?.view.snapshot.status === 'succeeded') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(detail.meta.mainRunId, id); assert.equal(detail.runs[0].view.runId, id);
  assert.equal(detail.runs[0].view.snapshot.outcome, 'accepted'); assert.equal(detail.runs[0].view.snapshot.steps.length, 5);
  const historical = await (await fetch(origin + `/api/runs/${id}/history`)).json() as any; assert.ok(historical.entries.length > 5);
  const old = await (await fetch(origin + `/api/runs/${id}/revision?revision=1`)).json() as any; assert.equal(old.view.snapshot.status, 'queued');
  const timing = await (await fetch(origin + `/api/runs/${id}/timing`)).json() as any;
  assert.equal(timing.attempts.length, 5);
  assert.ok(timing.attempts.every((a: any) => typeof a.startedAt === 'number' && a.finishedAt >= a.startedAt));
  const earlyTiming = await (await fetch(origin + `/api/runs/${id}/timing?revision=1`)).json() as any;
  assert.deepEqual(earlyTiming.attempts, []); assert.equal(earlyTiming.revisions.length, 1);
  const before = detail.runs[0].view.revision;
  await new Promise<void>(resolve => app.server.close(() => resolve())); app = await startStudio({ dataRoot: root, port: 0 }); origin = `http://127.0.0.1:${app.port}`;
  assert.equal((await (await fetch(origin + `/api/runs/${id}`)).json() as any).runs[0].view.revision, before);
  assert.equal((await (await fetch(origin + '/api/runs')).json() as any).runs.length, 1);
  assert.equal((await fetch(origin + `/api/runs/${id}/cancel`, { method: 'POST', headers: { origin } })).status, 405);
  const code = await seedArtifactRun(root);
  const listed = await (await fetch(origin + `/api/runs/${code.id}/files`)).json() as any;
  const sameNames = listed.files.filter((f: any) => f.name === 'result.json');
  assert.equal(sameNames.length, 2); assert.deepEqual(sameNames.map((f: any) => f.sources[0].node), ['build', 'verify']);
  assert.ok(sameNames.every((f: any) => f.sources[0].attemptNumber === 1 && f.sources[0].recordedAt));
  const script = listed.files.find((f: any) => f.name === 'analysis.py');
  assert.match(await (await fetch(origin + `/api/runs/${code.id}/file/${script.id}?preview=1`)).text(), /def normalize/);
  const large = listed.files.find((f: any) => f.name === 'large.txt');
  const preview = await fetch(origin + `/api/runs/${code.id}/file/${large.id}?preview=1`);
  assert.equal(preview.headers.get('x-preview-truncated'), '1'); assert.equal((await preview.arrayBuffer()).byteLength, 256 * 1024);
  const download = await fetch(origin + `/api/runs/${code.id}/file/${large.id}?download=1`);
  assert.equal((await download.arrayBuffer()).byteLength, large.bytes);
  const html = listed.files.find((f: any) => f.name === 'page.html');
  assert.match((await fetch(origin + `/api/runs/${code.id}/file/${html.id}`)).headers.get('content-type')!, /text\/plain/);
  assert.deepEqual((await (await fetch(origin + `/api/runs/${code.id}/files?at=0`)).json() as any).files, []);
});
test('file preview never follows parent symlinks or accepts traversal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-preview-')); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, 'safe')); await writeFile(join(root, 'private.txt'), 'private'); await symlink(root, join(root, 'safe/link'));
  await assert.rejects(safeFile(join(root, 'safe'), '../private.txt')); await assert.rejects(safeFile(join(root, 'safe'), 'link/private.txt'));
});
for (const workflowId of ['parallel-map', 'parallel-fork']) test(`${workflowId} uses the assigned Studio run identity`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-studio-identity-'));
  const app = await startStudio({ dataRoot: root, port: 0 });
  t.after(async () => { await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.port}`, form = new FormData();
  form.set('manifest', JSON.stringify({ workflowId, title: workflowId, documents: [] }));
  const created = await fetch(origin + '/api/runs', { method: 'POST', headers: { origin, 'idempotency-key': workflowId }, body: form });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json() as any;
  let detail: any;
  for (let n = 0; n < 100; n++) {
    detail = await (await fetch(origin + `/api/runs/${id}`)).json();
    if (detail.completion) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(detail.meta.mainRunId, id);
  assert.equal(detail.runs.find((r: any) => r.view.runId === id)?.view.snapshot.status, 'succeeded');
  assert.ok(!detail.runs.some((r: any) => r.view.runId === 'example'));
});
