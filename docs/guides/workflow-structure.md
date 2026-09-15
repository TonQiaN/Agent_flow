# Workflow 结构与契约快照

`snapshotWorkflowStructure(compiled)` 从真正编译过的受信计划导出版本化结构；`assertWorkflowStructureMatches(compiled, saved)` 核对已保存结构与当前计划是否一致。它们为 [Workflow 检查点与恢复](workflow-recovery.md)提供结构核对，本身不执行恢复。

```ts
import { compileWorkflow, snapshotWorkflowStructure, assertWorkflowStructureMatches } from '@agentflow/engine';

const compiled = compileWorkflow(definition, installedCatalog);
const structure = snapshotWorkflowStructure(compiled);
// 将 structure 与之后的执行绑定快照、运行状态一并保存。
assertWorkflowStructureMatches(compiled, structure);
```

快照包含 `version: 1`、Workflow 定义、每个节点的 Component 定义，以及去重的 JSON / 文件 contract。文件 contract 引用的 JSON schema 也完整纳入，未被使用的注册项不进入快照。`ContractRegistry.definition(id)` 返回实际注册 schema 的独立副本，支持 boolean schema；注册前传入对象及后续返回对象的修改均不改变实际验证定义。

现有 JSON 函数、文件函数/Agent/脚本、文件到 JSON 转换和 Effect Catalog 均提供 `contractDefinition`，从各自真正使用的注册表取值。编译时立即复制这些定义，后续替换 catalog 的描述方法不会改变已编译计划的结构。调用者不能用一个只有 definition 字段的 JSON 对象冒充已编译计划，也不能直接用结构快照作为执行计划。

## 一致性规则

结构导出时重新校验 schema、文件契约和引用集合；同一流程内相同 `(kind, id)` 对应不同定义会拒绝。文件 contract 的嵌套 JSON 引用也参与全局同名一致性检查，避免只有文件 ID 相同却使用不同内容校验规则。缺失、额外夹带或无效的 contract 描述不能成为快照。

结构比较忽略 JSON 对象键顺序，保留数组顺序及全部字段。拓扑、Component 实现标识、contract 内容、结构版本或附加字段变化会返回 `WORKFLOW_STRUCTURE_MISMATCH`。这是保守的内容比较，不推断两个不同 schema 或两种拓扑是否语义等价。非法 JSON/getter 返回 `INVALID_WORKFLOW_STRUCTURE_SNAPSHOT`，不会执行 getter。

旧自定义 WorkflowNodeExecutor 的 `contractDefinition` 为可选：仍可按现有方式编译和执行，但结构导出会明确报 `WORKFLOW_CONTRACT_DEFINITION_UNAVAILABLE`，不能把没有证据视为一致。当前普通 compileWorkflow 的连线检查仍按类型与 ID；完整定义冲突在结构导出/核对时拒绝，尚未自动启用到普通执行路径。

## 证明范围

结构一致只证明计划结构、Component 元数据及实际注册的契约相同。Component 的 implementation 字符串并不能证明函数闭包或部署代码相同；结构快照不包含 Agent 用户说明、行为配置、具体 Harness/模型/镜像、脚本环境、认证 Profile 或非秘密连接身份；这些信息由独立的[执行绑定快照](workflow-execution-snapshot.md)从实际安装生成，不能让调用者手写一份描述代替事实。

Attempt 历史、输入/产物接纳、取消意图、旧 Runner query/stop 和 Effect unknown 的核对由检查点及恢复协调负责。结构匹配不能单独授权重跑节点、认定旧执行停止或发起外部动作。

[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence) · [本轮验证](../validation/2026-09-10-workflow-structure.md) · [Run 记录存储](run-record-store.md)
