# 从文件快照读取 JSON

FileJsonWorkflowCatalog 的 `registerJsonFile` 从已有文件快照读取一个指定 JSON 文件，校验输出 contract，并保留来源收据。它适合前序 Script 已经生成最终业务 JSON 的场景，例如批卷 Gate 后的发布输入。

```ts
const bridge = new FileJsonWorkflowCatalog(files, jsonContracts, transformRoot);
bridge.registerJsonFile({
  id: 'publication-input', kind: 'transform', implementation: 'publication-json-reader',
  inputContract: 'reviewed-files', outcomes: { completed: 'publication-json' },
}, { path: 'publication.json', outcome: 'completed', maxBytes: 1024 * 1024 });
```

`files` 是同一流程实际安装的 FileWorkflowCatalog；持久运行时须配置 ArtifactArchive。`transformRoot` 是宿主显式指定的绝对私有工作目录。path 是合法的相对产物路径且以 .json 结尾，outcome 必须存在于组件定义，maxBytes 默认及最大为 1 MiB。设置在登记时复制；文件路径、outcome、上限及内置读取行为版本进入执行快照。

输入先由文件 Catalog 物化并校验到本次独立副本；读取器核对目标文件的大小、普通文件类型、读取稳定性、SHA-256 和 UTF-8，再解析 JSON 并检查输出 contract。失败不生成接纳收据。成功时先删除本次转换目录，再返回结果。输入原件及归档不会被修改。

这个入口只读取指定 JSON，不包含可执行表达式或任意回调。需要计算时，在前序 Script 中生成该文件，或者在后续 JSON 节点中使用显式登记的确定性函数。原有 `register(component, callback)` 保持普通进程内用法；它不支持持久执行、恢复或仅靠 revision 声明可安全重跑。

## 保存和恢复

正常 Workflow 通过可选 checkpointAcceptance 端口取得已接纳结果的来源证明。JSON v2 值封套包含 value 与版本化 provenance，和接受步骤、后继位置一起提交同一 Run CAS。普通 JSON 仍使用 v1；新端口要求配套 restoreValue，已安装该端口的节点不能把历史值降级成缺少证明的 v1。

加载器先核对完整历史和当前定义，再签发一次性恢复请求。请求公开冻结的 contract 仅用于分派到文件或 JSON 所有者，普通对象及复制请求没有导入权限。JSON 转换收据核对组件、完整 Attempt 身份、outcome、输出、前序文件引用和清单后才进入当前 Catalog。`bridge.receipt(identity)` 与 `bridge.matches(identity, output)` 因此可供当前宿主审批策略使用；加载本身不调用转换节点或审批策略。

调用 `loaded.dispose()` 或加载后续步骤失败时，本次恢复的收据随文件引用一起撤销。不得把尚未完整加载的状态用于审批；收据也不是发布授权，Effect 仍须获得当前宿主授权。

尚未接纳的内置读取可通过共同恢复认领，重新执行同一 NodeTask 的新 Attempt。读取和有限的私有副本写入互不共享业务路径，没有外部副作用；旧宿主若仍在读取，迟到结果由 Run CAS 拒绝。此边界不适用于普通宿主文件写入回调，也不证明旧临时目录自动回收。SIGKILL 后旧副本可能保留，不能按目录前缀或 PID 消失推断归属并删除。

受信宿主与 Run 存储的边界沿用文件收据：不接受模型提供的历史记录作为受信存储，也不宣称可以防止控制数据库者同时伪造所有一致事实。批卷示例已接入 publication.json 的实际生成与当前审批策略，见[持久组合](persistent-tutor-grading.md)；该合成验证不代表官方模型或真实学生整体验收完成。

[验证记录](../validation/2026-09-10-json-file-projection.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
