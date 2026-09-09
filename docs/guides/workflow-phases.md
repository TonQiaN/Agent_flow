# Workflow 通用执行阶段

受信 executor 可通过 `resourcePlan(component)` 声明有限的有序阶段；`resource` 阶段持有一个共同 Runner 资源，`operation` 阶段标记宿主操作。Engine 不解释认证、业务说明或模型协议。当前内置 Script 保留单资源接口；Agent Driver/Catalog 尚未接入此能力。

声明必须来自当前安装代码，包含 schema `agentflow-invocation-resources/v1`、唯一阶段 ID、kind，以及 resource 阶段的实际 execution 描述。计划为 1–8 个阶段，进入后必须全部完成才能接纳业务成功。它随实际执行快照 version 2 保存和核对，改变顺序、类型或环境会拒绝加载。该计划不是新增业务节点或可反序列化的执行程序。

持久调用的 execute 第六参数为可选 `InvocationPhaseSink`。调用 `await phases.enter(id)` 后取得句柄；resource 句柄的 `resource` 传给共同 Runner，宿主操作句柄没有资源端口。副作用必须在 enter 成功后开始，完成并确认收尾后调用 `await handle.complete()`，再进入下一阶段。普通非持久运行仍没有这个参数。

阶段进入、资源、launch 和完成都通过同一 Workflow writer 提交 CAS。保存失败关闭该端口；重复完成、越序进入、旧句柄、重叠写入、跨身份和重复资源拒绝。资源阶段不能在没有资源或 launch pending 时完成；这些验证不能替代实际 executor 对操作成功与资源收尾的确认。

检查点 v5 的多阶段 Attempt 带 phases，原 resource/launch 均为 null；原单资源 Attempt 不带 phases。严格加载核对计划前缀、身份、资源唯一性和状态，已接纳结果必须完成全部阶段。旧未发布 v1–v4 不自动迁移。

恢复仍经原 claim/cleanup/resumePersisted 接口。活动宿主 operation 或 pending launch 缺少安全接管证据，拒绝认领且不修改记录。其他可恢复状态按反向顺序清理所有已保存的阶段资源，包括已经标记完成的阶段；只有全部确认后才允许同一 NodeTask 的新 Attempt。已接纳前序节点保留，阶段数量不消耗业务步骤预算。清理部分失败可重试，迟到 worker 不能覆盖新的 CAS revision。

实际 Agent 的资源接线、文件收据、临时输入目录崩溃清理和订阅凭据占用接管尚未完成。此接口不授予凭据读取、强制解锁或 Effect 重放能力。验证见[阶段记录](../validation/2026-09-10-workflow-phases.md)，取舍见[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)。
