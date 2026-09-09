# Workflow 检查点写入

`WorkflowRuntime.startPersisted(compiled, runId, input, store)` 在现有串行执行路径上保存正常运行事实。当前内置组合支持无私有认证的 Docker 脚本（断网或 CONNECT）；它提供检查点写入和异步取消确认，断网脚本的重启执行使用[恢复接口](workflow-recovery.md)。

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

`WorkflowCheckpoint` 当前为 agentflow-workflow-checkpoint/v4，保存实际执行定义、WorkflowSnapshot、当前节点/值/路由计数及初始输入和每个已接纳输出的值记录，并保存每次正常调用的 attempts。Attempt 包含节点与完整身份、对应 Runner 资源或 null，以及 resultStep（指向现有 steps 的零起始索引，尚无结果时为 null），interrupted 标记已收尾的中断调用；另有 launch 表示该资源最后提交的准备/创建/启动状态，不重复保存结果内容。JSON 值保存独立副本；文件值保存原关联 token、contract、摘要清单、归档引用和来自实际 FileWorkflowCatalog 的来源收据。文件 token 本身仍是进程内引用，只有相应耐久数据才提供重启后的内容证据；不能把旧 token 直接交给新 Catalog 执行。

文件保存先使用临时存储原有物化能力核对内容，再进入独立归档，并检查归档清单与原始接纳清单一致；文件复制和归档均不在 SQLite 事务中。异步归档准备完成后，值记录与接纳步骤在同一同步阶段登记，防止取消在两者之间写入不一致记录。归档成功而 CAS 失败可能留下未引用文件，首期不自动 GC。原文件、临时快照和 Run 归档各自独立，临时引用释放不会删除归档。

一次存储失败或 revision 冲突会使该写入队列拒绝后续写入，completion 拒绝，不能跨过失败的接纳继续调用下一节点。最终成功记录提交失败时，实时查询也变为 WORKFLOW_PERSISTENCE_FAILED。输出归档失败可保存为 WORKFLOW_VALUE_PERSISTENCE_FAILED；该输出不进入已接纳步骤。完整 Run JSON 仍受存储层 16 MiB 限制，超限不能截断历史后成功。

## 尚未完成的恢复边界

当前已保存正常调用的 Attempt 开始、资源和结果步骤关联；[严格加载与文件引用恢复](workflow-checkpoint-loading.md)、[恢复协调与新 Attempt 执行](workflow-recovery.md)均已接入。恢复句柄经共同 Runner 清理旧资源，再进入共享 Workflow 循环；保留中断历史，同 NodeTask 递增 Attempt。未知 pending 操作仍拒绝自动恢复。

真实 SIGKILL 已验证删除原输入/临时目录后 A 不重跑、旧 B 清理后第 2/3 次 Attempt 完成。Agent/函数/Effect/联网绑定和认证接管仍受各自未完成条件约束，见[恢复执行验证](../validation/2026-09-10-workflow-resume.md)。

脚本资源保存端口随每次调用创建并在调用结束时关闭，经文件适配器与 ScriptExecutor 传给 Runner；资源 CAS 提交完成前不创建容器，失败阻止当前调用和后继。存储只保存事实。旧未发布 v1/v2/v3 试验记录不能通过当前严格加载器，原始存储仍可只读检查，不自动补造资源证据。

Runner 每次准备、创建和启动前后提交 launch。准备/创建返回后记录 completed；start 可能仅发出异步命令，须 observe 确认 running 或 exited 才记录 start_completed。操作或 CAS 失败保留 pending 并阻止后续操作；取消在前置提交等待期间发生，也不继续发出操作。pending 不等于容器未创建，completed 不等于恢复者已取得所有权。见[操作记录验证](../validation/2026-09-10-runner-launch-journal.md)。
