import { test, expect, type Page } from "@playwright/test";
import { resolve, join } from "node:path";
import { readdir, rename } from "node:fs/promises";
const fixtures = resolve("src/examples/recruitment/fixtures");
async function panToNode(page: Page, id: string) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(node).toBeVisible();
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  for (let i = 0; i < 12; i++) {
    const rect = (await node.boundingBox())!;
    if (
      rect.x >= pane.x + 10 &&
      rect.x + rect.width <= pane.x + pane.width - 10
    )
      return node;
    const delta = Math.max(
      -pane.width + 160,
      Math.min(
        pane.width - 160,
        pane.x + pane.width / 2 - rect.x - rect.width / 2,
      ),
    );
    const x = delta < 0 ? pane.x + pane.width - 60 : pane.x + 60;
    const y = pane.y + pane.height - 25;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(async () => Math.abs((await node.boundingBox())!.x - rect.x))
      .toBeGreaterThan(10);
  }
  throw new Error(`Could not pan to ${id}`);
}
async function launch(page: Page, scenario = "normal") {
  await page.goto("/#/workflows");
  await page.getByRole("link", { name: "简历与岗位匹配", exact: true }).click();
  await page.getByRole("button", { name: "＋ 发起运行", exact: true }).click();
  await page
    .getByLabel("运行名称", { exact: true })
    .fill("浏览器验收 · " + scenario);
  await page
    .getByLabel("岗位名称", { exact: true })
    .fill("TypeScript 全栈工程师");
  await page
    .getByLabel("上传岗位说明", { exact: true })
    .setInputFiles(join(fixtures, "job.md"));
  for (const [i, name] of [
    "resume-a.md",
    "resume-b.md",
    "resume-c.md",
  ].entries()) {
    if (i)
      await page
        .getByRole("button", { name: "＋ 添加候选人", exact: true })
        .click();
    await page
      .getByLabel(`上传候选人 ${i + 1}的简历`, { exact: true })
      .setInputFiles(join(fixtures, name));
  }
  await page
    .getByRole("combobox", { name: "合成测试场景", exact: true })
    .selectOption(scenario);
  await expect(
    page.getByText("已选择 4 份材料", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "确认材料，开始运行 →", exact: true })
    .click();
  await page.waitForURL("**/#/runs/run-*");
  return page.url().split("/runs/")[1];
}
async function settled(page: Page, id: string | undefined, status: string) {
  // The page already polls the real service. Observe its displayed progress;
  // a second full-snapshot poll duplicates several MB per request during rework.
  await expect
    .poll(
      async () => {
        const badges = await page
          .locator(".page-header .badge")
          .allTextContents();
        return badges.some((text) =>
          ["已完成", "执行失败", "已取消", "次数已用尽", "进程已中断"].includes(
            text.trim(),
          ),
        );
      },
      { timeout: 150000, intervals: [1000] },
    )
    .toBe(true);
  // Read the persisted result once after the user-visible terminal state.
  // Keep the process-error and exact engine-state assertions; do not infer
  // workflow success from a green label alone.
  const response = await page.request.get("/api/runs/" + id, {
    maxRetries: 2,
  });
  expect(response.ok()).toBe(true);
  const latest = await response.json();
  expect(latest.completion?.error ?? null, "workflow process error").toBeNull();
  expect(
    latest.runs.find((r: any) => !r.view.runId.startsWith("parallel-"))?.view
      .snapshot.status,
  ).toBe(status);
  await page.reload();
  await expect(page.locator(".page-header .badge")).toContainText(
    status === "succeeded"
      ? "已完成"
      : status === "failed"
        ? "执行失败"
        : "已取消",
  );
}

