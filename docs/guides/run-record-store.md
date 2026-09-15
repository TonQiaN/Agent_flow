# 本地 Run 记录存储

`RunRecordStore` 是 engine 的状态保存端口，`SqliteRunRecordStore` 是 integrations 的首个实现。它保存一个 Run 的 JSON 内容和 revision；已由 [Workflow 检查点](workflow-checkpoints.md)接入正常执行，但不会核对/停止旧容器或恢复节点。节点恢复由独立的 [Workflow 恢复协调](workflow-recovery.md)提供；#13 首版实现已合入，验收及交付入口见 [0.1.2 计划](../roadmap/0.1.2.md)。

```ts
import { SqliteRunRecordStore } from '@agentflow/integrations';

const store = await SqliteRunRecordStore.open('/absolute/private/run-state');
try {
  const created = await store.create('example-run', { phase: 'queued' });
  const updated = await store.compareAndSwap('example-run', created.revision, { phase: 'saved' });
  const reopenedView = await store.read(updated.runId);
} finally {
  store.close();
}
```

示例内容只演示存储，不是完整引擎 checkpoint。调用者不能据此将 phase 字符串当成执行成功或旧资源停止证据。

## 行为

- create 为新 Run 分配 revision 1，重复 ID 拒绝；read 不存在的 Run 返回 null。
- compareAndSwap 只接受当前 revision，提交后加一。冲突返回 RUN_REVISION_CONFLICT，调用者须重读并按引擎语义协调，不能把旧内容改成新版本号后盲目覆盖。
- JSON 在写入时独立复制，拒绝 getter、函数、非有限数字及非 JSON 结构；每份编码内容最多 16 MiB。返回内容修改不会改变已保存数据。
- 用 SQLite 单行事务保存 runId、revision、payload 及组合摘要；摘要不匹配或内容损坏拒绝读取。摘要用于意外损坏检测，不能抵抗控制宿主与数据库的修改者。
- 状态目录必须是宿主管理的绝对私有 POSIX 目录；叶目录、数据库和已有 WAL/SHM/journal 文件检查所有者、权限和文件类型，拒绝链接或多硬链接数据库。根外祖先由宿主管理。数据库为 runs.sqlite，SQLite 自行管理旁文件；不要在打开连接时移动或只复制主文件来备份。
- Node.js 使用仓库已有的 24+ 运行要求，原生 node:sqlite 仅在 open 时加载，不影响未选择此存储的 CLI 路径。具体 SQLite 连接不出现在 engine 端口。

存储使用 WAL、FULL 同步及 5 秒忙等待。公开端口返回 Promise，但底层 SQLite 操作为同步短事务，争用可能占用宿主线程最多忙等待时段；事务中不做网络、Agent 执行或产物复制。I/O/锁忙返回 RUN_STORE_IO_ERROR，调用者不可猜测该写入是否已提交，应重读核对。未知应用标识、schema 版本或表结构返回 RUN_STORE_UNSUPPORTED，不自动迁移或修复；空的未初始化数据库可初始化为当前 schema。close 可重复调用，关闭后访问返回 RUN_STORE_CLOSED。

## 边界与接续

内部 JSON 的快照 schema、Attempt 历史、定义/配置及认证引用边界由引擎负责。本端口不会扫描任意 JSON 猜测 token；宿主不得传入认证材料。只有 Profile 引用与非秘密身份可进入运行快照。当前没有 node-list、调度器、后台恢复、数据库导出或远端同步入口。

CAS 和数据库事务只保护状态更新，不能证明文件产物已经耐久保存、旧执行已停止或外部 Effect 未发生。当前检查点写入先耐久保存并校验输入/产物，再提交接纳及后继位置；恢复协调使用共同 Runner query/stop 接口，再进入同一引擎执行/路由。不能用读取到一行记录作为整个 Run 可恢复的证明。

[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence) · [存储验证](../validation/2026-09-09-run-record-store.md)

[耐久文件归档](artifact-archive.md)已由 Workflow 检查点接入：先保存文件，再通过本存储端口提交引用。
