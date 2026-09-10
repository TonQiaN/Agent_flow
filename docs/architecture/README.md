# 架构

当前实现包含 domain、engine、integrations 和 CLI。domain 保存业务类型与身份；engine 的 contracts 注册 JSON Schema，components 分别注册定义、函数实现并协调一次执行；CLI 组合这些公共接口。

文档架构依据 [分层决定](../../.agents/decisions/development/README.md#d-20260907-documentation-layers)；具体位置见 [结构图](../reference/repository-map.md)。

依赖方向与目录取舍见 [源码结构决定](../../.agents/decisions/development/README.md#d-20260909-source-layout)。确定性调用接受独立 JSON 副本，函数直接返回 outcome/output，引擎校验对应契约；业务 rejected 可以正常接纳，违约或异常属于 failed。具体接口见 [Component 使用指南](../guides/components.md) 和 [执行决定](../../.agents/decisions/product/README.md#p-20260909-component-execution)。

engine/workflow 已有独立编译、串行 Run 控制及逐次 NodeTask/Attempt 分配，通过窄执行端口接入现有 JSON 函数；持久恢复与共享调度尚未实现。Component 不持有路由、文件系统、Docker、认证或 Harness。engine/runner 协调一次执行，integrations/docker 实现文件与容器操作；integrations/workflow/files 将文件函数和 AgentExecutor 接入同一端口，私有引用维护跨节点来源，文件 IO 不进入编译和调度；engine/components/script-executor 通过 backend/clock/记录读取端口接入确定性脚本，engine/components/effect-executor 独立处理一次授权、幂等占位和上下文收据，workflow/effects 接入 JSON 执行；模拟服务位于 integrations/effects，仅写内存。可信函数运行在调用进程中，内存副本隔离不等于安全沙箱。

用户已确认的完整文件交付、Agent、Workflow、恢复与并行边界将在 [版本计划](../roadmap/README.md) 对应切片实现。浏览器、API 和布局状态后续接入，当前未创建占位包。

engine/harness 定义任务、计划、事件与结果及显式注册；integrations/harness/codex、claude、deepseek 各自映射和解析，不读文件/秘密或启动进程。engine/auth 是凭据存储与租约接口，integrations/auth/file-store 执行宿主文件和跨进程占用操作。私有工作副本通过 integrations/execution 的 PrivateStateBinding 与后端连接，认证模块负责租约与实际清理后的条件刷新；真实 provider 与计划兼容性仍须组合层兑现才能执行，不能把声明视为能力证明。Claude 订阅与 DeepSeek API key 组合已接通，真实官方模型调用尚未验收。详见 [接口指南](../guides/harness-auth.md)。

integrations/egress 负责独立 CONNECT 传输策略，integrations/docker/egress 负责每次执行的代理和网络资源。二者不读取认证存储或解释业务；宿主环境选择目标列表，后续 Profile 绑定再提供实际服务配置。见 [受控联网](../guides/controlled-egress.md)。

integrations/execution/codex-runner 组合首个服务 Profile、纯 Adapter、私有绑定和 Docker。版本探测使用同一不可变镜像；返回可清理句柄，Runner/Harness/凭据状态分别保留。首个真实单/多出口组合已通过明确授权的数字任务验收，真实 OAuth 刷新仍未触发。

Workflow 编译器只通过 catalog 解析定义、实现和契约；运行控制只调用单节点端口，不依赖 Harness 或 IO。定义及计划、输入和运行查询取副本；每条业务出口与执行失败分开。详见 [串行 Workflow](../guides/workflow.md)。

integrations/execution/credential-runner 和 credential-agent-driver 复用版本预检、执行/凭据收尾和 Agent 文件交接。独立配方选择订阅长租约或静态 key 快照，以及 stdout/具名会话证据；provider 不进入 engine/Docker 条件分支。DeepSeek 容器资产由 apps/deepseek-tools 的固定命令打包，再由受信宿主显式交给执行入口，库不反向加载应用源码。见 [DeepSeek 执行说明](../guides/deepseek-adapter.md)。

engine/persistence 提供 RunRecordStore 与 revision 错误契约，integrations/persistence 使用私有 SQLite/WAL 实现完整记录的 CAS。存储端口不调用执行或认证模块；Workflow 检查点负责接纳与路由事实，独立文件归档负责耐久产物，恢复协调经共同 Runner 核对旧资源后进入正常新 Attempt。详见 [存储](../guides/run-record-store.md)和[恢复](../guides/workflow-recovery.md)。
