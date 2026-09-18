# 文件契约与独立交接

`FileContractRegistry` 位于 engine，处理文件事实和契约，不读取目录或调用 Harness。`FileArtifactStore` 位于 integrations，负责本机自动扫描、快照与校验后复制。它们供确定性脚本与 Agent 共用，已通过 [FileWorkflowCatalog](workflow-files.md)接入 Workflow 及来源收据；跨进程内容由独立[耐久归档](artifact-archive.md)保存。

```ts
const json = new ContractRegistry();
json.register('answer-json', {
  type: 'object', properties: { sum: { type: 'integer' } },
  required: ['sum'], additionalProperties: false,
});
const files = new FileContractRegistry(json);
files.register('answer-files', {
  rules: [{ id: 'answer', kind: 'file', match: 'answer.json',
    minCount: 1, maxCount: 1, maxBytes: 65536,
    mediaTypes: ['application/json'], jsonContract: 'answer-json' }],
  maxFiles: 1, maxTotalBytes: 65536, unmatched: 'reject',
});
const store = new FileArtifactStore(privateStoreDirectory, files);
// 宿主须先确认生产者已停止，输出目录没有并发写者。
const snapshot = await store.capture(outputsDirectory, 'answer-files');
try {
  await store.materialize(snapshot.id, newInputDirectory);
} finally {
  await store.release(snapshot.id);
}
```

上述类分别从 `@agentflow/engine` 与 `@agentflow/integrations` 导入。示例的目录参数由受信宿主提供；目的目录必须尚不存在，父目录必须已存在。store 根为当前用户拥有的 0700 目录，快照文件为 0600。快照 ID 只在当前存储实例存活期间有效，没有跨进程恢复接口。

每个规则必须明确数量、单文件大小和媒体类型。`minCount: 0` 表示可选；`kind: 'tree'` 匹配目录根，并增加 `minFiles` / `maxFiles`，内部所有文件按该规则约束。契约的 `maxFiles` 统计所有普通文件，`maxTotalBytes` 统计其总大小；空目录不增加文件数；声明树内的空目录及结构性父目录会保留，未归属的普通空目录不作为产物。

`match` 支持相对路径、单段 `*` / `?` 和独占整段的 `**`。例如 `reports/*.json` 只匹配一层，`reports/**/*.json` 包括 reports 下和更深目录的 JSON 文件。不支持正则、否定、括号扩展或优先级；多个规则命中同一个根、目录树互相包含、树与单文件规则重叠均报错。未匹配文件报错，不能悄悄丢弃。普通空目录（包括仅含空子目录的目录）若不属于任何声明产物，会在私有快照中移除；这适用于任意目录名，不特判 Harness。若其中有未声明文件或危险链接，仍拒绝。Agent 不提供 artifacts 清单。

本机适配识别 JSON、PDF/PNG/JPEG 签名、`.txt` / `.md` 后缀，其余为 application/octet-stream。JSON 始终要求合法 UTF-8 和 JSON 语法，可再按显式 `jsonContract` 校验；PDF/图片签名与文本后缀不是完整格式、可读性或业务质量保证。语义质量由业务 Gate 检查。

除 contract 限额，本机实现还限制 10,000 个文件/目录条目、32 层相对路径、单文件 64 MiB、总文件 256 MiB、JSON 单文件 1 MiB；超过时拒绝，不截断后接纳。当前没有调整这些实现上限的公共配置。

扫描拒绝符号链接、硬链接、FIFO 等非普通文件和非法路径。复制时检查读取前后文件事实，并保存 SHA-256。`materialize` 按引擎保存的快照内容重新校验大小和摘要；篡改、缺失或链接替换会失败并删除本次创建的半成品，已有目的目录不被覆盖。下游副本修改不会写穿快照或其他任务输入。调用方取得的 manifest 是副本，不能靠修改它改变内部接纳结果。

宿主必须控制源目录、存储及目的目录的祖先，并在捕获/交接期间保证无并发写者。这不是对同权限恶意宿主的安全沙箱。`capture` 本身也不证明 Runner/Harness 成功；执行协调层仍须先验证执行身份、停止与终态，再调用契约收集器。违反契约的错误提供相对 path、rule ID 和 code，不携带文件内容。

[组件决定](../../.agents/agent_notes/product/README.md#p-20260909-component-execution) · [验证记录](../validation/2026-09-09-file-contracts.md)
