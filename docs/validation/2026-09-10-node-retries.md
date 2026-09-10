# 节点重试与持久等待：作者验收

日期：2026-09-10。范围：[Issue #15](https://github.com/TonQiaN/Agent_flow/issues/15)，本地基线 ab9551c 后的重试实现。主责 @xiaoxuanli-a，Codex 实施和作者验证；没有其他开发者独立审阅，未提交或合并本项 PR，Issue 保持开放。

预检核对已确认 Issue、当前流程和依赖，先查 Blackbox v0.1.22 / 5610d1b 节点循环、调度等待及 Effect 恢复经验。新实现由已保存 Attempt 计算预算，不复制旧局部循环的预算重置行为。决定见 [P-20260910-node-retries](../../.agents/decisions/product/README.md#p-20260910-node-retries)，当前用法见 [指南](../guides/node-retries.md)。

## 验收对照

| Issue 要求 | 实现与证据 | 本地结论 |
| --- | --- | --- |
| 默认与配置 | 策略纯函数与编译入口校验；默认一次、未知类别/参数拒绝、取消/未知错误不匹配；小数毫秒时钟可用 | 通过 |
| 任务身份 | 队列重试依次记录 task-1 的 Attempt 1/2/3；Agent A 只接纳一次，B 在 task-2 重试；原 Workflow 业务路由/返修回归通过 | 通过 |
| 输入隔离 | 真实 Docker 每次读取 seed、确认没有上次失败文件，随后修改输入并写失败文件；宿主原文件仍为 seed，values 只有原输入；Agent 不接纳失败 B 的输出 | 通过 |
| 持久预算 | 真实 Worker 在第二次与第三次 start_completed 后分别 SIGKILL；清理后最多 Attempt 3，没有 Attempt 4；重复旧领取写入被拒绝 | 通过 |
| 等待与容量 | SQLite 重开保持原 nextAt；过早队列领取和手工 resume 都不执行；等待 owner 为空，其他 Run 能使用角色；真实 Agent 等待时可取得原认证源管理租约 | 通过 |
| 取消与旧执行 | 取消等待后重开与时间推进不再执行；停止不明的结构化失败不重试、仍阻塞 Worker；中断容器确认移除后才保存等待 | 通过 |
| 耗尽与错误 | 第三次失败保持原失败码；第三次中断恢复报告 ATTEMPT_BUDGET_EXHAUSTED；没有业务 outcome、自动换账户或隐式 Fixer | 通过 |
| Effect | 实际 EffectExecutor、SQLite 操作日志及合成外部文件；已发生但无回执的操作多次恢复均阻塞，可靠回执由新的当前授权复用，外部总写入未增加；身份/输入冲突原测试回归通过 | 通过 |
| 解耦与交付 | 策略不导入容器/认证；引擎持有运行事实，队列同事务消费等待；决定、指南、版本规划已更新 | 本地作者验收通过，PR/独立审阅/合并仍待完成 |

原认证刷新与资源恢复端口保持不变，重试不复制历史凭据覆盖来源。原订阅和源生命周期普通测试回归通过；本次新增的真实 Agent 重试组合使用 DeepSeek API key 协议替身，未新增真实订阅刷新实验。

## 执行结果与复现

环境为 macOS、Node v26.0.0、本地 Docker。全部输入、协议和凭据为合成夹具，没有真实学生材料、生产发布或收费模型调用。

- 最终构建、测试类型检查、包依赖检查通过。
- 最终全部普通测试 **385/385 通过，14.27 秒**，包括 6 项重试策略/队列测试、新增 Effect 重试核对、原恢复/认证/业务路由回归和 4 项依赖边界测试。
- 最终新增 Docker/Agent 重试组合 **3/3 通过，24.30 秒**：第二次中断、第三次中断、实际 Agent 的失败重试/源释放。
- 文档本地路径链接与 `git diff --check` 在提交前核对。

```sh
npm run build
npm run typecheck:tests
npm run check:boundaries
node --import tsx --test src/packages/integrations/queue/retry.test.ts src/packages/integrations/persistence/effect-workflow.test.ts
AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_DOCKER_TESTS=1 node --import tsx --test --test-concurrency=1 --test-name-pattern='queued actual Agent retry|durable Docker retry' src/tests/e2e/agent-workflow.test.ts src/tests/e2e/retry.test.ts
```

普通全量按 `src/tooling/run-tests.mjs` 的普通测试发现规则执行，包含 `.test.ts` 和 `.test.mjs`，并发上限 4；Docker 组合串行运行。测试源码和合成夹具随实现提交，不依赖临时日志才能复现。

## 发现与修正

初次真实 Agent 重试没有进入等待：映射表用了未被当前 AgentExecutor 返回的 RUNNER_NOT_SUCCESSFUL，而实际码是 EXECUTION_NOT_SUCCESSFUL。核对现有执行器后修正映射，保留原失败断言；实际 Agent 与两个 Docker 中断场景全部复验通过。

等待只保留当前尚需封存的认证领取令牌；较早令牌已在本次准入阶段封存，避免合法的多次尝试累积触及队列的历史令牌上限。凭据值不进入调度索引。

## 未完成范围

本地作者验收不等于远端交付。本项尚无独立 PR 审阅或 CI 的 Node 24 证据；没有物理断电实验、旧开发检查点迁移或分布式调度。#16、真实模型矩阵及最终真实学生批卷、报告和 PDF 仍在总任务内，不能以这些合成测试替代。

## 短栈交付前复核

切片98c6f56同步当前队列PR #29；构建、测试类型及包边界通过，全部普通测试385通过、0失败、0跳过（14.81秒）。实际Agent重试及Attempt2/3被SIGKILL的三项Docker检查通过、0跳过（24.75秒），确认等待释放认证占用、预算不因恢复重置、已接纳A不重跑及原始输入不变。之后继承的CI镜像准备和文档同步不改变产品行为。按最多三个未合并功能PR的约定，本切片暂留本地，待当前短栈推进后独立提交与审阅。


## 当前队列基线上的完整复核

以队列 30203e9 为 base、重试 8877dc6 为实现提交审读全部 29 个差异文件及原有调用者。运行记录仍为唯一业务事实，重试判断是纯函数，队列消费已保存 nextAt；未新增后台定时器、策略脚本或凭据选择。记录加载重算允许类别及预算，拒绝篡改等待时间、身份或停止事实。Effect 当前授权和未知结果保护仍在原端口处理。

当前构建、测试类型、依赖边界与 npm run check 通过：普通 383 项全部通过、零跳过（22.22 秒）；默认 E2E 17 通过、167 跳过（11.21 秒）。随后显式启用三个实际 Docker 重试验收，3 项全部通过、零跳过（26.30 秒）：Agent 失败后源释放及保留 A、Attempt 2/3 中断后最多第三次、原始输入和独立目录。合成协议/凭据没有替代官方模型或登录验证。

同一程序在当前 base/head 的普通、持久和队列入口运行，有效及无效输入的最终 snapshot、持久检查点与队列结果完全一致，没有 retry 字段或额外尝试。另以实际 AgentExecutor 和 FileWorkflowCatalog 配合同一合成 Driver，分别提供 timed_out 和非零退出事实：无策略时两版本都只调用一次；非零退出仍为 EXECUTION_NOT_SUCCESSFUL，而超时从 EXECUTION_NOT_SUCCESSFUL 变为 EXECUTION_TIMEOUT。此为共有执行适配的实际变化，现已在决定、指南与 CHANGELOG 明确披露；不能把“默认不自动重试”写成“所有普通错误码完全不变”。Script 的同类映射已与对应失败分支核对。

上述测试之后仅补充错误码说明，生产及测试文件未变；结果保留执行时的提交身份，不冒充新源码重跑。后续 PR 描述和本地审查包按最终提交核对。没有远端重试 PR、独立批准或 Node 24 CI；按既定最多三个未合并功能 PR 的顺序等待现有短栈推进，完整交付后再关闭 #15。
