import { test, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { seedArtifactRun } from '../fixtures/studio-artifacts.js';
import { SqliteRunRecordStore } from '@agentflow/integrations';
const dataRoot = resolve(process.env['AGENTFLOW_BROWSER_DATA'] ?? '.local/studio-browser-tests');

test('loaded log pages survive refresh and a delayed page cannot cross runs', async ({ page }) => {
  const a = await seedArtifactRun(dataRoot), b = await seedArtifactRun(dataRoot);
  const store = await SqliteRunRecordStore.open(join(a.root, 'records'));
  try { for (let i = 0; i < 450; i++) await store.appendEvent(a.id, { kind: 'page-regression', data: { line: i } }); }
  finally { store.close(); }
  const raw = await (await page.request.get('/api/runs/' + a.id)).json();
  // Keep polling active while real persisted log pages are served unchanged.
  let revision = raw.runs[0].view.revision, reads = 0;
  await page.route('**/api/runs/' + a.id, async route => {
    reads++;
    const data = structuredClone(raw); data.completion = null;
    data.runs[0].view.snapshot.status = 'running'; data.runs[0].view.revision = revision;
    await route.fulfill({ json: data });
  });
  await page.goto('/#/runs/' + a.id);
  await page.getByRole('button', { name: '运行日志', exact: true }).click();
  await expect(page.locator('.log-entry')).toHaveCount(200);
  await page.getByRole('button', { name: '加载更多日志', exact: true }).click();
  await expect(page.locator('.log-entry')).toHaveCount(400);
  const priorReads = reads; revision++;
  await expect.poll(() => reads).toBeGreaterThan(priorReads);
  await expect(page.locator('.log-entry')).toHaveCount(400);

  let release!: () => void, requested!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/api/runs/' + a.id + '/events?**', async route => {
    if (Number(new URL(route.request().url()).searchParams.get('after')) < 400) return route.continue();
    const response = await route.fetch(); requested(); await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '加载更多日志', exact: true }).click();
  await arrived;
  await expect(page.getByRole('button', { name: '加载更多日志', exact: true })).toBeDisabled();
  await page.evaluate(id => { location.hash = '/runs/' + id; }, b.id);
  await expect(page.locator('.page-header .badge')).toHaveText('已完成');
  await page.getByRole('button', { name: '运行日志', exact: true }).click();
  await expect(page.locator('.log-entry')).toHaveCount(2);
  const responded = page.waitForResponse(r => r.url().includes(a.id + '/events?') && Number(new URL(r.url()).searchParams.get('after')) >= 400);
  release(); await responded;
  await expect(page.locator('.log-entry')).toHaveCount(2);
  await expect(page.locator('.panel')).not.toContainText('page-regression');
});

test('grading upload validates JSON before submission, including dropped files', async ({ page }) => {
  await page.route('**/api/workflows', async route => {
    const response = await route.fetch(), data = await response.json();
    data.workflows.find((w: any) => w.id === 'grading-real').missing = [];
    await route.fulfill({ response, json: data });
  });
  let submitted = 0;
  await page.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted++; await route.fulfill({ status: 400, json: { error: 'test submission received' } });
  });
  await page.goto('/#/workflows/grading-real');
  await page.getByRole('button', { name: '＋ 发起运行', exact: true }).click();
  const input = page.getByLabel('上传 paper.json', { exact: true });
  await expect(input).toHaveAttribute('accept', '.json');
  await input.locator('..').evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.getByRole('alert')).toContainText('请选择一份 .json 文件');
  await input.setInputFiles({ name: 'paper.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.getByRole('alert')).toContainText('文件不是有效的 JSON');
  await page.getByRole('button', { name: '确认材料，开始运行 →', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请一次备齐三份有效的 JSON 材料');
  expect(submitted).toBe(0);
  for (const name of ['paper', 'key', 'submission']) {
    await page.getByLabel(`上传 ${name}.json`, { exact: true }).setInputFiles({ name: name + '.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  }
  await expect(page.getByText('已选择 3 份材料', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认材料，开始运行 →', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('test submission received');
  expect(submitted).toBe(1);
});
