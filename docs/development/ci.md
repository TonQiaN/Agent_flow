# CI 使用与排查

开发期间优先在本地检查；云端 `Check` 只由 PR 和手动入口触发。所有 PR（包括 Draft 和 base 为其他功能分支的 stacked PR）在创建、重开及代码更新时执行完整检查，同一个 PR 的新提交取消旧执行。普通分支和 main 的 push 均不单独触发；推送到已有 PR 的分支仍会触发 PR 检查。`CI required` 汇总本层所有任务，只有全部成功才通过。main 要求该检查并与 base 保持最新；平台保护配置的实际读回记录在交付 PR。

## 本地开发与云端验收

| 阶段 | 执行与结果 |
| --- | --- |
| 日常修改、调试 | 本地运行受影响的检查与测试，先定位、修复失败再推送；基础检查入口为 `npm run check` |
| 准备 PR | 完成与改动范围相称的本地验证；运行完整矩阵时使用下述 Linux/Docker 环境和全部实际检查组。纯文档或仅触发条件变更可记录相应的配置、链接及差异检查，不将未运行的产品测试写成通过 |
| PR 创建、重开、代码更新 | 云端运行全部既有检查，最新提交的 `CI required` 是合并门槛 |
| 合并到 main 后 | 读回合并提交与内容；不自动重跑完整 CI，需要独立复验时从 Actions 的 `Run workflow` 手动触发 |

本地检查复用现有 npm 命令，不需要注册自托管 Actions runner。本地成功不会回填 GitHub 检查。取消 main 自动重跑后，所有 main 改动仍需经过 PR，合并前同步目标分支并通过最新检查；不再自动验证实际合并提交是本次明确保留的限制。触发和分工取舍见[源码结构决定](../../.agents/decisions/development/README.md#d-20260909-source-layout)与[开发流程决定](../../.agents/decisions/development/README.md#d-20260907-development-workflow)。

## 任务与本地对应

| 任务 | 环境与范围 | 本地命令（先 npm ci） |
| --- | --- | --- |
| Quality | Node 24，导入边界、构建、测试类型 | `npm run check:quality` |
| Unit / Node 24、26 | 无 Docker，各版本独立执行 | `npm run build && npm run test:unit` |
| Docker integration | Node 24，真实 Docker；组内文件串行 | `npm run build && AGENTFLOW_DOCKER_TESTS=1 npm run test:integration` |
| Workflow acceptance | Node 24，真实文档容器与合成模型结果 | `npm run build && AGENTFLOW_STUDIO_TESTS=1 AGENTFLOW_DOCKER_TESTS=1 npm run test:workflows` |
| Browser journeys | Node 24，Chromium、真实服务、引擎与文档容器 | `npm run studio:test` |
| Screenshot comparison | 固定 Linux amd64 / Playwright 镜像 | `npm run studio:visual` |

`npm run check` 默认没有开启全部环境测试，也不会执行两个 Node 版本及 Playwright 全部任务，不能单独作为“完整本地 CI”证据。完整本地验证按以下顺序执行，在每一步确认成功后再继续：

1. 在 Linux 环境选择 Node 24，执行 `npm ci`、`npm run check:quality`，再执行表中的单元测试命令。
2. 准备可用的 Docker daemon 和下述镜像、Chromium。使用 Node 24，依次执行表中的 Docker integration、Workflow acceptance、Browser journeys 命令，保留对应的环境开关；共用 Docker daemon 的这些组不要并行启动。
3. 执行 Screenshot comparison；继续使用脚本固定的 Linux amd64 镜像，不在宿主环境更新截图基准。
4. 切换到 Node 26，重新执行 `npm ci`，再执行表中的单元测试命令。记录实际 Node 版本，不把单一版本成功视作双版本通过。

第 2 步的准备命令（在 Linux / Node 24 环境运行）：

```sh
docker pull alpine:3
docker pull node:22-bookworm-slim
docker build -f src/apps/studio/docker/Dockerfile.documents -t agentflow/studio-documents:issue39 .
npx playwright install --with-deps chromium
```

本地没有对应 Linux、Node 版本或 Docker 环境时，如实记录未运行项目并在需要完整验证时补齐；macOS 基础检查不能替代 Linux 结果。当前提交、各组结果及环境跳过记录在 PR 中，保留失败证据。原生 Harness、真实账号及模型组合继续按任务范围单独验收，不属于上述云端合成矩阵的通过结论。

工作流验收组验证材料解析、招聘真实流程与归档，不使用真实模型密钥。以后新增实际检查组时，必须同时加入 `needs` 和 gate 的预期任务列表。

## 看懂一次失败

每个 job 上传独立工件，名称包括 run ID、attempt、任务与 Node 版本，保留 14 天。失败重跑产生新工件，不能覆盖最初失败：

- `environment.json`：实际 checkout SHA、PR head/base、Node、运行与重试身份。
- `stages.ndjson`、阶段 stdout/stderr：安装、镜像、构建、测试的开始、结束、耗时及退出码；每个输出通道最多 8 MiB。
- `unit.xml` / `integration.xml`：JUnit 结果；对应 NDJSON 即时记录测试进入执行、完成、失败、输出与时间，进程中断时仍能找到最后的测试。
- `docker-state.ndjson`：每 15 秒及结束时的容器名称、状态。只读取状态，不上传完整 inspect、环境变量或私有凭据。
- `runner-resource/`：恢复测试的准备、IPC、子进程输出和退出；同名容器所有权冲突测试另记录创建、恢复、查询、清理和超时发生的阶段。

本地也可收集：`AGENTFLOW_CI_DOCKER=1 node src/tooling/ci/stage.mjs integration -- npm run test:integration`（另启用 Docker 测试开关）。诊断写入忽略目录 `.local/ci`，CI 只使用合成数据，不将生产模型凭据传入任务。取消整个 runner 或平台故障可能使末尾工件无法上传，GitHub 流式日志仍是证据之一。

失败后先保存原始工件，再定位阶段与断言；必要时只重跑失败 job。同 SHA 重跑通过不能证明此前的超时已修复。`CI required` 的自动测试还包含故意超时的子测试，用来验证非零退出、原始输出、时间和超时事件确实能保存。

最初的串行集成安排参考 Blackbox Agent Flow `4dc0f4a`；该 Python 系统的测试不替代本项目 Docker 持久恢复验证。当前 PR/manual 触发分工由 [Issue #48](https://github.com/TonQiaN/Agent_flow/issues/48) 确认。GitHub [PR 触发规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) 和 [required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) 为平台行为依据。

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
