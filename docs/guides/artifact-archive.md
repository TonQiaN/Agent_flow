# 耐久文件归档

`ArtifactArchive` 是 engine 的耐久文件端口，`FileArtifactArchive` 是 integrations 的本地实现。它与临时 `ArtifactStore` 分开：归档不提供 `release`，因此执行句柄的清理不会删除 Run 恢复需要的文件。当前尚未自动接入 WorkflowRuntime；完整节点恢复仍待实现。

```ts
import { FileArtifactArchive, SqliteRunRecordStore } from '@agentflow/integrations';

// contracts 是已注册的 FileContractRegistry；两个根的宿主父目录须已存在。
const archive = new FileArtifactArchive('/absolute/private/artifacts', contracts);
const records = await SqliteRunRecordStore.open('/absolute/private/run-state');
try {
  // 调用者先确认 source 的所有写入者已停止。
  const saved = await archive.capture('/absolute/stopped/outputs', 'output-files');
  await records.create('example', { output: { ...saved.reference } });
  await archive.materialize(saved.reference, '/absolute/new-work-copy');
} finally {
  records.close();
}
```

此处 Run JSON 只演示保存顺序，不代表完整引擎 checkpoint。生产接纳仍须由引擎核对执行身份、完成证据及契约，归档成功本身不代表 Agent 成功。

## 保存与读取

capture 复用临时快照的文件复制与契约校验，拒绝符号链接、多硬链接、特殊文件、改变中的文件、超量及不满足契约的输出。归档保留文件内容、SHA-256、媒体类型、规则归属和目录清单，返回 `{ reference, manifest }`；reference 包含唯一 id 与版本化清单的 SHA-256。请把完整 reference 保存到 Run 状态。

文件同步完成后，按子目录到父目录同步归档树，再同步清单和 staging 目录、原子发布到唯一目录、同步归档根。首次创建根还同步其父目录。只有 capture 正常返回后，才可提交引用它的 Run 状态。SQLite 与目录不是一个跨文件事务；归档成功而状态提交失败可留下未引用数据，首期没有自动清理或垃圾回收。发生 I/O 错误时不自动推断数据不存在，也不删除正式发布的目录。

read(reference) 校验引用、清单摘要、版本、身份、大小、路径和目录层级，返回新的清单对象；不会重新依赖当前 contract 定义来解释已保存文件，也不证明文件字节仍完好。materialize 进一步逐文件校验大小与摘要，并创建独立、可写的副本；任何复制失败清理本次已创建目标，已存在目标保持原状。只有清单声明的内容进入副本。物化中进程崩溃可留下部分目标；该目标不能作为完成证据，下次应使用新的工作目录，不能自动信任或续写已有目标。

归档根必须是宿主显式指定的规范绝对 POSIX 路径，叶目录与内部目录权限 0700、文件 0600，当前用户持有；拒绝路径链接、文件硬链接和不安全权限。根外祖先由宿主管理，不能将归档目录开放给 Agent 或其他不受信写入者。摘要检出意外损坏，不抵抗能够同时改写 Run 引用和归档的宿主控制者。

清单最多 16 MiB；复用现有文件捕获上限：10,000 个条目、单文件 64 MiB、总文件 256 MiB，以及用户更严格的 contract 限制。恢复不跟随软链接、不复用宿主输入 inode，也不会把旧目录重新挂给下一次执行。

## 尚未接入

当前 Run 恢复协调、定义/输入一致性、Attempt 历史、接纳与后继创建的一致性、旧 Runner query/stop 和 Effect unknown 均未由此接口实现。现有 AgentExecutor 仍使用临时 ArtifactStore，后续由引擎在接纳提交前显式归档。未发布 staging 和未引用归档暂时保留；首期没有 delete/list/迁移/去重/自动 GC。

[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence) · [归档验证](../validation/2026-09-10-artifact-archive.md) · [Run 记录存储](run-record-store.md)
