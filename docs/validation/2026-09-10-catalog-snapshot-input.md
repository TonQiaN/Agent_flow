# Catalog 借用输入快照验证

本轮处理 Issue #13 的同存储 Agent 冗余输入。先核对 Blackbox runtime.py 中收据输入/输出摘要关联、_collected_from_unit 对存储产物的复用和 _materialize_input 的 ArtifactReference 路径，再调整当前 Catalog。保留用户要求的独立可写容器副本，不套用旧系统只读输入规则。

## 实现与故障处理

ArtifactStore 增加可选 inspect；FileArtifactStore 仅返回本实例私有登记中的清单副本，不导入 JSON、跨实例 ID 或磁盘任意路径。AgentExecutor 新增 snapshotId 输入，检查返回 ID/contract，不重复捕获也不删除借用输入。Catalog 仅在相同实际存储且支持 inspect 时使用当前物理 storageId，跳过 node 目录；恢复的逻辑清单、外层前序关系和内层收据内容校验继续保留。不同存储仍物化并捕获输入，函数与脚本保持现有执行路径。

首轮定向检查 26 通过、4 失败。旧测试假设内外输入 ID 不同或必有 node 目录；进一步发现省掉目录后仍须保护未确认停止的输入引用。Catalog 因此保留引用使用计数至实际清理成功，拒绝提前 release；启动异常且无法证明停止也保持占用。清理不能将原失败结果升级为成功。调整旧断言并补充跨存储回退、未知快照/契约不符不启动及借用所有权检查后，定向 30 项通过。

## 已执行检查

本地 Node 26、真实 Docker、合成 DeepSeek 协议；没有真实凭据、官方模型或学生材料。

- 最终常规测试 299 项通过，0 失败、取消、跳过，约 6.47 秒。
- 最终实际 Agent Workflow Docker 测试 8 项通过，0 失败、取消、跳过，约 43.41 秒。
- 另有 Agent Workflow、检查点与恢复 Docker 回归 42 项通过，约 101.18 秒；这轮运行跨越引用保留修正和重构建，作为过程回归记录，不充当最终统一版本的完整回归。最终 8 项单独在产品修正后执行，与 42 项重叠，不相加。

常规检查包含新增 4 项：Agent 借用和错误拒绝、实际存储描述副本/实例边界、Catalog 同存储与不同存储回退。已有停止不明与启动异常测试验证 release 被阻止，清理后才可释放。最终 Agent 测试在真实版本阶段或 B 执行阶段 SIGKILL，断言无 Catalog node 输入目录、无活动 Agent 重复输入快照，随后移除源文件并恢复。连续 B 中断、已接纳 A 的收据、最终 sum=6、旧 Runner 目录清理和失败后清理重试均通过。

构建、测试类型、包边界、666 个本地文档路径链接与 diff 检查通过（链接检查不验证远端页面及锚点）。本记录为作者检查，不代表独立审阅或 Node 24 CI。

## 剩余范围

同存储复用不等于完整临时产物回收。Catalog 的 checkpoint/restore 暂存、不同存储与其他节点的 node 目录、旧进程初始/已接纳 ArtifactStore 快照、资源分配未登记窗口仍待处理。不能通过目录前缀、PID 消失或测试最终删除自有根证明这些边界已完成。订阅占用恢复、完整 #13 和真实批卷报告/PDF 尚未验收。

[Agent 输入](../guides/agent-acceptance.md) · [Runner 输入](../guides/runner-owned-input.md) · [持久化决定](../../.agents/agent_notes/product/README.md#p-20260909-run-persistence)
