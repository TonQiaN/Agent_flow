# Agent 一次接纳与可信执行收据

`AgentExecutor` 位于 engine，协调一个 Attempt 的文件输入、受信执行驱动、结果接纳和内存收据登记。它不分配业务节点、不选择后续路由，也不代替未来 Workflow 的 Component 定义与编译。当前切片用 JSON 文件携带业务结构化内容，尚无通用内存 JSON Agent 输出协议。

宿主传入 `FileContractRegistry`、可替换 `ArtifactStore` 与显式安装的 `AgentExecutionDriver`。驱动负责验证配置、将指定快照物化为独立输入并调用实际执行环境；不能从 Workflow 文档注入任意函数来声称执行成功。`CodexAgentDriver` 位于 integrations，连接已有订阅 Runner 与文件存储，Profile、认证和 Docker 配置不进入 engine。

```ts
const executor = new AgentExecutor(fileContracts, artifacts, trustedDriver);
const attempt = await executor.execute({
  componentId: 'marker',
  identity: { runId: 'run-1', nodeTaskId: 'mark-1', attemptId: 'a-1', attemptNumber: 1 },
  prompt: userTask,
  config: { model: selectedModel, subagents: false, search: false },
  input: { source: sourceDirectory, contractId: 'paper-files' },
  outcomes: { completed: 'marked-files' },
});
try {
  const result = attempt.result;
  if (result.status === 'accepted') {
    // 读取引擎登记的副本，不能导入外部正文作为可信收据。
    const receipt = executor.receipt(result.receipt.id);
    await artifacts.materialize(receipt.output.id, newInputDirectory);
  }
} finally {
  await attempt.retryCleanup();
  await attempt.releaseExecution();
}
```

只有请求、Runner、Harness 的 Run/NodeTask/Attempt 身份一致，实际退出为 0、停止确认、容器删除、raw 采集完整、Harness 正常终态、收尾成功且无诊断，输出又满足契约时，才产生 accepted 和收据。单 outcome 由引擎在这些条件满足后赋值；多 outcome 必须来自 Harness 的结构化结果，并选择对应文件契约。合法 rejected 是业务结论，输出不合约或运行失败不会自动变成 rejected/needs-fix。

失败结果包含静态 code；文件失败另含 contractId 和相对 path / rule / code，不复制任意异常文本或文件内容。`attempt.retryCleanup()` 可重试驱动停止/清理，但不会改变该 Attempt 原来的接纳结果。`releaseExecution()` 释放驱动工作区及本次自行捕获的源输入快照，不能在资源仍被占用时绕过驱动的释放检查。

后继输入使用 `input: { receiptId, contractId }`：只接受本 executor 已登记、同一 Run、输出尚未释放的前序收据，且 contractId 必须等于其输出契约 ID。引擎把整个输出快照交给驱动，物化时重新校验摘要。不能把模型写的 receipt.json 或任意反序列化对象传进来建立信任。Workflow 仍须判断哪个节点是允许的后继；同一契约不代表任意业务路由都被批准。

宿主也可传入 `input: { snapshotId, contractId }` 借用当前 ArtifactStore 私有登记中的快照。存储须提供 `inspect`，返回的 ID 和契约必须一致；未知或不匹配的快照不会启动 Driver。该路径不捕获另一份输入，也不在 `releaseExecution()` 删除调用方快照；调用方负责保留到使用结束。`canReuseSnapshot(store)` 仅在相同实际存储对象且支持 inspect 时返回 true，供 Catalog 选择该路径；它不导入外部清单、不转移收据路由授权，也不取消 Driver 的独立可写输入副本和摘要校验。Catalog 会在未确认停止时继续占用引用，直到清理成功。

收据保存 Component、执行身份、前序 ID、实际 Harness/版本/镜像、输入输出快照描述与 outcome，不包含宿主源路径、raw 路径、prompt 或凭据。`receipt()` 和 `attempt.result` 返回副本。需要诊断执行时，受信宿主单独调用 `attempt.executionFacts()` 读取含私有采集路径的事实；它不进入收据或 attempt 的 JSON 序列化。

同一 executor 内以 Run/NodeTask/Attempt ID 预留一次执行，失败也不允许重用同一 Attempt；重试须提供新 Attempt ID。多个 Run 可独立执行。`releaseOutput(receiptId)` 显式释放产物快照但保留历史事实，之后不能再用该产物启动任务。宿主负责何时结束消费者对快照的使用，不提供并发释放与使用的引用计数保证。

这些收据通过进程内私有登记表建立可信来源，不是数字签名或可离线验证的证书；尚无跨进程持久化、恢复与导入接口。宿主和显式安装的驱动、存储是信任边界，不声称抵抗同权限恶意宿主。确定性 Component、Effect 及完整 Workflow 的统一接入仍在后续切片完成。

[组件决定](../../.agents/decisions/product/README.md#p-20260909-component-execution) · [验证记录](../validation/2026-09-09-agent-acceptance.md)
