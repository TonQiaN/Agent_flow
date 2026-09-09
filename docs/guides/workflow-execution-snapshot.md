# Workflow 执行绑定快照

`snapshotWorkflowExecution(compiled)` 组合已编译结构与各节点实际执行器给出的绑定描述；`assertWorkflowExecutionMatches(compiled, saved)` 对当前安装重新取得的描述进行完整内容核对。当前内置实现先支持断网 Docker 脚本，尚未提供 Run 重启恢复入口。

```ts
import { snapshotWorkflowExecution, assertWorkflowExecutionMatches } from '@agentflow/engine';

const saved = await snapshotWorkflowExecution(compiledScriptWorkflow);
// 持久保存 saved；之后用重新安装和编译的计划核对。
await assertWorkflowExecutionMatches(recompiledScriptWorkflow, saved);
```

计划必须经过真正的 compileWorkflow。编译时绑定描述方法随执行方法一起固定，不能通过后续替换 catalog 方法改变该计划的证据来源。结构中的 contract 定义仍来自实际注册表。绑定描述是已安装代码提供的数据，不能将保存的 JSON 反序列化成 executor 或把任意用户字段当成可信环境。

## 断网脚本路径

FileWorkflowCatalog 从自己已注册的 ScriptDefinition 取得 argv、timeoutMs 和 outcomes，交给同一个 ScriptExecutor；后者调用自己实际绑定的 ExecutionBackend.definition。DockerBackend 根据构造时已校验的实际选项，读取本地 Docker 镜像 ID，冻结 CPU、内存、PID、UID/GID、日志上限、沙箱策略、路径布局、系统配置映射和工作根等环境选择。描述只包含这些受控字段；不触发容器启动、工作目录分配或凭据获取。

冻结后，该 backend 实例的后续 create 使用相同镜像 ID；即使原标签删除，也不会重新选择另一镜像。新安装仍需自行解析当前选择，不能用保存的镜像声明冒充本地存在的安装。标签不同而最终镜像 ID 与其他选项相同可匹配；镜像不可用、命令/期限/环境变化或保存内容变化会拒绝。工作根也是现有资源定位的一部分，当前保守要求匹配。

描述请求并发共享一次冻结；返回值可独立修改，不影响内部选择。已经开始分配资源的 backend 不能在事后首次冻结；冻结正在进行时分配会等待它结束。未调用 definition 的普通 Runner 保持已有行为，仍按当前配置解析镜像。

当前带私有状态绑定、交互接口或 CONNECT 网络的 DockerBackend 会返回 `EXECUTION_DEFINITION_UNAVAILABLE`，而非省略认证、代理身份后返回一个看似完整的描述。旧 backend 没有 definition 仍可普通运行，但 ScriptExecutor 的持久化描述明确拒绝；空环境描述也拒绝。

## 当前限制

内置 Agent、文件函数、JSON 函数、文件到 JSON 和 Effect 的执行绑定描述尚未接入。结构快照支持这些类型不等于执行快照也支持；任一节点缺少执行描述时整体导出失败。后续需要从实际安装取得函数部署身份、Agent 用户说明与行为配置、Harness/模型、代理、认证 Profile 及非秘密连接身份，不能用函数 toString 证明闭包一致，也不能存放 token/key。

执行绑定匹配不证明旧任务已停止，不代替输入/产物耐久保存、Attempt 历史、取消意图或 Effect 回执。本接口已接入 [Workflow 检查点](workflow-checkpoints.md)写入，尚未接入恢复协调；#13 的节点边界恢复仍需后续贯通。

[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence) · [本轮验证及复盘](../validation/2026-09-10-script-execution-binding.md) · [结构快照](workflow-structure.md)
