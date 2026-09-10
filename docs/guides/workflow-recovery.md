# Workflow 恢复执行

当前内置支持相同定义、契约和实际镜像的无私有认证 Script Workflow（断网或 CONNECT），以及不可变环境 API key 的 Agent Workflow（DeepSeek 合成验证，见[阶段指南](workflow-phases.md)）。重新组装独立的 Catalog、ScriptExecutor 和 DockerBackend，并使用原受信 Run 存储及耐久归档；仍持有相同文件 token 的 Catalog 不能重复加载。不要把模型提供的 JSON 包装成存储输入。

```ts
import { claimWorkflowRecovery } from '@agentflow/engine';

const recovery = await claimWorkflowRecovery(compiled, runId, runStore);
try {
  const progress = await recovery.cleanup();
  console.log(progress.resourceRemoved);
} finally {
  await recovery.dispose();
}
```

`claimWorkflowRecovery()` 先通过原严格加载器核对历史、实际安装定义、contract 和归档/收据，建立本次独立文件引用，再以读取的 revision 执行 CAS。成功后，同一 Run 行的内容成为 `agentflow-workflow-recovery/v1`：保留原 v5 `checkpoint`，增加本次 `claimRevision` 和 `resourceRemoved`。它不会修改原 Attempt 的业务结果、执行新节点或清除取消意图。

只接受 queued/running 且没有取消意图的记录。准备、创建或启动仍为 pending 时拒绝；活动绑定必须具备共同资源恢复能力，或具备下述 Effect/确定性 JSON 的显式无资源恢复检查。原记录没有 Runner 资源时，资源移除条件视为无需处理；这不代表已经重启了节点。旧宿主后续的资源、操作或结果 CAS 无法覆盖新的 revision。

`cleanup()` 再次确认当前 CAS 写入权，然后由该节点实际 ScriptExecutor 的共同 Runner 句柄恢复资源身份，query、确认 stop/remove、release，最后通过 CAS 保存移除完成。查询错误不是 absent，停止或目录释放失败均不记录成功。同一句柄并发 cleanup 合并执行；查询、停止或释放失败可保留句柄重试。CAS 失败或冲突关闭该句柄的写入权，应释放其文件引用，再用新的独立组合重新检查和认领。

恢复者自身崩溃后，可以再次调用认领接口，对当前 revision 建立新的 claim。已提交的资源移除确认保留，未提交则重新经共同接口核对。两个恢复者竞争同一 revision 时仅一个能提交；后续接管会使旧句柄的迟到写入失败。已经发出的清理操作只针对不可复用的旧资源身份，不赋予旧句柄新建 Attempt 的权限。

`query()` 返回最后提交的独立副本，并非持续有效的租约。`dispose()` 等待本句柄正在进行的清理后释放本次加载的临时文件引用，不删除 Run、归档或恢复记录；清理失败时也不冒充资源已释放。交接前由此句柄负责临时引用；交接给 resumePersisted 后，释放责任转到恢复运行句柄，原 recovery.dispose() 不会提前撤销输入。resourceRemoved=true 只代表旧资源收尾完成。

只想检查时，使用 [loadWorkflowCheckpoint](workflow-checkpoint-loading.md)：它同时接受普通 v5 检查点和上述恢复封套，返回独立的 `checkpoint` 及 `recovery` 元数据，不认领、不写库、不查询或停止容器。

已验证活宿主迟到写入、两个真实进程 CAS 竞争、恢复者在认领/清理提交前后被 SIGKILL、查询故障后再次处理。断网 Docker 脚本还通过一次和连续两次 SIGKILL 后完整恢复：A 不重跑，旧 B 清理后在同一 NodeTask 上以第 2/3 次 Attempt 完成。未知 pending 操作继续拒绝；订阅及完整 #13 仍未整体验收。见 [验证记录](../validation/2026-09-10-workflow-recovery-claim.md)和[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)。

## 继续正常执行

```ts
import { WorkflowRuntime } from '@agentflow/engine';

const recovery = await claimWorkflowRecovery(compiled, runId, store);
let resumed;
try {
  await recovery.cleanup();
  resumed = await new WorkflowRuntime().resumePersisted(recovery);
  const result = await resumed.completion;
  // 在 dispose 之前检查或物化结果；新输出仍按 Catalog 的常规接口释放。
} finally {
  await resumed?.dispose();
  await recovery.dispose();
}
```

resumePersisted 只接受实际认领句柄，并一次性移交 compiled、RunStore、最新 revision 和恢复文件引用。复制句柄、query JSON、重复消费拒绝；资源清理未完成或仍在进行时也不能交接。首次 CAS 成功后进入原 Workflow 检查、调用、接纳、路由循环，冲突不能调用新节点。同一 Runtime 已有该 Run 时拒绝，不覆盖其运行句柄。

v5 的 attempts 增加 interrupted。中断的旧 Attempt 保留原身份、资源和 launch，resultStep 仍为 null；新 Attempt 在同一 NodeTask 上递增编号。只有记录业务结果才推进 steps，用户路由再次进入节点才创建新 NodeTask；恢复不额外消耗 maxSteps 或路由次数。刚写入 interrupted、尚未创建新 Attempt 又崩溃，也保留下一未使用编号。

恢复运行的 cancel 仍等待取消意图持久化，completion 用于确认执行收尾。resumed.dispose() 等待 completion 结束后释放继承的临时输入/前序输出引用，可重复调用；耐久归档和 Run 不被删除。新产生的输出按普通运行规则由调用者释放。交接失败时自动回滚继承引用；若收尾失败，保留 WorkflowRestoreError.dispose 继续清理。

只支持当前可核对的实际执行绑定；v1/v2/v3/v4 是未发布的试验格式，拒绝自动迁移。完整证据和剩余缺口见[新 Attempt 验证](../validation/2026-09-10-workflow-resume.md)。

无私有认证的 CONNECT Script 也可通过同一入口恢复。确认旧任务容器、代理、内外网络全部移除后，才提交 resourceRemoved 并创建新 Attempt；联网模式已通过一次/连续两次宿主 SIGKILL 的 A 保留、B 恢复验证。未知 pending 操作仍拒绝自动接管；不可变 API key 的 Agent 阶段与文件收据已贯通；订阅占用仍未接通。见[联网恢复](../validation/2026-09-10-network-resource-recovery.md)。

多阶段 executor 的恢复逐一经 restorePhaseResource 恢复该 Attempt 中已经保存的资源，按声明的反向顺序清理；所有资源确认移除并释放后才提交 resourceRemoved=true。部分失败保留 false，后续可重新核对已移除的资源。活动 operation 或任一 pending launch 拒绝认领；各阶段进度不增加业务 steps。详见[阶段指南](workflow-phases.md)。

固定操作的 apply Effect 可通过实际操作日志执行只读恢复准入检查。pending 在 Run 认领前阻塞；已保存回执或无占位时才进入共同 CAS/正常新 Attempt 路径，唯一占位继续防止迟到宿主重复 apply，正常执行仍需当前授权。它不走 Docker 清理或恢复旧服务会话，见[Effect 指南](workflow-effects.md#固定操作的持久-workflow)。

显式登记的确定性 JSON Gate/Transform 可在无资源、无阶段时通过同一入口恢复。当前安装版本及配置须完全匹配，已接纳节点保留，未接纳计算在新 Attempt 重算。原宿主可能仍在计算，迟到结果由 CAS 拒绝；此约定要求无外部副作用，见[确定性函数指南](deterministic-functions.md)。
