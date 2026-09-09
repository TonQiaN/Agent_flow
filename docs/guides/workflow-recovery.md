# Workflow 恢复认领与旧资源清理

当前内置支持相同定义、契约和实际镜像的断网 Script Workflow。重新组装独立的 Catalog、ScriptExecutor 和 DockerBackend，并使用原受信 Run 存储及耐久归档；仍持有相同文件 token 的 Catalog 不能重复加载。不要把模型提供的 JSON 包装成存储输入。

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

`claimWorkflowRecovery()` 先通过原严格加载器核对历史、实际安装定义、contract 和归档/收据，建立本次独立文件引用，再以读取的 revision 执行 CAS。成功后，同一 Run 行的内容成为 `agentflow-workflow-recovery/v1`：保留原 v3 `checkpoint`，增加本次 `claimRevision` 和 `resourceRemoved`。它不会修改原 Attempt 的业务结果、执行新节点或清除取消意图。

只接受 queued/running 且没有取消意图的记录。准备、创建或启动仍为 pending 时拒绝；活动绑定缺少共同资源恢复能力或属于 Effect 时拒绝。原记录没有 Runner 资源时，资源移除条件视为无需处理；这不代表已经重启了节点。旧宿主后续的资源、操作或结果 CAS 无法覆盖新的 revision。

`cleanup()` 再次确认当前 CAS 写入权，然后由该节点实际 ScriptExecutor 的共同 Runner 句柄恢复资源身份，query、确认 stop/remove、release，最后通过 CAS 保存移除完成。查询错误不是 absent，停止或目录释放失败均不记录成功。同一句柄并发 cleanup 合并执行；查询、停止或释放失败可保留句柄重试。CAS 失败或冲突关闭该句柄的写入权，应释放其文件引用，再用新的独立组合重新检查和认领。

恢复者自身崩溃后，可以再次调用认领接口，对当前 revision 建立新的 claim。已提交的资源移除确认保留，未提交则重新经共同接口核对。两个恢复者竞争同一 revision 时仅一个能提交；后续接管会使旧句柄的迟到写入失败。已经发出的清理操作只针对不可复用的旧资源身份，不赋予旧句柄新建 Attempt 的权限。

`query()` 返回最后提交的独立副本，并非持续有效的租约。`dispose()` 等待本句柄正在进行的清理后释放本次加载的临时文件引用，不删除 Run、归档或恢复记录；清理失败时也不冒充资源已释放。尚无新 Attempt 调度接口，不能从 `resourceRemoved=true` 推导整个流程已恢复完成。

只想检查时，使用 [loadWorkflowCheckpoint](workflow-checkpoint-loading.md)：它同时接受普通 v3 检查点和上述恢复封套，返回独立的 `checkpoint` 及 `recovery` 元数据，不认领、不写库、不查询或停止容器。

已验证活宿主迟到写入、两个真实进程 CAS 竞争、恢复者在认领/清理提交前后被 SIGKILL、查询故障后再次处理。完整 A 不重跑、B 以新 Attempt 完成，以及未知 pending 操作、认证/Effect 的恢复还未验收。见 [验证记录](../validation/2026-09-10-workflow-recovery-claim.md)和[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)。
