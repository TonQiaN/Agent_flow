# CI 使用与排查

所有 PR（包括 base 为其他功能分支的 stacked PR）执行 `Check`；push 只执行 main，另提供手动入口。同一个 PR 的新提交取消旧执行。`CI required` 汇总本层所有任务，只有全部成功才通过。main 要求该检查并与 base 保持最新；平台保护配置的实际读回记录在交付 PR。

## 任务与本地对应

| 任务 | 环境与范围 | 本地命令（先 npm ci） |
| --- | --- | --- |
| Quality | Node 24，导入边界、构建、测试类型 | `npm run check:quality` |
| Unit / Node 24、26 | 无 Docker，各版本独立执行 | `npm run build && npm run test:unit` |
| Docker integration | Node 24，真实 Docker；组内文件串行 | `npm run build && AGENTFLOW_DOCKER_TESTS=1 npm run test:integration` |

本层另运行 `Workflow acceptance`：`npm run build && AGENTFLOW_STUDIO_TESTS=1 AGENTFLOW_DOCKER_TESTS=1 npm run test:workflows`，须先构建 `src/apps/studio/docker/Dockerfile.documents` 为 `agentflow/studio-documents:issue39`。该组验证材料解析、招聘真实流程与归档，不使用真实模型密钥。

显式准备 Alpine 3 和 Node 22 Bookworm slim。原生 Harness、网络策略及真实模型仍使用各自显式环境；此次没有扩大原来的跳过范围，也没有把这些项目列为通过。上层功能 PR 添加工作流及浏览器任务时，必须同时加入 `needs` 和 gate 的预期任务列表。

## 看懂一次失败

每个 job 上传独立工件，名称包括 run ID、attempt、任务与 Node 版本，保留 14 天。失败重跑产生新工件，不能覆盖最初失败：

- `environment.json`：实际 checkout SHA、PR head/base、Node、运行与重试身份。
- `stages.ndjson`、阶段 stdout/stderr：安装、镜像、构建、测试的开始、结束、耗时及退出码；每个输出通道最多 8 MiB。
- `unit.xml` / `integration.xml`：JUnit 结果；对应 NDJSON 即时记录测试进入执行、完成、失败、输出与时间，进程中断时仍能找到最后的测试。
- `docker-state.ndjson`：每 15 秒及结束时的容器名称、状态。只读取状态，不上传完整 inspect、环境变量或私有凭据。
- `runner-resource/`：恢复测试的准备、IPC、子进程输出和退出；同名容器所有权冲突测试另记录创建、恢复、查询、清理和超时发生的阶段。

本地也可收集：`AGENTFLOW_CI_DOCKER=1 node src/tooling/ci/stage.mjs integration -- npm run test:integration`（另启用 Docker 测试开关）。诊断写入忽略目录 `.local/ci`，CI 只使用合成数据，不将生产模型凭据传入任务。取消整个 runner 或平台故障可能使末尾工件无法上传，GitHub 流式日志仍是证据之一。

失败后先保存原始工件，再定位阶段与断言；必要时只重跑失败 job。同 SHA 重跑通过不能证明此前的超时已修复。`CI required` 的自动测试还包含故意超时的子测试，用来验证非零退出、原始输出、时间和超时事件确实能保存。

参考：Blackbox Agent Flow `4dc0f4a` 的 PR/main/manual 触发与串行集成安排；该 Python 系统的测试不替代本项目 Docker 持久恢复验证。GitHub [PR 触发规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) 和 [required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) 为平台行为依据。

## 浏览器与截图基准

前端层增加两个必需任务：`Browser journeys` 运行真实本机服务、引擎和文档容器；`Screenshot comparison` 比较固定显示素材的页面。两者均不重试，失败时保留 trace、JUnit、HTML 报告与截图。前者验证上传、运行、回放等行为，后者发现布局、字体、连线、遮挡及时间信息的视觉变化。

截图统一在固定 digest 的 Playwright 1.63.0 Noble **linux/amd64** 镜像中执行（含 Chromium 与字体），Mac 与 CI 使用同一命令。窗口 1453×874 / 731×911，时区 Asia/Singapore、中文语言、固定时间、关闭动画，像素色差阈值 0.2、允许最多 80 个不同像素。整个页面不遮罩时间或节点信息。合成显示素材经过真实 Workflow、SQLite 历史和产物读取；模型推理的正确性仍由其他验收负责。

```sh
npm run studio:visual
# 只有设计变化已核对后才更新；CI 禁止此操作
npm run studio:visual -- --update-snapshots
# 故意添加明显样式变化，应失败并生成 expected / actual / diff
npm run studio:visual -- --negative-control
```

无需先安装 npm 依赖，需 Docker；脚本复制当前 Git 跟踪及未忽略的源文件到临时目录，在容器内按锁文件安装/构建。隔离测试数据只能写入 `studio-visual-tests`，不会使用本机真实运行历史。比较时基准目录只读；缺图会失败，不能在 CI 自动创建“通过”的新基准。

基准在 `src/tests/browser/__screenshots__/visual/` 入库。覆盖工作流列表、宽/窄画布、容器详情、一次上传、已完成运行、回放、节点时间、招聘二元结果、其他工作流结果、按节点分组的代码与多页 PDF。修改 UI 后先看实际图和差异；合理变化再显式更新并将 PNG 与代码一同审查，不能把“更新后通过”作为页面正确的证据。

产物分别保存在 `.local/visual-comparison/`、`.local/visual-baseline-update/`、`.local/visual-negative/`，含镜像版本、测试报告、trace 和差异 PNG。运行 `npx playwright show-report .local/visual-comparison/playwright-report` 查看；CI 从带 run/attempt 的 visual 工件下载。截图测试输入与本地 `materials/` 用户报告分别管理。升级 Playwright 时必须同步镜像 digest 并重新审查全部基准，版本不匹配会直接失败。

依据：[Playwright 截图比较](https://playwright.dev/docs/test-snapshots)要求在一致环境生成与比较基准；[Docker 文档](https://playwright.dev/docs/docker)说明镜像和测试包版本需匹配。
