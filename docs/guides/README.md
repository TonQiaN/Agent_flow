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

- [订阅登录协调接口](subscription-login.md)
