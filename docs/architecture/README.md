# 架构

当前实现包含 domain、engine、integrations 和 CLI。domain 保存业务类型与身份；engine 的 contracts 注册 JSON Schema，components 分别注册定义、函数实现并协调一次执行；CLI 组合这些公共接口。

文档架构依据 [分层决定](../../.agents/decisions/development/README.md#d-20260907-documentation-layers)；具体位置见 [结构图](../reference/repository-map.md)。

当前依赖方向与开发说明见 [源码组织与工程检查](../development/code-structure.md)，目录选择的理由见 [源码结构决定](../../.agents/decisions/development/README.md#d-20260909-source-layout)。确定性调用接受独立 JSON 副本，函数直接返回 outcome/output，引擎校验对应契约；业务 rejected 可以正常接纳，违约或异常属于 failed。具体接口见 [Component 使用指南](../guides/components.md) 和 [执行决定](../../.agents/decisions/product/README.md#p-20260909-component-execution)。

Run/NodeTask/Attempt 当前只有身份与校验，尚无分配器、调度或持久化。Component 不持有路由、文件系统、Docker、认证或 Harness。engine/runner 协调一次执行，integrations/docker 实现文件与容器操作；Runner 与 Component 仍分别使用，尚未集成为 Workflow。可信函数运行在调用进程中，内存副本隔离不等于安全沙箱。

用户已确认的完整文件交付、Agent、Workflow、恢复与并行边界将在 [版本计划](../roadmap/README.md) 对应切片实现。浏览器、API 和布局状态后续接入，当前未创建占位包。
