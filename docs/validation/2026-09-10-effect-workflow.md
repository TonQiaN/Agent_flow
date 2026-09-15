# 固定操作 Effect Workflow 恢复验证

本轮接续 Issue #13 的操作日志，将 Effect 接入正常 Workflow 的实际执行描述、严格加载和恢复认领。先核对 Blackbox v0.1.22 / 5610d1b 中回执提交后宿主中断、跨 Run 回执复用及身份/输入关联测试，沿用可靠回执复用、未知不重发的边界。

## 实现

EffectAdapter 可提供实际版本化 definition；EffectExecutor 固定其方法，组合 implementation、serviceIdentity 和真实持久日志 identity。EffectWorkflowCatalog 增加固定 target/key 描述，持久启动首期要求固定描述、apply、真实日志及适配器执行描述。旧函数映射及 dry-run 普通调用保留，持久能力不足时在写 Run、授权或调用服务前拒绝，不序列化闭包或恢复旧 grant。

已接纳 Effect 的 JSON 输出通过严格加载器的一次性请求，由 Effect 层核对前序输入、实际映射、完整回执及操作日志的 applied 事实；引擎不解析服务专属协议。活动 Effect 恢复只读核对日志，pending 在 Run CAS 认领前阻塞；无占位或回执已提交才进入原恢复/新 Attempt 路径，最终仍受唯一操作占位保护。原宿主和恢复者的 Run 写入受同一 CAS 约束。

## 已执行验证

本地 Node 26。新的实际 Workflow 子进程测试使用持久 SQLite Run/Effect 日志和 fsync 文件模拟外部服务；不是内存假重启，没有真实业务服务或模型调用。

新增 8 项 Workflow 测试覆盖 A 已接纳、B 在占位前/占位后/外部写入后/回执提交后四个真实 SIGKILL 点；A 仅写一次，pending 不改变 Run 或调用授权，已提交回执由新 Attempt 复用。原宿主暂停在 B 占位前时，恢复者完成后允许原宿主继续，其重复占位/迟到 Run 写入被拒绝；两个恢复者基于同一 revision 竞争也仅一个成功。撤去当前授权不会复活旧 grant。服务版本/身份、固定目标、日志命名空间变化，以及已接纳输入/回执篡改均拒绝加载，不调用服务或授权策略。

新增 2 项引擎测试验证不支持的持久组合在任何写入前拒绝、旧动态普通执行保留，以及注册时复制固定操作、安装时固定描述方法和返回描述副本。首轮 25 项定向检查通过；增加这两项时测试的 schema 字面量被推断为宽泛 string，改为明确 EffectReceipt 返回类型后继续验证。测试控制器等 IPC 消息送达后才杀进程，避免把测试通知丢失当成产品崩溃行为。

最终 27 项定向测试通过，约 3.89 秒；325 项常规测试通过，约 11.99 秒，包含原 Tutor 合成批卷/返修/权限回归。另有 42 项实际 Docker Agent、脚本检查点及恢复回归通过，约 103.05 秒，用于检查共享加载器/恢复接口变动。各轮均 0 失败、取消、跳过，定向测试属于常规测试子集，不相加。

构建、测试类型检查、包边界、688 个本地文档路径链接与 diff 检查通过；链接检查不验证远端或锚点。没有产品测试失败；上述为作者检查，不代表独立审阅、Node 24 CI 或硬件断电验证。

## 未完成范围

支持的是固定操作、apply 与真实描述/日志组合。动态函数映射和 dry-run 的持久启动尚未支持；JSON Gate/Transform 等其他实际执行绑定、订阅恢复和 #13 完整验收仍待完成。未知服务操作没有核对能力时继续阻塞，不添加盲目重试、旧授权导入或任意外部服务 exactly-once 保证。真实学生批卷、报告和 PDF 尚未验收，通用崩溃 GC 不作为额外前置。

[Effect 指南](../guides/workflow-effects.md) · [恢复指南](../guides/workflow-recovery.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
