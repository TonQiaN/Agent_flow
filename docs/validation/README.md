# 验证记录

- [Codex 临时元数据权限与启动](2026-09-09-codex-startup.md)

这里记录实际执行的项目验证：对象和版本/范围、环境与方法、结果、限制及关联决定。大体积输出不必原样复制，但关键证据和结论必须在正式记录中自足。

| 日期 | 记录 |
| --- | --- |
| 2026-09-09 | [DeepSeek 原生文件服务隔离](2026-09-09-deepseek-file-isolation.md) |
| 2026-09-09 | [DeepSeek 配置与原生能力预检](2026-09-09-deepseek-compatibility.md) |
| 2026-09-09 | [Claude 调用计划与协议](2026-09-09-claude-adapter.md) |
| 2026-09-09 | [真实 Codex 批卷 Workflow](2026-09-09-tutor-grading-codex.md) |
| 2026-09-09 | [Tutor 合成闭环与文件转换](2026-09-09-tutor-grading-fixture.md) |
| 2026-09-09 | [模拟 Effect](2026-09-09-workflow-effects.md) |
| 2026-09-09 | [确定性脚本 Workflow](2026-09-09-workflow-scripts.md) |
| 2026-09-09 | [Workflow 文件与 Agent 交接](2026-09-09-workflow-files.md) |
| 2026-09-09 | [Agent 接纳与可信收据](2026-09-09-agent-acceptance.md) |
| 2026-09-09 | [文件契约与快照交接](2026-09-09-file-contracts.md) |
| 2026-09-09 | [Codex 订阅组合入口](2026-09-09-codex-composition.md) |
| 2026-09-09 | [私有凭据执行绑定](2026-09-09-credential-binding.md) |
| 2026-09-09 | [受控 CONNECT 联网](2026-09-09-controlled-egress.md) |
| 2026-09-09 | [真实 Codex 内部沙箱与只读配置](2026-09-09-codex-sandbox.md) |
| 2026-09-09 | [Harness / 认证接口与私有存储验证](2026-09-09-harness-auth-primitives.md) |
| 2026-09-09 | [Docker Runner 脚本验证](2026-09-09-docker-runner.md) |
| 2026-09-09 | [执行基础验证](2026-09-09-execution-foundation.md) |
| 2026-09-08 | [Issue 模板实施验证](2026-09-08-issue-templates.md) · [12 个填写与边界演练](2026-09-08-issue-template-examples.md) |
| 2026-09-08 | [七份 Issue 模板决定设计验证](2026-09-08-issue-template-decisions.md) |
| 2026-09-08 | [版本管理骨架验证](2026-09-08-version-management.md) |
| 2026-09-07 | [文档管理骨架验证](2026-09-07-documentation-foundation.md) |
| 2026-09-07 | [开发流程文档与模板验证](2026-09-07-development-workflow.md) |

当前产品验证覆盖确定性 Component、Docker Runner 与受控联网、Harness parser 与凭据存储，包含首个真实 Codex 小任务、文件交接、串行 Workflow、文件到 JSON 转换及 Tutor 合成 Agent/Gate/Fixer/模拟 Effect 闭环；真实批卷、报告和 PDF 验收仍未完成。正式重大事故复盘见 [复盘入口](../postmortems/README.md)。

- [Workflow 编译与串行控制](2026-09-09-workflow-serial.md)

- [Claude 订阅执行、刷新与真实格式识别](2026-09-09-claude-execution.md)

- [Claude 管理配置修复与实际工具隔离](2026-09-09-claude-tool-isolation.md)
