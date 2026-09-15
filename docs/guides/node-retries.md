# 节点有限重试

节点配置可增加 `retry`。默认不自动重试已失败执行；启用后使用持久执行接口及 [NodeTask 队列](node-queue.md)。配置属于 Workflow 节点，Adapter、Runner 和 Component 不选择重试或返修策略。

```ts
nodes: {
  mark: {
    component: 'marker',
    retry: { maxAttempts: 3, on: ['timeout', 'execution_failure', 'interrupted'], delayMs: 1000 }
  }
}
```

`maxAttempts` 包含首次执行，范围 1–100；`delayMs` 是 0–86400000 毫秒的固定间隔。`on` 必须是不重复的已知类别，可为空。Workflow 编译时拒绝无效配置，持久加载核对当前安装的完整定义，不能通过更改配置重置已存在 Run 的预算。

| 类别 | 当前可信错误码 |
| --- | --- |
| timeout | EXECUTION_TIMEOUT，文件 Catalog 从实际 Runner 超时事实识别 |
| execution_failure | SCRIPT_EXECUTION_FAILED、EXECUTION_NOT_SUCCESSFUL、HARNESS_NOT_SUCCESSFUL、IMPLEMENTATION_FAILED、FILE_NODE_EXECUTION_FAILED |
| interrupted | ATTEMPT_INTERRUPTED，由共同恢复确认旧执行已清理后生成 |

文件 Workflow 的超时码也影响未配置重试的调用：实际 Runner 为 `timed_out` 时统一返回 `EXECUTION_TIMEOUT`，替代此前的 `SCRIPT_EXECUTION_FAILED`（Script）或 `EXECUTION_NOT_SUCCESSFUL`（Agent）。依赖旧错误码的调用者应更新判断；其他失败码不变，未配置策略仍只执行一次。Runner / ScriptExecutor / AgentExecutor 的原始执行事实保留。

仅匹配结构化错误码。契约不合格、取消、明确认证配置错误、未知错误和未知 Effect 结果不匹配。Agent 自由文本不参与判断。业务 `outcome` 仍通过用户路由进入返修节点，不占原 NodeTask 的重试预算。

## 执行与等待

每次执行先登记同一 NodeTask 下的新 Attempt，再调用执行器。失败被允许重试且确认停止后，内置文件 Catalog 清理本次执行，运行记录保存失败结果、类别、决定时间与到期时间；游标继续指向本节点的原定输入。失败文件不会成为已接纳产物，新的工作目录与输出目录不会继承失败目录。

`WorkflowSnapshot.status` 为 `retry_wait` 时，`retry` 给出 NodeTask、已使用的尝试序号、错误码和 `nextAt`。完整失败结果在检查点的 `attempts[].retry.result`，成功路由步骤仍在 `steps`。原定到期时间不会因队列重开而改写。

队列在同一条件事务中将该任务置回 ready，清空 owner 并保存 `notBefore`。Worker 返回 `waiting: 'RETRY_WAIT'`，释放本轮凭据并继续处理其他任务；不会睡眠等待整个重试间隔。到期后仍正常核对角色、Harness 和凭据容量。新领取先封存旧认证令牌，防止迟到占用。调用 `queue.cancelReady(runId)` 可取消等待中的 Run。

一般使用 `preparePersisted` 与 Worker。手工使用 `startPersisted` 时，completion 也会在 `retry_wait` 返回；应用在到期后通过正常 `claimWorkflowRecovery → cleanup → 新 WorkflowRuntime.resumePersisted` 继续。过早调用返回 `RETRY_NOT_DUE`，运行器不内置定时服务。测试使用可注入的 `WorkflowRuntime({ now })`，应与队列采用相同时间基准。非持久 `start` 遇到重试策略时返回 `RETRY_REQUIRES_PERSISTENCE`。

## 恢复与边界

中断首先走 [共同恢复](workflow-recovery.md)，确认旧资源停止/移除并完成凭据收尾，之后才能决定是否等待新 Attempt。启动不明、凭据操作不明不会被当成未使用次数。最大三次时，第二次中断后最多再执行第三次；第三次中断后以 `ATTEMPT_BUDGET_EXHAUSTED` 结束。正常失败耗尽预算时保留其原错误码，尝试历史说明已用次数。

无策略的节点不自动重试失败执行；既有显式中断恢复接口仍可由宿主调用。有策略的节点，其显式恢复同样受累计预算和允许类别约束。

Effect 沿用固定操作键、当前输入校验和当前授权。pending 或结果未知的操作在共同恢复入口阻塞；已保存可靠回执可由后续获授权的 Attempt 复用，不能因重试而重复发送。当前没有复杂退避、替换 Agent/账户、分布式调度或历史迁移功能。

验证见 [#15 作者验收](../validation/2026-09-10-node-retries.md)。设计依据 [P-20260910-node-retries](../../.agents/decisions/product/README.md#p-20260910-node-retries)。