test("node tasks expose full prompts, commands and containers without launching a run", async ({ page, context }) => {
  const before = await (await page.request.get('/api/runs')).json();
  const catalogue = await (await page.request.get('/api/workflows')).json();
  const recruitment = catalogue.workflows.find((w: any) => w.id === 'recruitment');
  await page.goto('/#/workflows/recruitment');
  await (await panToNode(page, 'parse')).click();
  const inspector = page.locator('.inspector');
  await expect(inspector).toContainText('当前流程定义');
  await expect(inspector.locator('.task-command')).toHaveText('python3 /opt/agentflow/documents.py');
  await expect(inspector).toContainText('扫描件使用 OCR');
  await expect(inspector).toContainText('输入要求');
  await expect(inspector).toContainText('输出要求');
  await inspector.getByRole('button', { name: '设置', exact: true }).click();
  expect(await inspector.evaluate(el => el.scrollTop)).toBe(0);
  await expect(inspector.locator('.container-card')).toContainText('1024 MiB');
  await expect(inspector.locator('.container-card')).toContainText('none');
  await expect(inspector).not.toContainText('这个节点未记录容器配置');
  await test.info().attach('node-script-container', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await (await panToNode(page, 'match')).click();
  await expect(inspector.locator('.task-prompt')).toHaveText(recruitment.tasks.match.prompt);
  await inspector.getByRole('button', { name: '展开全文', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '收起全文', exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: '收起全文', exact: true }).click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await inspector.getByRole('button', { name: '复制Prompt', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(recruitment.tasks.match.prompt);
  await test.info().attach('node-full-prompt', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await (await panToNode(page, 'audit')).click();
  await expect(inspector.locator('.task-prompt')).toHaveText(recruitment.tasks.audit.prompt);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await (await panToNode(page, 'render')).click();
  await expect(inspector.locator('.task-command')).toHaveText('python3 /opt/agentflow/documents.py render');
  await page.setViewportSize({ width: 731, height: 911 });
  await expect(inspector).toBeVisible();
  const rect = (await inspector.boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(731);
  expect(await inspector.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const after = await (await page.request.get('/api/runs')).json();
  expect(after.runs.map((run: any) => run.id)).toEqual(before.runs.map((run: any) => run.id));
});

test("workflow catalogue separates business flows from examples and opens a readable node canvas", async ({
  page,
}) => {
  await page.goto("/#/workflows");
  await expect(page.locator(".workflow-entry")).toHaveCount(5);
  await expect(page.locator('[data-workflow="parallel-map"]')).toHaveCount(0);
  await expect(page.locator('[data-workflow="recruitment"]')).toContainText(
    "4 个节点",
  );
  await expect(
    page.getByRole("link", { name: "试卷批改 · Agent", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "试卷批改 · 持久化", exact: true }),
  ).toBeVisible();
  await test.info().attach("workflow-library", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "技术示例", exact: true }).click();
  await expect(page.locator(".workflow-entry")).toHaveCount(4);
  await expect(page.locator('[data-workflow="parallel-map"]')).toBeVisible();
  await page.getByRole("button", { name: "业务工作流", exact: true }).click();
  await page.getByRole("link", { name: "简历与岗位匹配", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(page.locator(".inspector")).toHaveCount(0);
  await expect(page.locator(".node-status")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".react-flow__node")
        .first()
        .evaluate((e) => e.getBoundingClientRect().width),
    )
    .toBeGreaterThan(180);
  const geometry = await page
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const rect = n.getBoundingClientRect();
        const title = n.querySelector(".node-title")!;
        return {
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          font:
            (parseFloat(getComputedStyle(title).fontSize) * rect.width) /
            (n as HTMLElement).offsetWidth,
        };
      }),
    );
  for (const [i, a] of geometry.entries()) {
    expect(
      a.font,
      "default node titles must remain readable",
    ).toBeGreaterThanOrEqual(12);
    for (const b of geometry.slice(i + 1))
      expect(
        a.x + a.w <= b.x ||
          b.x + b.w <= a.x ||
          a.y + a.h <= b.y ||
          b.y + b.h <= a.y,
        "default nodes must not overlap",
      ).toBe(true);
  }
  const canvas = await page.locator(".graph").boundingBox();
  expect(canvas!.width).toBeGreaterThan(1250);
  expect(canvas!.height).toBeGreaterThan(650);
  // Main steps continue right beyond the viewport; opening a long workflow
  // must not shrink it into an unreadable overview or wrap its primary path.
  for (let i = 1; i < 4; i++) {
    expect(geometry[i]!.x).toBeGreaterThan(
      geometry[i - 1]!.x + geometry[i - 1]!.w,
    );
    expect(geometry[i]!.y).toBeCloseTo(geometry[0]!.y);
  }
  expect(geometry[3]!.x + geometry[3]!.w).toBeGreaterThan(
    canvas!.x + canvas!.width,
  );
  await expect(page.locator(".flow-edge-label")).toHaveCount(6);
  await expect(
    page.getByRole("button", {
      name: "连线：全部材料 → 匹配分析",
      exact: true,
    }),
  ).toBeInViewport();
  const curves = await page
    .locator(".react-flow__edge-path")
    .evaluateAll((paths) =>
      paths.map((path) => ({
        d: path.getAttribute("d")!,
        y: [0, 0.25, 0.5, 0.75, 1].map(
          (fraction) =>
            (path as SVGPathElement).getPointAtLength(
              (path as SVGPathElement).getTotalLength() * fraction,
            ).y,
        ),
      })),
    );
  for (const curve of curves) {
    expect(curve.d).toContain("C");
    expect(curve.d).not.toMatch(/[LHV]/);
    expect(Math.max(...curve.y) - Math.min(...curve.y)).toBeGreaterThan(5);
  }
  await test.info().attach("workflow-canvas", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await (await panToNode(page, "audit")).click();
  await expect(page.locator(".inspector h3")).toHaveText("独立复核");
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await test.info().attach("workflow-conditions", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "回到起点", exact: true }).click();
  await expect(
    page.locator('.react-flow__node[data-id="parse"]'),
  ).toBeInViewport();
  await page
    .getByRole("button", { name: "连线：全部材料 → 匹配分析", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "连线详情" })).toBeVisible();
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.setViewportSize({ width: 731, height: 911 });
  await page.reload();
  await expect(
    page.locator('.react-flow__node[data-id="parse"]'),
  ).toBeInViewport();
  await (await panToNode(page, "match")).click();
  await expect(page.locator(".inspector h3")).toHaveText("匹配与推荐");
  await page.setViewportSize({ width: 1453, height: 874 });
  await page.goto("/#/workflows/repair-example");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(
    page.getByRole("button", {
      name: "连线：修订完成 → 检查草稿",
      exact: true,
    }),
  ).toBeVisible();
  // The lower repair branch must not visually pass through the successful end.
  const crossesEnd = await page.locator(".react-flow").evaluate((graph) => {
    const end = graph.querySelector(".task-node.end")!.getBoundingClientRect();
    return ["1", "2"].some((id) => {
      const path = graph.querySelector(
        `.react-flow__edge[data-id="${id}"] .react-flow__edge-path`,
      ) as SVGPathElement;
      return Array.from({ length: 39 }, (_, i) => {
        const point = path
          .getPointAtLength((path.getTotalLength() * (i + 1)) / 40)
          .matrixTransform(path.getScreenCTM()!);
        return (
          point.x > end.left &&
          point.x < end.right &&
          point.y > end.top &&
          point.y < end.bottom
        );
      }).some(Boolean);
    });
  });
  expect(
    crossesEnd,
    "repair edges must not suggest execution through the success end",
  ).toBe(false);
  await test.info().attach("existing-repair-canvas", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("upload, canvas, evidence reports, PDF, historical replay, missing files and responsive navigation", async ({
  page,
}) => {
  await page.goto("/#/workflows/recruitment");
  const node = page.locator('.react-flow__node[data-id="parse"]');
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  await page.mouse.move(before!.x + 40, before!.y + 20);
  await page.mouse.down();
  await page.mouse.move(before!.x + 120, before!.y + 70, { steps: 8 });
  await page.mouse.up();
  const after = await node.boundingBox();
  expect(after!.x - before!.x).toBeGreaterThan(40);
  await node.click();
  await expect(page.locator(".inspector")).toContainText("读取全部材料");
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.reload();
  await expect(node).toBeVisible();
  await expect
    .poll(async () => (await node.boundingBox())!.x)
    .toBeGreaterThan(before!.x + 40);
  await page.getByRole("button", { name: "自动布局", exact: true }).click();
  await expect
    .poll(async () => (await node.boundingBox())!.x)
    .toBeLessThan(after!.x - 40);
  const edgePoint = await page
    .locator(".react-flow__edge")
    .first()
    .evaluate((edge) => {
      const path = edge.querySelector("path")!;
      for (const fraction of [0.25, 0.75, 0.1, 0.9, 0.5]) {
        const p = path
          .getPointAtLength(path.getTotalLength() * fraction)
          .matrixTransform(path.getScreenCTM()!);
        if (
          document.elementFromPoint(p.x, p.y)?.closest(".react-flow__edge") ===
          edge
        )
          return { x: p.x, y: p.y };
      }
      return null;
    });
  expect(edgePoint).not.toBeNull();
  await page.mouse.click(edgePoint!.x, edgePoint!.y);
  await expect(page.getByRole("heading", { name: "连线详情" })).toBeVisible();
  await page.getByRole("button", { name: "＋ 发起运行", exact: true }).click();
  await page
    .getByRole("button", { name: "确认材料，开始运行 →", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("请一次备齐");
  await page.getByRole("button", { name: "关闭上传弹窗" }).click();
  const id = await launch(page);
  await settled(page, id, "succeeded");
  await expect(
    page
      .locator(".run-summary > div")
      .filter({ hasText: "文件" })
      .locator("strong"),
  ).toHaveText(/[1-9]\d*/);
  await test.info().attach("completed-run-canvas", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.getByRole("link", { name: "返回所属工作流", exact: true }).click();
  await expect(page.locator(".latest-run-strip")).toContainText(
    "浏览器验收 · normal",
  );
  await page.getByRole("link", { name: /查看完整运行/ }).click();
  await expect(page).toHaveURL(new RegExp("/runs/" + id + "$"));
  // A hash change precedes React replacing the definition page. Wait for the
  // run itself so the canvas helper does not measure the outgoing definition.
  await expect(
    page.getByRole("heading", { name: "浏览器验收 · normal", exact: true }),
  ).toBeVisible();
  await (await panToNode(page, "match")).click();
  await expect(page.locator(".node-children > button")).toHaveCount(0);
  await expect(page.locator('.inspector')).toContainText('本次运行已保存');
  const savedDetail = await (await page.request.get('/api/runs/' + id)).json();
  const saved = savedDetail.runs.find((r: any) => r.view.snapshot.workflowId === 'recruitment');
  await expect(page.locator('.task-prompt')).toHaveText(saved.view.execution.bindings.match.execution.prompt);
  // Deliberately make the saved task different from today's definition. The
  // page must display that saved task, including an honest missing-data state.
  const old = structuredClone(savedDetail);
  old.runs.find((r: any) => r.view.snapshot.workflowId === 'recruitment').view.execution.bindings.match.execution.prompt = '这次运行当时保存的旧版任务说明。';
  const runEndpoint = '**/api/runs/' + id;
  await page.route(runEndpoint, route => route.fulfill({ json: old }));
  await page.reload();
  await (await panToNode(page, 'match')).click();
  await expect(page.locator('.task-prompt')).toHaveText('这次运行当时保存的旧版任务说明。');
  delete old.runs.find((r: any) => r.view.snapshot.workflowId === 'recruitment').view.execution.bindings.match;
  await page.reload();
  await (await panToNode(page, 'match')).click();
  await expect(page.locator('.task-prompt')).toHaveCount(0);
  await expect(page.locator('.inspector')).toContainText('这份记录未提供 Prompt 或执行命令');
  await page.unroute(runEndpoint);
  await page.reload();
  await (await panToNode(page, 'match')).click();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "输入", exact: true })
    .click();
  await expect(page.locator(".inspector")).toContainText("document-3.md");
  await page
    .locator(".inspector")
    .getByRole("button", { name: "输出", exact: true })
    .click();
  await expect(page.locator(".inspector")).toContainText("推荐通过");
  await expect(page.locator(".inspector")).toContainText("推荐不通过");
  const generatedOutput = page.locator(".inspector > pre");
  await expect(generatedOutput).toContainText('"requirements"');
  await expect(generatedOutput).toContainText('"recommendations"');
  await expect(generatedOutput).not.toContainText('"documents"');
  await page.getByText("完整传递数据（含原始材料）", { exact: true }).click();
  await expect(page.locator(".inspector details[open] pre")).toContainText(
    "document-3.md",
  );
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByRole("button", { name: "定位最后步骤", exact: true }).click();
  await expect(page.locator(".inspector h3")).toHaveText("生成报告与 PDF");
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.getByRole("button", { name: "结果与报告", exact: true }).click();
  await expect(page.locator(".candidate-report")).toHaveCount(3);
  await expect(
    page.locator(".candidate-report .recommendation.yes"),
  ).toHaveCount(1);
  await expect(
    page.locator(".candidate-report .recommendation.no"),
  ).toHaveCount(2);
  await expect(page.locator(".candidate-report").last()).toContainText(
    "材料冲突",
  );
  await page
    .getByRole("button", { name: "查看个人 PDF ↗", exact: true })
    .first()
    .click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const pdf = page.locator(".pdf-preview canvas");
  await expect(pdf).toHaveAttribute("data-ready", "true");
  await page.getByText("查看本页文字", { exact: true }).click();
  await expect(page.locator(".pdf-text")).toContainText("推荐通过");
  const download = page.getByRole("link", {
    name: "下载文件 ↓",
    exact: true,
  });
  const response = await page.request.get(
    (await download.getAttribute("href"))!,
    { maxRetries: 2 },
  );
  expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await page.getByRole("button", { name: "本次设置", exact: true }).click();
  await expect(page.locator(".container-card").first()).toContainText(
    "1024 MiB",
  );
  await expect(page.locator(".container-card").first()).toContainText(
    "sha256:",
  );
  await page.getByRole("button", { name: "工作流画布", exact: true }).click();
  await page.getByRole("button", { name: "回到起点", exact: true }).click();
  await page.locator('.react-flow__node[data-id="parse"]').click();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "输入", exact: true })
    .click();
  await expect(page.locator(".inspector")).toContainText("document-0.md");
  const current = await (
    await page.request.get("/api/runs/" + id, { maxRetries: 2 })
  ).json();
  const currentMain = current.runs.find(
    (r: any) => !r.view.runId.startsWith("parallel-"),
  ).view;
  expect(current.runs).toHaveLength(1);
  expect(currentMain.snapshot.steps.map((s: any) => s.node)).toEqual([
    "parse",
    "match",
    "audit",
    "render",
  ]);
  await test.info().attach("recruitment-input-output", {
    body: Buffer.from(
      JSON.stringify(
        {
          input: currentMain.values[0].value,
          output: currentMain.snapshot.lastAccepted.result.output,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
  const mainId = current.runs.find(
    (r: any) => !r.view.runId.startsWith("parallel-"),
  ).view.runId;
  const timeline = await (
    await page.request.get(`/api/runs/${id}/history?run=${mainId}`)
  ).json();
  const active = timeline.entries.findIndex(
    (r: any) =>
      r.snapshot.currentNode === "match" && r.snapshot.status === "running",
  );
  expect(active).toBeGreaterThanOrEqual(0);
  await page.getByRole("slider", { name: "回放进度" }).fill(String(active));
  await expect(page.locator(".node-status.running")).toHaveCount(1);
  await page.getByRole("button", { name: "定位当前步骤", exact: true }).click();
  await expect(page.locator(".inspector h3")).toHaveText("匹配与推荐");
  await expect(page.locator(".node-children > button")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByRole("slider", { name: "回放进度" }).fill("0");
  await expect(page.getByText("历史回放", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "结果与报告", exact: true }).click();
  await expect(page.locator(".candidate-report")).toHaveCount(0);
  await expect(page.locator(".panel")).toContainText("尚无经过交付关卡");
  await page
    .getByRole("button", { name: "步骤与并行任务", exact: true })
    .click();
  await expect(page.locator(".child-run")).toHaveCount(1);
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect
    .poll(async () =>
      Number(await page.getByRole("slider", { name: "回放进度" }).inputValue()),
    )
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  const unchanged = await (
    await page.request.get("/api/runs/" + id, { maxRetries: 2 })
  ).json();
  expect(unchanged.runs.map((r: any) => [r.key, r.view.revision])).toEqual(
    current.runs.map((r: any) => [r.key, r.view.revision]),
  );
  await page.getByRole("button", { name: "回到当前", exact: true }).click();
  await page.getByRole("link", { name: "运行历史", exact: true }).click();
  await page
    .getByRole("combobox", { name: "工作流", exact: true })
    .selectOption("recruitment");
  await expect(page.getByText("浏览器验收 · normal").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "本机设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "你的本机环境", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(page.locator("input,textarea")).toHaveCount(0);
  await page.getByRole("link", { name: "工作流", exact: true }).click();
  await page.getByRole("link", { name: "简历与岗位匹配", exact: true }).click();
  const mobileStart = page.locator('.react-flow__node[data-id="parse"]');
  await expect
    .poll(async () => {
      const rect = await mobileStart.boundingBox();
      return !!rect && rect.x >= 0 && rect.x + rect.width <= 390;
    })
    .toBe(true);
  await mobileStart.click();
  await expect(page.locator(".inspector h3")).toHaveText("读取全部材料");
  await test.info().attach("mobile-node-details", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  // A missing immutable archive must remain visible as missing, not silently vanish.
  const archiveRoot = resolve(
    process.env['AGENTFLOW_BROWSER_DATA'] ?? '.local/studio-browser-tests',
    'runs',
    id!,
    "tasks/archive",
  );
  const archive = (await readdir(archiveRoot)).find((n) => !n.startsWith("."))!;
  await rename(join(archiveRoot, archive), join(archiveRoot, "." + archive));
  try {
    await page.goto("/#/runs/" + id);
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.getByText("归档不可用", { exact: true })).toBeVisible();
    await page
      .getByRole("button")
      .filter({ hasText: "文件归档不可用" })
      .click();
    await expect(page.getByRole("alert")).toContainText("丢失或校验失败");
  } finally {
    await rename(join(archiveRoot, "." + archive), join(archiveRoot, archive));
  }
});

for (const scenario of ["rework", "retry", "failure", "cancel", "exhausted"])
  test(`real service shows ${scenario} without creating a false candidate recommendation`, async ({
    page,
  }) => {
    const id = await launch(page, scenario);
    await settled(
      page,
      id,
      scenario === "failure"
        ? "failed"
        : scenario === "cancel"
          ? "cancelled"
          : "succeeded",
    );
    if (
      scenario === "failure" ||
      scenario === "cancel" ||
      scenario === "exhausted"
    ) {
      await page
        .getByRole("button", { name: "结果与报告", exact: true })
        .click();
      await expect(page.locator(".candidate-report")).toHaveCount(0);
      await expect(page.locator(".panel")).toContainText(
        "不等于候选人被判不通过",
      );
    } else {
      const detail = await (
        await page.request.get("/api/runs/" + id, { maxRetries: 2 })
      ).json();
      if (scenario === "rework") {
        expect(
          detail.runs
            .find((r: any) => !r.view.runId.startsWith("parallel-"))
            .view.snapshot.steps.filter((s: any) => s.node === "audit"),
        ).toHaveLength(2);
        const main = detail.runs.find(
          (r: any) => !r.view.runId.startsWith("parallel-"),
        ).view;
        const rounds = main.attempts.filter((a: any) => a.node === "match");
        expect(rounds).toHaveLength(2);
        await (await panToNode(page, "match")).click();
        await page
          .getByLabel("本步骤的执行次数", { exact: true })
          .selectOption("0");
        await page
          .locator(".inspector")
          .getByRole("button", { name: "输出", exact: true })
          .click();
        await expect(page.locator(".inspector")).toContainText('"page": 99');
        await page
          .getByLabel("本步骤的执行次数", { exact: true })
          .selectOption("1");
        await expect(page.locator(".inspector")).not.toContainText(
          '"page": 99',
        );
      }
      if (scenario === "retry")
        expect(
          detail.runs.some((r: any) =>
            r.view.attempts.some((a: any) => a.identity.attemptNumber === 2),
          ),
        ).toBe(true);
      await page
        .getByRole("button", { name: "步骤与并行任务", exact: true })
        .click();
      await expect(page.locator(".child-run").first()).toBeVisible();
      await page
        .getByRole("button", { name: "结果与报告", exact: true })
        .click();
      await expect(page.locator(".candidate-report")).toHaveCount(3);
    }
  });

test("reconnecting refreshes the history query after a network error", async ({
  page,
}) => {
  await page.goto("/#/workflows");
  await expect(
    page.getByRole("link", { name: "简历与岗位匹配", exact: true }),
  ).toBeVisible();
  await page.route("**/api/runs?**", (route) => route.abort());
  await page.getByRole("link", { name: "运行历史", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时连不上本机服务");
  await page.unroute("**/api/runs?**");
  const response = page.waitForResponse((r) => r.url().includes("/api/runs?"));
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("parallel task navigation and replay remain available in the Map example", async ({
  page,
}) => {
  await page.goto("/#/workflows/parallel-map");
  await page.getByRole("button", { name: "＋ 发起运行", exact: true }).click();
  await page.getByLabel("运行名称", { exact: true }).fill("并行任务导航验收");
  await page
    .getByRole("button", { name: "确认材料，开始运行 →", exact: true })
    .click();
  await page.waitForURL("**/#/runs/run-*");
  const id = page.url().split("/runs/")[1];
  await settled(page, id, "succeeded");
  await (await panToNode(page, "batch")).click();
  await expect(page.locator(".node-children > button")).toHaveCount(3);
  await page.locator(".node-children > button").first().click();
  await expect(page.getByLabel("查看步骤范围")).toHaveValue(/^parallel-/);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page
    .locator(".run-picker")
    .getByRole("button", { name: "并行任务组", exact: true })
    .click();
  await expect(page.locator(".node-children > button")).toHaveCount(3);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  const detail = await (await page.request.get("/api/runs/" + id)).json();
  const mainId = detail.runs.find(
    (r: any) => !r.view.runId.startsWith("parallel-"),
  ).view.runId;
  const timeline = await (
    await page.request.get(`/api/runs/${id}/history?run=${mainId}`)
  ).json();
  const active = timeline.entries.findIndex(
    (r: any) => r.snapshot.status === "parallel_wait",
  );
  expect(active).toBeGreaterThanOrEqual(0);
  await page.getByRole("slider", { name: "回放进度" }).fill(String(active));
  await page.getByRole("button", { name: "定位当前步骤", exact: true }).click();
  await expect(page.locator(".node-status.parallel_wait")).toHaveCount(1);
  await expect(page.locator(".node-children > button")).toHaveCount(3);
});
