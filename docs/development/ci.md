# CI 使用与排查

所有 PR（包括 base 为其他功能分支的 stacked PR）执行 `Check`；push 只执行 main，另提供手动入口。同一个 PR 的新提交取消旧执行。`CI required` 汇总本层所有任务，只有全部成功才通过。main 要求该检查并与 base 保持最新；平台保护配置的实际读回记录在交付 PR。

## 任务与本地对应

| 任务 | 环境与范围 | 本地命令（先 npm ci） |
| --- | --- | --- |
| Quality | Node 24，导入边界、构建、测试类型 | `npm run check:quality` |
| Unit / Node 24、26 | 无 Docker，各版本独立执行 | `npm run build && npm run test:unit` |
| Docker integration | Node 24，真实 Docker；组内文件串行 | `npm run build && AGENTFLOW_DOCKER_TESTS=1 npm run test:integration` |

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
