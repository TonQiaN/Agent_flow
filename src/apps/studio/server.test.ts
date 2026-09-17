import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from './server.js';
import { safeFile } from './data.js';
test('local service validates origin and uploads, starts original workflow once and reads history after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-studio-')); let app = await startStudio({ dataRoot: root, port: 0 });
  t.after(async () => { await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  let origin = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(origin + '/api/runs', { method: 'POST', headers: { origin: 'https://example.com' } })).status, 403);
  const catalog = await (await fetch(origin + '/api/workflows')).json() as any; assert.equal(catalog.workflows.length, 9); assert.ok(catalog.workflows.find((w: any) => w.id === 'tutor-report'));
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
  const before = detail.runs[0].view.revision;
  await new Promise<void>(resolve => app.server.close(() => resolve())); app = await startStudio({ dataRoot: root, port: 0 }); origin = `http://127.0.0.1:${app.port}`;
  assert.equal((await (await fetch(origin + `/api/runs/${id}`)).json() as any).runs[0].view.revision, before);
  assert.equal((await (await fetch(origin + '/api/runs')).json() as any).runs.length, 1);
  assert.equal((await fetch(origin + `/api/runs/${id}/cancel`, { method: 'POST', headers: { origin } })).status, 405);
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
