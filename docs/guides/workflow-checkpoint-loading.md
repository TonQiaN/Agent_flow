# Workflow 检查点加载

`loadWorkflowCheckpoint(compiled, runId, store)` 从受信的 RunRecordStore 读取检查点，核对当前安装的 Workflow 和执行定义，再恢复独立的临时文件引用。它返回检查数据与清理句柄，不执行节点、不写 Run 数据库，也不查询或停止旧容器。

```ts
const loaded = await loadWorkflowCheckpoint(compiled, runId, store);
try {
  const checkpoint = loaded.checkpoint;
  // 对文件 Workflow，使用构建 compiled 时的 FileWorkflowCatalog。
  await files.materialize(checkpoint.cursor.value, runId, destination);
} finally {
  await loaded.dispose();
}
```

使用与保存时相同的实际脚本、contract、Docker 参数及可解析到相同镜像 ID 的配置重新组装 Catalog 和 compiled。当前内置组合限于断网 Docker 脚本；描述缺失或变化会拒绝加载。编译和检查点加载不会把普通函数闭包或 Agent 配置当作已验证的执行版本。

加载接受普通 v5 检查点及 agentflow-workflow-recovery/v1 恢复封套中的 v5 检查点，先严格核对版本、字段、Run、Attempt 和步骤身份、中断 Attempt 的连续编号和结果步骤关联、资源唯一性、launch 状态与资源的对应关系、已接纳输出、当前值及状态，并复用正常执行的路由计算核对历史计数与位置。非空 Runner 资源还须匹配该节点实际注册的资源环境；此处不安装旧资源或查询容器，后续具体归属和停止核对由 Runner 完成。文件记录再核对归档摘要、contract、收据身份、实际镜像及前序清单；文件内容经过摘要复核和 contract 校验后复制到新的临时 ArtifactStore。旧 fileRef 和清单 ID 保留逻辑关联，实际临时存储 ID 单独管理。复制出的文件可修改，后续物化和原归档保持不变。

Catalog 的 restoreValue 只消费加载器签发的一次性进程内请求。普通 JSON、请求副本或重复消费都会拒绝；这不是对受信宿主代码或控制数据库者的防篡改保证。调用者必须提供自己的受信 Run 存储，不能把模型提交的 JSON 包装成存储后导入。返回的 checkpoint 每次都是独立副本，不是执行授权。

`dispose()` 撤销本次加载的临时引用并释放临时快照，归档仍保留；调用者自行管理已物化到 destination 的副本。多个并发 dispose 共用同一次清理。加载中途失败会逆序撤销已建立的引用；清理失败抛出带 `dispose()` 的 `WorkflowRestoreError`，应保留该对象并重试收尾，不能丢弃资源责任。同一 Catalog 仍持有相同 token 时重复加载拒绝，先完成上一句柄释放后可以重新加载。

加载可以检查 running、cancelled 或 failed 记录，但不会改变它们的状态。宿主被终止不代表其容器已停止；后续恢复协调仍须取得 CAS 所有权、核对并停止旧 Runner 资源，再以同一 NodeTask 的新 Attempt 进入正常执行。[恢复认领与旧资源清理](workflow-recovery.md)已接入，同一 NodeTask 的新 Attempt 已接入共享执行循环。

[检查点写入](workflow-checkpoints.md) · [本轮验证](../validation/2026-09-10-workflow-checkpoint-loading.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)

加载恢复封套时额外核对 claimRevision、资源移除标记与活动状态的关系，`loaded.recovery` 返回 `{ claimRevision, resourceRemoved }` 的独立副本；普通记录为 null。该检查保持存储 revision 不变，不取得新 claim，也不触碰旧容器。

实际不可变 API key Agent 的文件收据也已接入严格加载：从已安装 Driver 取得 Harness/版本/镜像，核对内外身份、前序引用和完整输入/输出清单；没有 Agent receipt 的公开导入接口。详见[阶段指南](workflow-phases.md)。

内置 FileArtifactStore 支持直接在存储暂存范围物化归档并完成 contract 校验，因此加载不再建立 Catalog restore 目录；同一清理句柄释放整个本次快照范围。旧存储没有此可选端口时保持原路径回退。再次保存也可直接交给归档，见[归档交接](artifact-archive.md#直接接收已物化副本)。

固定操作的 apply Effect 也通过加载器的一次性校验请求核对已接纳 JSON 回执：由实际 Effect 适配层比较前序输入、操作映射与持久日志。缺失日志、输入冲突或回执变化拒绝；加载不调用服务或授权策略，见[Effect 指南](workflow-effects.md#固定操作的持久-workflow)。
