# 使用指南

当前支持确定性 Component、JSON contract 与 Docker Runner。前置条件为 Node.js 24 或更新版本及 npm；完整测试另需 POSIX 环境与 Python 3（真实伪终端测试）；包均为仓库内部包，尚未发布安装包。

在仓库根目录运行：

```sh
npm ci
npm run check
npm run demo
```

demo 输出单条 JSON，status 为 accepted、outcome 为 completed、output.total 为 6。错误命令返回退出码 2；另有 [本地认证管理](auth-management.md) 子命令；Workflow 库的启动、查询或取消见独立指南。

[Component 使用指南](components.md) 说明注册与执行接口、错误和副本语义。[验证记录](../validation/2026-09-09-execution-foundation.md) 区分已运行检查和后续能力。

从 [文档入口](../README.md) 了解当前能力，再查对应决定与说明。维护正式知识使用 [文档维护指南](../development/documentation.md)；原始资料区不要求统一整理方式，不作为日常开发默认上下文。

[Docker Runner](runner.md) 提供可写文件副本、原始采集和真实取消/清理；完整 Agent、Workflow 和批卷流程继续实施，当前示例未调用模型或外部业务服务。

[Harness / 认证接口](harness-auth.md) 说明首个组合已实现的计划、parser 和凭据租约，以及真实订阅小任务和未完成边界。

[受控联网](controlled-egress.md) 说明独立代理、精确目标及真实网络验证；首个 Codex 订阅组合已接通。

[文件契约与独立交接](file-contracts.md) 说明 outputs 自动收集、目录树约束、JSON 文件 schema 与交接完整性检查。

[Agent 接纳与可信收据](agent-acceptance.md) 说明单次执行接纳、可信前序引用和失败后的清理句柄。

[Workflow 编译与串行执行](workflow.md) 说明当前 JSON 函数流程、用户定义返修上限和取消边界。

- [Workflow 文件节点与 Agent 交接](workflow-files.md)

- [确定性脚本 Workflow](workflow-scripts.md)

- [模拟 Effect 与 Workflow](workflow-effects.md)

- [Tutor 合成批卷与文件到 JSON 转换](tutor-grading-fixture.md)

- [真实 Codex 批卷 Workflow](tutor-grading-codex.md)

- [Claude 调用计划与协议](claude-adapter.md)

- [Claude 订阅执行组合](claude-execution.md)

- [订阅登录接口与终端入口](subscription-login.md)

- [私有凭据备份与恢复](credential-recovery.md)

- [三种 Harness 共用批卷验收](harness-grading-matrix.md)：显式组装、离线预检和同一业务契约。

- [本地 Run 记录存储](run-record-store.md)：SQLite/CAS 基础，尚未连接流程恢复。

- [耐久文件归档](artifact-archive.md)：独立归档保留、摘要引用与跨进程物化。

- [Workflow 结构快照](workflow-structure.md)：实际注册定义、跨 Catalog 一致性和有限证明范围。

- [Workflow 执行绑定快照](workflow-execution-snapshot.md)：断网脚本实际绑定、镜像冻结和变化拒绝。

[Workflow 检查点](workflow-checkpoints.md)：共享正常执行中的耐久值、状态提交和异步取消；重启恢复未开放。

[检查点加载与文件恢复](workflow-checkpoint-loading.md)：实际定义、历史和收据核对，独立文件副本与失败回滚；重启执行仍待接通。

[Runner 资源保存与恢复](runner-resource-recovery.md)：实际资源先落盘、跨进程核对及停止/移除；Workflow 新 Attempt 恢复仍待接通。

[Workflow 恢复认领与旧资源清理](workflow-recovery.md)：同一 Run CAS、并发与崩溃后接管、只读检查；新 Attempt 执行仍待完成。

[Workflow 通用阶段](workflow-phases.md)：有序资源和宿主操作、共同 CAS 与中断恢复边界。

[Runner 输入物化](runner-owned-input.md)：在已登记资源目录内准备 ArtifactStore 快照或空输入。

[确定性 JSON 函数](deterministic-functions.md)已接通版本/配置快照和无资源节点恢复；普通函数、文件函数及完整 #13 仍有验收缺口。

[批卷文件 Script](tutor-file-scripts.md)：复用现有 Runner 的 intake/Gate 绑定。

[批卷原始来源的准备与重开](tutor-source-reopening.md)。

- [指定 JSON 文件转换](json-file-projection.md)：固定读取、契约接纳、持久来源证明与恢复边界。

- [持久批卷应用组合](persistent-tutor-grading.md)：显式启动/重开、用户返修、来源链与当前发布策略。
