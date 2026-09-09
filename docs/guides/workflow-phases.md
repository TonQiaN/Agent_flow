# Workflow 通用执行阶段

受信 executor 可通过 `resourcePlan(component)` 声明有限的有序阶段；`resource` 阶段持有一个共同 Runner 资源，`operation` 阶段标记宿主操作。Engine 不解释认证、业务说明或模型协议。当前内置 Script 保留单资源接口；不可变环境 API key 的 Agent Driver/Catalog 已接入，当前以 DeepSeek 合成协议验证。

声明必须来自当前安装代码，包含 schema `agentflow-invocation-resources/v1`、唯一阶段 ID、kind，以及 resource 阶段的实际 execution 描述。计划为 1–8 个阶段，进入后必须全部完成才能接纳业务成功。它随实际执行快照 version 2 保存和核对，改变顺序、类型或环境会拒绝加载。该计划不是新增业务节点或可反序列化的执行程序。

持久调用的 execute 第六参数为可选 `InvocationPhaseSink`。调用 `await phases.enter(id)` 后取得句柄；resource 句柄的 `resource` 传给共同 Runner，宿主操作句柄没有资源端口。副作用必须在 enter 成功后开始，完成并确认收尾后调用 `await handle.complete()`，再进入下一阶段。普通非持久运行仍没有这个参数。

阶段进入、资源、launch 和完成都通过同一 Workflow writer 提交 CAS。保存失败关闭该端口；重复完成、越序进入、旧句柄、重叠写入、跨身份和重复资源拒绝。资源阶段不能在没有资源或 launch pending 时完成；这些验证不能替代实际 executor 对操作成功与资源收尾的确认。

检查点 v5 的多阶段 Attempt 带 phases，原 resource/launch 均为 null；原单资源 Attempt 不带 phases。严格加载核对计划前缀、身份、资源唯一性和状态，已接纳结果必须完成全部阶段。旧未发布 v1–v4 不自动迁移。

恢复仍经原 claim/cleanup/resumePersisted 接口。活动宿主 operation 或 pending launch 缺少安全接管证据，拒绝认领且不修改记录。其他可恢复状态按反向顺序清理所有已保存的阶段资源，包括已经标记完成的阶段；只有全部确认后才允许同一 NodeTask 的新 Attempt。已接纳前序节点保留，阶段数量不消耗业务步骤预算。清理部分失败可重试，迟到 worker 不能覆盖新的 CAS revision。

实际 Agent 的阶段接线和文件收据已接入；探针与 Driver 输入已归入 Runner 目录；Catalog 等其他宿主临时目录的崩溃清理、订阅占用接管和真实官方模型恢复尚未验收。此接口不授予凭据读取、强制解锁或 Effect 重放能力。验证见[阶段记录](../validation/2026-09-10-workflow-phases.md)，取舍见[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)。

## 实际 Agent 组合

沿用普通 FileWorkflowCatalog.registerAgent、AgentExecutor 和 Driver；准备 archive、store 后使用相同 startPersisted/claimWorkflowRecovery/resumePersisted。CredentialAgentDriver 的声明顺序是 version 资源、credential 宿主操作、execution 资源。版本成功且释放后才完成 version；获取前保存 credential active，源短租约释放后才完成该操作；execution 仍由共同 Runner 保存实际资源和 launch。输出由正常 AgentExecutor 接纳、捕获为快照，再释放执行目录并完成 execution，Catalog 随后返回成功。

获取前 CAS 失败不会访问凭据；获取完成的 CAS 失败会放弃内存绑定，不分配执行资源。若宿主在获取操作内中断，记录保持不确定，自动认领拒绝。Codex/Claude 订阅 Driver 当前资源计划为 null，实际定义仍可比较，持久启动继续拒绝。恢复管理旧资源不访问凭据；只有进入新的正常 Attempt 才重新获取当前凭据。

严格文件加载同时核对外层前序引用、归档清单和内层 Agent 收据的身份、组件、outcome、Harness、版本及实际镜像。内层输入可有独立快照 ID，但文件内容必须与前序清单完全一致；输出清单须与归档一致。File Catalog 使用源文件调用 Agent，因此内层 predecessor 必须为 null。收据不会导入新 AgentExecutor 的进程内映射，也不会重跑旧模型或重做业务接纳。见[实际组合验证](../validation/2026-09-10-agent-workflow.md)。

探针不再创建外部空输入目录，Driver 输入直接在 Runner 已登记目录内物化；正常与恢复 release 统一收尾，见[输入物化](runner-owned-input.md)。其他宿主临时目录仍待处理。

Catalog 与 AgentExecutor 共享支持 inspect 的同一实际存储时，阶段开始前无需另建 node 输入目录或重复捕获快照；借用引用在停止未确认时保留至清理成功。不同存储保留原路径回退；内置存储的检查点/恢复中间目录已由直接物化消除，未发布存储暂存和旧进程临时快照仍待处理，见[输入复用验证](../validation/2026-09-10-catalog-snapshot-input.md)。
