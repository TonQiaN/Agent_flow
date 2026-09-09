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

加载当前只接受 v2，先严格核对版本、字段、Run、Attempt 和步骤身份、结果步骤关联、资源唯一性、已接纳输出、当前值及状态，并复用正常执行的路由计算核对历史计数与位置。非空 Runner 资源还须匹配该节点实际注册的资源环境；此处不安装旧资源或查询容器，后续具体归属和停止核对由 Runner 完成。文件记录再核对归档摘要、contract、收据身份、实际镜像及前序清单；文件内容经过摘要复核和 contract 校验后复制到新的临时 ArtifactStore。旧 fileRef 和清单 ID 保留逻辑关联，实际临时存储 ID 单独管理。复制出的文件可修改，后续物化和原归档保持不变。

Catalog 的 restoreValue 只消费加载器签发的一次性进程内请求。普通 JSON、请求副本或重复消费都会拒绝；这不是对受信宿主代码或控制数据库者的防篡改保证。调用者必须提供自己的受信 Run 存储，不能把模型提交的 JSON 包装成存储后导入。返回的 checkpoint 每次都是独立副本，不是执行授权。

`dispose()` 撤销本次加载的临时引用并释放临时快照，归档仍保留；调用者自行管理已物化到 destination 的副本。多个并发 dispose 共用同一次清理。加载中途失败会逆序撤销已建立的引用；清理失败抛出带 `dispose()` 的 `WorkflowRestoreError`，应保留该对象并重试收尾，不能丢弃资源责任。同一 Catalog 仍持有相同 token 时重复加载拒绝，先完成上一句柄释放后可以重新加载。

加载可以检查 running、cancelled 或 failed 记录，但不会改变它们的状态。宿主被终止不代表其容器已停止；后续恢复协调仍须取得 CAS 所有权、核对并停止旧 Runner 资源，再以同一 NodeTask 的新 Attempt 进入正常执行。该执行恢复入口尚未开放。

[检查点写入](workflow-checkpoints.md) · [本轮验证](../validation/2026-09-10-workflow-checkpoint-loading.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
