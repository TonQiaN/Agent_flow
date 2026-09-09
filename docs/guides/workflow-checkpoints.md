# Workflow 检查点写入

`WorkflowRuntime.startPersisted(compiled, runId, input, store)` 在现有串行执行路径上保存正常运行事实。当前内置组合支持断网 Docker 脚本；它提供检查点写入和异步取消确认，尚未提供重启执行或 resume 入口。

## 组装

给 FileWorkflowCatalog 显式提供独立归档，然后照常注册脚本、编译并准备文件输入：

```ts
const archive = new FileArtifactArchive(archiveRoot, contracts);
const files = new FileWorkflowCatalog(contracts, temporaryArtifacts, workRoot, archive);
// 使用 files.registerScript 注册实际脚本，再 compileWorkflow。
const input = await files.prepareInput(runId, sourcePath, inputContract);
const store = await SqliteRunRecordStore.open(databaseRoot);
const runtime = new WorkflowRuntime();
const handle = await runtime.startPersisted(compiled, runId, input, store);
try {
  const result = await handle.completion;
  // result 表示此次执行及检查点写入的最终结果。
} finally {
  store.close();
}
```

启动先核对实际执行绑定、归档初始输入，并成功创建 Run 记录，之后才返回句柄并进入节点执行。相同 runId 已有数据库记录时不会覆盖原记录。归档与数据库目录必须满足各自私有目录要求；归档不可替代临时 ArtifactStore。持久写入所需描述或文件保存能力缺失时拒绝启动，不悄悄退回进程内运行。

普通 `start` 及其同步 `cancel` 保持原入口。持久句柄的 `await handle.cancel()`（或 `runtime.cancelPersisted(runId)`）在取消意图成功提交后返回 true；它不代表旧任务已停止，仍应等 completion。初始输入和 Run 创建尚未完成时，直接调用 runtime.cancelPersisted 会返回 PERSISTENT_RUN_NOT_READY，防止取消抢先提交缺少初始值的记录。对持久 Run 调用同步 `runtime.cancel` 会拒绝，避免确认一个尚未落盘的取消。查询返回当前进程的实时视图；检查提交完成应等待 completion 或读取 Run 记录。

## 提交顺序和内容

节点调用前先保存当前 NodeTask/Attempt 身份。输出经原有身份、停止、outcome 和 contract 检查后，由实际 executor 的 checkpointValue 端口生成耐久值记录，随后把结果接纳、路由计数和后继位置一起通过一次 CAS 提交，成功后才调度后继。没有第二套持久化专用路由引擎。

`WorkflowCheckpoint` 保存版本标记、实际执行定义、WorkflowSnapshot、当前节点/值/路由计数及初始输入和每个已接纳输出的值记录。JSON 值保存独立副本；文件值保存原关联 token、contract、摘要清单、归档引用和来自实际 FileWorkflowCatalog 的来源收据。文件 token 本身仍是进程内引用，只有相应耐久数据才提供重启后的内容证据；不能把旧 token 直接交给新 Catalog 执行。

文件保存先使用临时存储原有物化能力核对内容，再进入独立归档，并检查归档清单与原始接纳清单一致；文件复制和归档均不在 SQLite 事务中。归档成功而 CAS 失败可能留下未引用文件，首期不自动 GC。原文件、临时快照和 Run 归档各自独立，临时引用释放不会删除归档。

一次存储失败或 revision 冲突会使该写入队列拒绝后续写入，completion 拒绝，不能跨过失败的接纳继续调用下一节点。最终成功记录提交失败时，实时查询也变为 WORKFLOW_PERSISTENCE_FAILED。输出归档失败可保存为 WORKFLOW_VALUE_PERSISTENCE_FAILED；该输出不进入已接纳步骤。完整 Run JSON 仍受存储层 16 MiB 限制，超限不能截断历史后成功。

## 尚未完成的恢复边界

当前保存的是正常执行的已结束步骤和当前活动身份；中断后追加旧 Attempt 结果、同 NodeTask 的新 Attempt、文件引用与收据重新建立进程内关联、严格加载完整检查点、跨进程恢复竞争以及 Runner 资源身份持久化/query/stop 均继续实现。没有将任意保存 JSON 转成执行器或可信接纳接口，也没有提供宽松的文件收据导入方法。

真实 SIGKILL 验证已经证明已接纳文件在删除原输入/临时目录后仍可由新进程物化，也证明宿主死亡时 B 容器可以仍运行；这还不是“A 不重跑、旧 B 停止后用新 Attempt 完成”的完整恢复验收。Agent/函数/Effect/联网绑定和认证接管仍受各自未完成条件约束。

[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence) · [本轮验证](../validation/2026-09-10-workflow-checkpoints.md) · [执行绑定](workflow-execution-snapshot.md)
