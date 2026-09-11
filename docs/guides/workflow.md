# Workflow 编译与串行执行

当前库 API 可编译用户定义的串行流程，通过已登记的 JSON gate/transform 函数执行、查询与取消。编译器和运行控制不依赖 Docker、Harness 或实际文件系统；独立的文件适配已接入可信文件函数与 AgentExecutor，确定性脚本也已接通，JSON 模拟 Effect 也已接入（见 [Effect 指南](workflow-effects.md)），消费侧合成批卷已接通文件到 JSON 转换、Gate/返修和模拟发布，并通过真实 Codex 验证。本指南不代表完整 Issue #9 或 Tutor 批卷已交付。

## 定义与编译

`WorkflowDefinition` 使用以下字段：

- `id`、`start`、`nodes`：流程标识、起点及节点到 Component 的引用。
- `input`、`outcomes`：边界契约为 `{ kind: 'json' | 'files', id }`；outcomes 的键是流程终点名字。类别与 ID 一起比较。
- `routes`：每条由 from/outcome 确定，to 为 `{ node }` 或 `{ end }`。
- `maxSteps`：整个 Run 最多启动的节点数，必填，范围 1–10000。

`compileWorkflow(definition, catalog)` 在启动前解析 Component、实现和具体契约，检查全部节点出口都有唯一路由，源出口与目的地契约相同、起终点一致、节点可达及终点被使用。编译错误包含静态 code 和定义 path。最多 256 节点、每节点 32 个出口、8192 条路由。需要改变数据或契约时定义显式 Transform。

编译计划的公开 definition 是副本；调用者修改原定义、公开副本或 catalog 的方法引用，不会重定向已有计划。只有编译器登记的计划能启动；把 definition JSON 包成同形对象不能伪造它。

首个 `JsonFunctionWorkflowCatalog(contracts, components, functions)` 复用 Component 使用指南中的三个注册表，拒绝 agent/effect 或未知函数。其他执行端口必须由受信宿主显式安装并自行声明实际支持；文件节点通过 integrations 的 FileWorkflowCatalog 显式安装，详见 [文件 Workflow](workflow-files.md)。

## 返修与终点

下面的路由最多进入指定 fixer 两次，然后采用用户指定的终点：

```ts
{
  from: 'review', outcome: 'revise', to: { node: 'fixer' },
  limit: { max: 2, exhausted: { end: 'rejected' } }
}
```

max=0 直接采用 exhausted；exhausted 也可以指向另一个节点，且同样检查契约。计数属于当前 Run 的 from/outcome 路由，不依赖 Producer/Gate/Fixer 的固定命名。再次进入节点会创建新的 NodeTask，其 Attempt 从 1 开始。本切片没有自动执行重试。

沿耗尽路线直接结束时，Run.status 为 exhausted，reason 为 ROUTE_LIMIT_EXCEEDED，outcome 是用户指定终点；原节点的 outcome/output 保存在 steps 和 lastAccepted，不改写成另一业务结论。正常到达名为 rejected 的终点仍是成功执行。全局 maxSteps 用 MAX_STEPS_EXCEEDED 结束并保留最后结果，不启动下一节点。limits 记录各次路线耗尽，即使用户配置的耗尽目的地是另一个节点。

## 启动、查询和取消

```ts
const runtime = new WorkflowRuntime();
const compiled = compileWorkflow(userDefinition, catalog);
const run = runtime.start(compiled, 'run-1', input);
const current = run.query(); // 或 runtime.query('run-1')
// 需要取消时：run.cancel() 或 runtime.cancel('run-1')
const final = await run.completion;
```

同一 runtime 不允许复用 Run ID。输入、每次节点输入、接纳结果和 query 都取 JSON 副本。查询包括当前节点/身份、状态、取消请求、步骤、最后接纳结果和耗尽记录；失败保留失败位置，尤其是不能证明执行停止时。普通错误不回显任意异常文本。

cancel 登记请求，执行端口通过 Cancellation 观察它。启动前和每次执行后都检查，取消后不启动后继。可信 TypeScript 函数只能合作式结束，不能强行中断同步计算；等待函数返回期间仍为 cancelling。端口失败时 stopped=false 或直接抛出未知异常，Run 记录 EXECUTION_STOP_UNCONFIRMED，不宣称取消完成。具体执行器负责保留其资源清理能力；本切片的 JSON 函数端口没有外部运行资源。

执行失败、身份错误、非法 outcome 和实际输出契约失败都停止流程，不走业务路由。Workflow 在输入与接纳后重查契约；它不会仅凭端口的 accepted 字样推进。文件/Agent 适配通过私有快照引用、交接摘要复核及清理后接纳兑现相同边界。

## 可执行示例

构建后运行：

```sh
npm run build
node src/examples/workflow.mjs 2
node src/examples/workflow.mjs 1
node src/examples/workflow.mjs 0
```

这是确定性 revision 返修示例，不是真实批卷或模型替身。2 次返修得到 accepted；1/0 次在保留最后结果的同时得到 exhausted/rejected。CLI 的 demo 子命令仍独立，尚未提供工作流文件加载命令。Run 状态和编译计划只驻留内存，无持久恢复、共享队列或并行。

[组件决定](../../.agents/decisions/product/README.md#p-20260909-component-execution) · [验证记录](../validation/2026-09-09-workflow-serial.md)
