# Workflow 文件节点与 Agent 交接验证

2026-09-09，基于本地串行 Workflow 提交 b8fb187，继续 Issue #9。主责 @xiaoxuanli-a；Codex 实现和作者自查，未进行独立多人评审。仍在独立工作区，未新增第四个远端 PR 或合并前三层。

## 实现与参考

新增 integrations 的 `FileWorkflowCatalog`，把可信文件函数与既有 AgentExecutor 接到同一个串行执行端口。文件引用由私有登记表签发并绑定 Run；Workflow 收据记录跨 Agent/Gate 的来源，Agent 一次执行收据仍由 AgentExecutor 接纳。增加无副作用的 Agent 请求预检供登记和编译使用。核心 compiler/runtime 无文件、认证或 provider 分支。

遇到跨确定性节点的前序交接问题，先查看 Blackbox 5610d1b 的 runtime `_issue_execution_receipt` 与收据材料物化/校验：沿用宿主建立流程链、执行记录与真实材料分开复核的取舍。当前实现只保留进程内私有登记，不复制旧实现的持久记录协议，也不导入调用方生成的收据正文。先在既有组件决定补充边界再实施。

## 测试证据

新增 12 组文件 Workflow 集成测试，使用真实本机文件扫描、复制、契约和 SHA-256 复核；Agent 驱动是显式合成测试实现，没有调用模型：

- Agent → Gate → Fixer → Gate 按用户路由跑完四步；最终 revision=2，原文件字节仍为 revision=0。每步前序引用与输入 manifest 连续，Agent 的重复输入捕获内容一致；修改公开记录不改变登记事实。成功清理节点目录，显式释放所有引用后快照存储为空。
- 伪造 manifest/引用、另一 catalog、跨 Run、不同契约和已释放文件不能执行；修改私有快照内容后，摘要复核在函数调用前失败。
- 非法 outcome、JSON schema 违约和任意函数异常不进入业务路由；公开错误保留契约/相对位置，不泄露任意异常正文。
- 活动输入不能释放，活动节点不能清理；取消等待可信函数结束。实际登记取消后，Agent 停止未证实仍保留为 failed/EXECUTION_STOP_UNCONFIRMED。
- Agent 执行资源清理失败阻止接纳，保留工作区和清理句柄；恢复后资源可释放，原 Run 仍失败。没有任何停止证据的启动异常也不删除工作区或宣称取消完成。
- Agent 配置预检不执行或捕获输入；失败 Attempt 不能重放。Agent 收据输入与 Workflow 前序不一致时，拒绝发布该步引用。
- 已存在但权限不合格的工作根在放入私有输入之前被拒绝。
- 自查补强直接执行入口的 Component/身份副本；调用方或函数在等待期间修改对象，不会改变原请求、结果身份或清理归属。

启用全部现有环境验证运行：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=agentflow/harness-codex-chatgpt:55517b18fd19 npm run check
```

**116 项通过，0 失败，0 跳过**，包含依赖边界、构建、测试类型检查、原有真实 Docker/代理/合成凭据验证，以及实际 Codex 的离线沙箱和启动探针。最终回归包含补强的不同已登记契约引用与异步入参快照断言。未读取真实认证或学生资料；既有公网 egress 探针为固定无认证请求。本地结果不是新 PR 的 CI 结果。

## 限制与下一步

本次证明真实文件 IO 与一次 Agent 接纳接口的连接，不代表真实模型 Workflow 或 Tutor 批卷完成。可信函数不是沙箱，必须在 Promise 结束时停止全部写入。宿主控制工作区祖先；私有引用/历史只驻留当前进程。Agent 输入多捕获一次，以保留分层接纳；尚未进行性能优化。

脚本、模拟 Effect、Tutor 合成闭环与真实消费端验收仍在原计划内继续。CLI 尚未提供 Workflow 文件加载命令，持久化、队列、自动重试和并行仍属后续 Issue。若驱动只抛异常、没有返回停止/恢复能力，适配保留资源并拒绝猜测停止；安装的驱动仍须兑现清理句柄契约。

[文件 Workflow 指南](../guides/workflow-files.md) · [组件决定](../../.agents/agent_notes/product/README.md#p-20260909-component-execution) · [串行控制验证](2026-09-09-workflow-serial.md)
