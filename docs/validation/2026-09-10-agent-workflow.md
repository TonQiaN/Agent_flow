# 实际 Agent Workflow 阶段与文件收据验证

本轮实现 Issue #13 的不可变 API key Agent 接线，沿用通用阶段、共同 Runner、正常 Agent 接纳和原 Workflow 恢复循环。实际组合为 FileWorkflowCatalog → AgentExecutor → DeepSeekAgentDriver → CredentialHarnessRunner → DockerBackend；SQLite 保存真实运行记录，文件使用独立归档。

测试运行于本地 Node 26 和 Docker。DeepSeek CLI 为合成协议程序，固定启动器、出口隔离、私有会话捕获和 Adapter/parser 使用产品实现。全部密钥为专用测试值，没有官方模型、真实凭据、真实学生材料或生产操作。本记录不证明真实评分质量或 #13 整体验收完成。

## 实现与验证

Driver 声明 version、credential、execution 三阶段；Engine 仍只认识资源和宿主操作。获取前 CAS 成功后才访问存储，获取并释放源短租约后再完成 credential；完成写入失败放弃内存绑定并阻止执行资源分配。正常输出由 AgentExecutor 检查、捕获后释放执行目录，才完成 execution。恢复按原 CAS 认领、反向清理全部资源、正常新 Attempt 的顺序进行。

File Catalog 的严格加载新增 Agent 收据核对。实际 Driver 给出 Harness/版本/镜像，外层前序引用和内层输入内容、输出清单、组件/身份/outcome 必须一致；内层 predecessor 为空，因为 Catalog 以文件源调用 Agent。只有原加载器的一次性能力可进入此路径，不增加 Agent 收据导入或旧输出重新接纳接口。订阅 Driver 不声明资源计划，实际定义仍可比较，持久启动继续拒绝。

- 最终普通测试 295 项通过，0 失败、取消、跳过，耗时约 9.16 秒。
- 相关 Docker 回归 68 项通过，0 失败、取消、跳过，耗时约 171.60 秒；覆盖三类 Agent 定义/组合、版本探针、不可变凭据资源、Script 检查点与恢复等。此轮在最后的失败清理保护之前执行。
- 最后补充失败清理保护后，三类 Agent 组合再次通过；实际 Agent Workflow 最终 8 项通过。不同轮次有重叠，不能相加当作独立用例总数。

实际 Workflow 新场景覆盖：A 的版本资源启动完成时 SIGKILL；A 已接纳后 B 执行时 SIGKILL；B 在新 Attempt 中再次 SIGKILL。删除宿主原始输入后，新进程恢复得到 sum=6；B 中断时 A 不重跑，B 使用 Attempt 2/3。加载及旧资源清理不调用凭据存储，新 Attempt 才获取凭据。已记录旧容器/代理消失，最终新进程只读加载、物化输出成功，revision 不变。

在 B 的 credential active 阶段杀宿主，认领拒绝且无凭据访问、无记录修改。获取前 CAS 故障产生 0 次获取；获取完成 CAS 故障产生 1 次获取，两者都不启动执行，测试可重新获取并释放源租约。收据的身份、Harness、版本、镜像、输入/输出摘要、内外前序关系、来源类型及额外字段篡改共十类反例均拒绝加载且不读凭据。

失败清理用例让 B 非零退出，正常 Workflow 保持失败并保留已接纳 A。调用保留的 cleanup 后，执行目录和 Driver 输入目录清空，原失败/阶段记录不被升级；独立加载仍显示失败。

## 参考与修正

实现前先检查 Blackbox runners.py 的 API key/订阅租约差异、runtime.py 的收据链核对。认证细节保留在 integrations，Engine 不引入凭据字段。

首轮旧定义测试仍假定 DeepSeek 无法持久启动；接通后无效文件引用在更后一步被正确拒绝，修正错误码断言，存储写入和凭据访问仍为 0。收尾审阅发现失败调用结束后阶段端口关闭，后续清理不应发布完成；先检查 Blackbox 对失败出口仍做独立收尾的处理，再让 retryCleanup 脱离原完成端口。新夹具首次加载误将非零任务说明换回正常说明，触发 WORKFLOW_EXECUTION_MISMATCH；对照 Blackbox 冻结定义规则，修正夹具保留原说明，未放松产品校验。

通用阶段接口类型放在 Runner 层，Workflow 保留阶段历史与协调实现，Agent 接纳模块不依赖 Workflow 调度模块。最终类型迁移仅改变类型声明；构建、测试类型、包边界、635 个本地文档链接及 diff 检查通过。

## 剩余边界

订阅占用与刷新接管、凭据获取实际中断的不确定状态，以及探针、Driver、Catalog 宿主临时目录的崩溃遗留清理尚未完成。测试 finally 仅清理自己创建的根目录，不作为生产崩溃清理证据。真实官方模型重启、完整认证矩阵、其他绑定/Effect、真实学生批卷报告和 PDF 尚未验收。作者验证不等于独立审阅或 Node 24 CI。

[阶段指南](../guides/workflow-phases.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
