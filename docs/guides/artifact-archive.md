# 耐久文件归档

`ArtifactArchive` 是 engine 的耐久文件端口，`FileArtifactArchive` 是 integrations 的本地实现。它与临时 `ArtifactStore` 分开：归档不提供 `release`，因此执行句柄的清理不会删除 Run 恢复需要的文件。已通过 [Workflow 检查点](workflow-checkpoints.md)接入正常文件流程，并由[恢复协调](workflow-recovery.md)用于节点边界恢复。

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

## 直接接收已物化副本

内置临时存储和归档都支持可选 `captureMaterialized(source, contractId)`。source 是宿主明确安装的 `ArtifactMaterializer`，其 `materialize(destination)` 须在不存在的目标生成独立文件树，返回后停止写入。它不是从 Workflow JSON 或持久记录反序列化的函数；方法在首次异步等待前固定。

```ts
const saved = await archive.captureMaterialized({
  materialize: destination => temporary.materialize(input.id, destination),
}, 'input-files');
const restored = await temporary.captureMaterialized({
  materialize: destination => archive.materialize(saved.reference, destination),
}, 'input-files');
```

目标位于接收存储新建的私有暂存范围。存储直接读取并校验已复制文件，包含摘要、字节/JSON 上限、媒体、contract、读取稳定性和链接检查，不再复制一次；文件与目录须由当前用户持有且权限为 0600/0700。文件同步及归档的目录/清单同步、原子发布顺序保持不变。临时快照保留整个暂存范围的私有释放责任，release 会清理其中的相邻暂存；归档发布前释放空暂存范围。失败只清理本次范围，不删除源文件、无关邻居或已发布归档。

Catalog 在目标支持该端口时省掉自己的 checkpoint/restore 临时目录。旧端口实现使用原路径回退；两种路径都核对归档/恢复清单与原逻辑记录。来源仍由实际存储的 materialize 逐文件核对摘要，同一存储根内的重叠物化继续拒绝。崩溃时未发布暂存和旧进程临时快照仍可能保留，本接口没有扫描回收能力。

## 职责与清理边界

Run 恢复协调、定义/输入一致性、Attempt 历史、接纳与后继位置、旧 Runner query/stop 和 Effect unknown 由各自模块负责。AgentExecutor 使用临时 ArtifactStore；Workflow 在接纳提交前通过实际文件 Catalog 显式归档，加载时再从归档重建临时引用。未发布 staging 和未引用归档暂时保留；首期没有 delete/list/迁移/去重/自动 GC。

[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence) · [归档验证](../validation/2026-09-10-artifact-archive.md) · [Run 记录存储](run-record-store.md)
