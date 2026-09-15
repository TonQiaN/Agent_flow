import { test, expect, type Page } from "@playwright/test";
import { resolve, join } from "node:path";
import { readdir, rename } from "node:fs/promises";
const fixtures = resolve("src/examples/recruitment/fixtures");
async function launch(page: Page, scenario = "normal") {
  await page.goto("/#/workflows/recruitment");
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
  let latest: any;
  await expect
    .poll(
      async () => {
        latest = await (await page.request.get("/api/runs/" + id, { maxRetries: 2 })).json();
        const current = latest.runs.find(
          (r: any) => !r.view.runId.startsWith("parallel-"),
        )?.view.snapshot.status;
        return (
          !!latest.completion ||
          ["succeeded", "failed", "cancelled", "exhausted"].includes(current)
        );
      },
      { timeout: 150000, intervals: [1000] },
    )
    .toBe(true);
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
  const pdf = page.locator(".pdf-preview canvas");
  await expect(pdf).toHaveAttribute("data-ready", "true");
  await page.getByText("查看本页文字", { exact: true }).click();
  await expect(page.locator(".pdf-text")).toContainText("推荐通过");
  const download = page.getByRole("link", { name: "下载文件 ↓", exact: true });
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
  await page.locator('.react-flow__node[data-id="parse"]').click();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "输入", exact: true })
    .click();
  await expect(page.locator(".inspector")).toContainText("document-0.md");
  const current = await (await page.request.get("/api/runs/" + id, { maxRetries: 2 })).json();
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
  const unchanged = await (await page.request.get("/api/runs/" + id, { maxRetries: 2 })).json();
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
  // A missing immutable archive must remain visible as missing, not silently vanish.
  const archiveRoot = resolve(
    ".local/studio-browser-tests/runs",
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

for (const scenario of ["rework", "retry", "failure", "cancel"])
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
    if (scenario === "failure" || scenario === "cancel") {
      await page
        .getByRole("button", { name: "结果与报告", exact: true })
        .click();
      await expect(page.locator(".candidate-report")).toHaveCount(0);
      await expect(page.locator(".panel")).toContainText(
        "不等于候选人被判不通过",
      );
    } else {
      const detail = await (await page.request.get("/api/runs/" + id, { maxRetries: 2 })).json();
      if (scenario === "rework")
        expect(
          detail.runs
            .find((r: any) => !r.view.runId.startsWith("parallel-"))
            .view.snapshot.steps.filter((s: any) => s.node === "evidence-gate"),
        ).toHaveLength(2);
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
