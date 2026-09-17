import { test, expect, type Page } from '@playwright/test';
import { resolve, join } from 'node:path';
import { seedVisualRuns, visualRun, visualCode, visualTime } from '../fixtures/studio-visual.js';
const dataRoot = resolve(process.env['AGENTFLOW_BROWSER_DATA'] ?? '.local/studio-visual-tests');
test.beforeAll(async () => { await seedVisualRuns(dataRoot); });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualTime + 600000);
  // Availability is a display fixture; real launch/configuration is tested by journeys.
  await page.route('**/api/workflows', async route => {
    const response = await route.fetch(); const value = await response.json();
    for (const workflow of value.workflows) workflow.missing = workflow.requires.includes('tutor') ? ['请设置 TUTOR 工作区与 Python'] : [];
    await route.fulfill({ response, json: value });
  });
});
async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  // Explicit negative control, never enabled by the normal/update CI commands.
  if (process.env['AGENTFLOW_VISUAL_NEGATIVE'] === '1') await page.addStyleTag({ content: '.main { border: 16px solid magenta !important; }' });
  await expect(page).toHaveScreenshot(name + '.png');
}
async function readyRun(page: Page, id: string) {
  await page.goto('/#/runs/' + id);
  await expect(page.locator('.page-header .badge')).toHaveText('已完成');
  await expect(page.locator('.run-time-range')).toContainText('2026');
  await expect(page.locator('.replay-endpoints time').first()).toContainText('2026');
}

test('library, canvas and selected node preserve workflow hierarchy', async ({ page }) => {
  await page.goto('/#/workflows');
  await expect(page.locator('.workflow-entry')).toHaveCount(5);
  await expect(page.locator('[data-workflow="recruitment"]')).toContainText('4 个节点');
  await shot(page, 'workflow-library');
  await page.getByRole('link', { name: '简历与岗位匹配', exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="parse"]')).toBeVisible();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await shot(page, 'workflow-canvas');
  await page.locator('.react-flow__node[data-id="parse"]').click();
  await expect(page.locator('.task-command')).toContainText('documents.py');
  await page.locator('.inspector').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.container-card')).toContainText('1024 MiB');
  await shot(page, 'node-container');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.setViewportSize({ width: 731, height: 911 });
  await expect(page.locator('.react-flow__node[data-id="parse"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, 'workflow-canvas-narrow');
});

test('batch upload collects a job and three resumes in one dialog', async ({ page }) => {
  await page.goto('/#/workflows/recruitment');
  await page.getByRole('button', { name: '＋ 发起运行', exact: true }).click();
  await page.getByLabel('运行名称', { exact: true }).fill('一个岗位 · 三份合成简历');
  await page.getByLabel('岗位名称', { exact: true }).fill('TypeScript 全栈工程师');
  const fixtures = resolve('src/examples/recruitment/fixtures');
  await page.getByLabel('上传岗位说明', { exact: true }).setInputFiles(join(fixtures, 'job.md'));
  for (const [i, name] of ['resume-a.md', 'resume-b.md', 'resume-c.md'].entries()) {
    if (i) await page.getByRole('button', { name: '＋ 添加候选人', exact: true }).click();
    await page.getByLabel(`上传候选人 ${i + 1}的简历`, { exact: true }).setInputFiles(join(fixtures, name));
  }
  await expect(page.getByText('已选择 4 份材料', { exact: true })).toBeVisible();
  await page.getByLabel('运行名称', { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, 'batch-upload');
});

test('run, replay, per-node timestamps and binary recommendations remain readable', async ({ page }) => {
  await readyRun(page, visualRun);
  await shot(page, 'completed-run');
  await page.getByRole('button', { name: '步骤与并行任务', exact: true }).click();
  await expect(page.locator('.time-cell')).toHaveCount(8);
  await expect(page.locator('.time-cell').first()).toContainText('2026');
  await shot(page, 'node-timestamps');
  await page.getByRole('button', { name: '结果与产物', exact: true }).click();
  await expect(page.locator('.comparison tbody tr')).toHaveCount(3);
  await expect(page.locator('.recommendation.yes').first()).toHaveText('推荐通过');
  await expect(page.locator('.recommendation.no').first()).toHaveText('推荐不通过');
  await shot(page, 'recruitment-results');
  await page.getByRole('button', { name: '工作流画布', exact: true }).click();
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.locator('.replay-bar')).toContainText('回放');
  await page.getByRole('button', { name: '定位当前步骤', exact: true }).click();
  await expect.poll(async () => {
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const node = (await page.locator('.react-flow__node[data-id="render"]').boundingBox())!;
    return node.x >= pane.x && node.x + node.width <= pane.x + pane.width;
  }).toBe(true);
  await shot(page, 'run-replay');
});

test('generic artifacts, grouped files and multi-page PDF are not recruitment-specific', async ({ page }) => {
  await readyRun(page, visualCode);
  await page.getByRole('button', { name: '结果与产物', exact: true }).click();
  await expect(page.locator('.output-values')).toContainText('Python');
  await expect(page.locator('.candidate-report')).toHaveCount(0);
  await shot(page, 'generic-results');
  await page.locator('.artifact-cards button').filter({ hasText: 'analysis.py' }).click();
  await expect(page.locator('.code-preview')).toContainText('def normalize(values)');
  await expect(page.locator('.file-group')).toHaveCount(2);
  await shot(page, 'files-by-node');
  await page.locator('.file-row').filter({ hasText: 'build.pdf' }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.pdf-preview')).toContainText('第 2 / 2 页');
  await expect(page.locator('.pdf-preview')).toContainText('Verification complete');
  await shot(page, 'generic-pdf');
});
