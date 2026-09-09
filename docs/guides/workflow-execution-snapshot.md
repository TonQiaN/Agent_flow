# Workflow 执行绑定快照

`snapshotWorkflowExecution(compiled)` 组合已编译结构与各节点实际执行器给出的绑定描述；`assertWorkflowExecutionMatches(compiled, saved)` 对当前安装重新取得的描述进行完整内容核对。当前内置实现支持 Docker Script（断网或 CONNECT）和实际 Agent 执行定义；断网脚本已接入[恢复](workflow-recovery.md)，不可变 API key Agent 已接入阶段恢复，订阅仍待接通。

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

当前缺少 resourceDefinition/restoreResource 成对能力的私有绑定或带交互接口的 DockerBackend 会返回 `EXECUTION_DEFINITION_UNAVAILABLE`，而非省略认证、代理身份后返回一个看似完整的描述。旧 backend 没有 definition 仍可普通运行，但 ScriptExecutor 的持久化描述明确拒绝；空环境描述也拒绝。

## 当前限制

文件函数、JSON 函数、文件到 JSON 和 Effect 的执行绑定描述尚未接入。结构快照支持这些类型不等于执行快照也支持；任一节点缺少执行描述时整体导出失败。函数部署身份仍须从实际安装取得，不能用函数 toString 证明闭包一致。

执行绑定匹配不证明旧任务已停止，不代替输入/产物耐久保存、Attempt 历史、取消意图或 Effect 回执。本接口已接入 [Workflow 检查点](workflow-checkpoints.md)写入，断网脚本的恢复协调与新 Attempt 已接入；订阅认证及其他绑定仍需贯通。

[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence) · [本轮验证及复盘](../validation/2026-09-10-script-execution-binding.md) · [结构快照](workflow-structure.md)

## Agent 执行定义

FileWorkflowCatalog 使用实际注册的 AgentExecutor，后者只调用实际 Driver 的 definitionSnapshot；旧自定义 Driver 未提供该端口时明确拒绝。Codex、Claude、DeepSeek 的 CredentialAgentDriver 向自己的 CredentialHarnessRunner 取得实际描述，不额外要求用户提供一份声称正确的配置。

agentflow-credential-execution/v2 保存用户 prompt/config/outcomes、实际 Adapter 计划和 Harness 版本、实际 argv/configFiles/recordFiles（包括 DeepSeek 注入资产）、期限、非秘密 Profile 与认证传输方式，以及同一 Docker 配置生成的路径、资源限制、沙箱、系统映射和固定镜像 ID。其中 versionProbe 另含实际断网 Docker 定义、探针命令、预期版本与期限；探针资源可以独立记录和清理，见[探针验证](../validation/2026-09-10-version-resource-recovery.md)。执行镜像和代理镜像同时解析成功才固定，后续版本探针及执行使用固定 ID；原标签改指不改变该 Runner 已固定的选择。新组合仍解析其当前选择，与保存描述完整核对。

读取定义只查询本地镜像元数据，不启动版本探针、分配执行目录、访问凭据存储、获取租约或调用模型。实际运行仍执行原生版本验证后才取凭据；定义中的预期版本不能冒充实际探针通过。Profile 的 credentialRef/service/method/endpoint 等非秘密配置参与比较，凭据 generation/revision/token/key 不进入描述，正常刷新不会使定义变化。用户业务 prompt/config 仍会作为运行定义保存，描述器不承担任意业务文本的秘密识别。

同一 Runner 的并发定义请求共享镜像解析；返回值独立。已开始运行而尚未冻结定义时拒绝事后首次描述。DockerBackend.configurationSnapshot 只导出已校验的非秘密配置，不授予网络或私有资源恢复能力；其 definition 支持不可变环境绑定的 v3 资源描述，仍拒绝缺少身份/收尾证据的其他私有绑定；无私有绑定的 CONNECT 已有独立资源恢复。不可变 API key Agent 可声明真实阶段计划并持久启动；订阅 Agent 返回 null 计划，继续在写库/执行前拒绝。定义可比较本身并不证明可恢复。见[验证](../validation/2026-09-10-agent-execution-binding.md)。

## CONNECT 脚本环境

无私有认证绑定的 CONNECT DockerBackend 可取得 agentflow-docker-execution/v2 定义：固定任务和代理镜像 ID、规范化出口配置，并保存 agentflow-egress-execution/v1 的代理程序摘要与策略。代理程序从实际构建包读取，在描述准备时保留原字节对应的文本，后续创建使用同一内容；新安装重新读取后对比，程序变化不能混用。断网定义仍为 v1。

代理和内外两张网络使用同一资源 ID 派生名称，完整任务身份标注在各资源上；其恢复仅重建管理关系，不重新 setup 或 start。任务容器缺失不代表代理和网络已清理。共同 Runner 的移除会核对并清理全部组成部分，失败保留可重试的管理句柄。详见[联网资源恢复验证](../validation/2026-09-10-network-resource-recovery.md)。


不可变环境凭据的 Docker 定义为 agentflow-docker-execution/v3，增加只含 credentialRef/service/method 与变量名称的 privateState；没有密钥、内容摘要或源存储 generation/revision。DeepSeek 的 Agent 定义现在包含这个实际环境、固定代理镜像与代理程序摘要；同一组合保留描述，实际执行重新准备后必须一致，否则在分配容器前拒绝。恢复使用只管理绑定，无须当前凭据仍然存在。这些端口已通过 Driver/Catalog 接入[Workflow 阶段](workflow-phases.md)；单独资源能力仍不授予跨进程认领权。

当前执行快照为 version 2，增加 resourcePlans。实际 executor 可提供 resourcePlan(component)，返回有序且唯一的 1–8 个 resource/operation 阶段；resource 包含实际环境定义。编译固定描述和恢复方法，快照保存独立副本；恢复须与当前安装完整一致，不能从保存计划生成执行器。未提供该能力的节点使用空映射中的缺省单资源路径。见[阶段指南](workflow-phases.md)。
