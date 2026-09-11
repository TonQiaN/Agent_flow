# Workflow 文件节点与 Agent 交接

`FileWorkflowCatalog` 是 integrations 中的本机文件适配，实现与 JSON catalog 相同的 Workflow 执行端口。它不在编译器或调度器里添加 provider、文件系统或认证分支。当前支持可信宿主文件 Gate/Transform，以及注入的 `AgentExecutor`；确定性脚本通过 registerScript 接入（见 [脚本指南](workflow-scripts.md)），Effect 使用独立 JSON 执行适配（见 [Effect 指南](workflow-effects.md)），文件到 JSON 的消费侧转换已通过 FileJsonWorkflowCatalog 接入，见 [Tutor 合成批卷](tutor-grading-fixture.md)；持久恢复尚待实现。

## 登记与运行

宿主创建 `FileContractRegistry`、`FileArtifactStore` 和 catalog，文件与工作根使用宿主控制的独立绝对路径。工作根检查属主、0700 权限和真实目录；祖先路径仍由可信宿主管理。

```ts
const catalog = new FileWorkflowCatalog(fileContracts, artifacts, privateWorkRoot);
catalog.registerFunction(gateDefinition, async ({ inputPath, workPath, outputsPath, identity, cancellation }) => {
  // 用户实现读取 inputPath，计算或修改独立副本，把完整产物放进 outputsPath。
  // Promise 返回前结束所有写入；workPath 是临时工作目录。
  return { outcome: 'accepted' };
});
catalog.registerAgent(markerDefinition, agentExecutor, {
  prompt: userPrompt,
  config: userAgentConfig,
});
const plan = compileWorkflow(userWorkflow, catalog);
const input = await catalog.prepareInput(runId, originalInputDirectory, 'input-files');
const run = new WorkflowRuntime().start(plan, runId, input);
const final = await run.completion;
```

示例中的函数体须由用户补全产物；只返回 outcome 而没有契约要求的文件会失败。定义的 implementation 标识实际登记实现；注册后不能覆盖同名 Component。注册和编译时预检契约与 Agent 的 prompt/config，不保留可被调用方改写的任务对象。用户决定任务、路由、返修节点和次数，Adapter 继续只处理协议映射。

文件函数直接返回唯一字段 `{ outcome }`，不能通过返回任意 manifest 发布输出；输出由宿主扫描 outputs 并验证对应 contract。函数是可信宿主代码，能够读写独立 input/work/outputs，必须在结束全部写入后返回，不允许留下后台写者。这不是不可信代码沙箱。Agent 则沿用已有驱动、Runner、Harness 和执行收尾。

## 引用与来源

`prepareInput` 先捕获文件，返回不透明 JSON 引用。Workflow 只交换这些引用，校验其登记身份与 contract；实际执行另外检查同 Run。普通 manifest、伪造引用、另一个 catalog/Run 的引用、已释放或正释放的快照均不能运行。

`catalog.inspect(ref, runId)` 返回 manifest、可选的 Workflow receipt 和 released 状态副本。每步 receipt 记录身份、Component、前序引用、输入输出 manifest、outcome，并在 Agent 节点附上其一次执行收据。它不带宿主路径、任务正文、原始日志或认证数据，manifest 仍包含业务相对文件名。宿主可沿前序引用回溯至初始输入；修改公开副本不改变登记表。

Agent 的跨 Gate 来源由 Workflow receipt 连接。适配器先从私有快照重新验证摘要并物化，再调用 AgentExecutor 的 source 输入路径；它会再次捕获输入，适配器在接纳流程结果前核对 Agent 收据中的输入内容。Agent 的局部 predecessor 为 null，不伪造其内部收据来冒充直接 Agent 前序。这个路径存在额外复制，保持两个执行层各自的接纳与生命周期边界。

这些引用和收据只在当前进程内有效，不是签名或可导入的持久记录。同一个 catalog 对已执行 Attempt 保留占用记录，清理后也不允许重放它。直接执行入口也会保存 Component 和身份副本，不受调用方异步修改影响。

## 产物与清理

`catalog.materialize(ref, runId, destination)` 重新校验摘要，生成独立副本。`catalog.release(ref, runId)` 释放文件；正在被物化/执行使用时拒绝释放，失败可重试，成功后历史事实仍可查阅。成功 Run 的初始与各步引用由调用方显式释放，需要留作报告的最终产物应先物化到消费目录。

接纳前先释放 Agent 执行资源及节点临时目录，输出快照独立保留。清理失败停止 Workflow，不发布该步文件引用。失败记录保留 currentIdentity，宿主使用 `catalog.cleanup(identity)` 重试停止/收尾及输出/临时目录清理。活动节点禁止清理；未证实停止时不删除其工作区。清理成功也不会把原 Run 变成 succeeded。

取消仍由 Workflow 控制；可信函数只能合作结束。已完成并接纳的步骤可能在最终 cancelled Run 的 lastAccepted 中保留，调用方同样须管理其文件生命周期。未知执行停止状态保留为 failed/EXECUTION_STOP_UNCONFIRMED。

合成驱动测试覆盖 Agent → Gate → Fixer → Gate；同一应用的 [真实 Codex 合成材料验收](tutor-grading-codex.md) 已独立通过，两类证据分别记录。参见 [验证记录](../validation/2026-09-09-workflow-files.md) 与 [串行控制](workflow.md)。
