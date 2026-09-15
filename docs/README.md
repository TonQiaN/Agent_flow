# 项目文档

这里说明项目当前是什么、怎样使用、怎样验证；roadmap 是明确标识的当前规划区域。决定及其取舍只在 .agents/decisions 维护；materials 是独立的宽松原始资料区。

**当前状态：可运行确定性 Component、JSON contract、Docker Runner 与受控 CONNECT 联网、独立 Harness 计划/parser、文件契约与快照交接、Agent 接纳与进程内可信收据、私有凭据存储/执行绑定。串行 Workflow 编译/路由/有界返修及 JSON 函数、文件函数、Agent 接纳、确定性脚本、文件到 JSON 转换及模拟 Effect 适配已实现；Tutor 合成批卷已接通 Gate、返修和模拟发布，真实 Codex 也已通过同一合成材料的正常及返修流程。持久化及节点边界恢复已完成首版作者验收，包含 API key 与订阅组合；PR 交付、队列、重试和并行尚未完成；真实刷新、真实学生批卷、完整报告和 PDF 尚未验收。**

| 入口 | 内容 |
| --- | --- |
| [架构](architecture/README.md) | 当前边界与尚待设计的问题 |
| [使用指南](guides/README.md) | 当前仓库用法与未来用户指南入口 |
| [仓库结构图](reference/repository-map.md) | 正式目录职责，原始区只列边界 |
| [文档维护](development/documentation.md) | 决策的查找、记录、转换及校验 |
| [资料管理与团队共享](development/materials.md) | materials 的 Git 边界、原件保留与飞书 CLI 共享 |
| [开发工作指南](development/workflow.md) | Issue 整理、预检记录、PR 模板与当前能力边界 |
| [源码组织与工程检查](development/code-structure.md) | 当前代码职责、导入边界与构建测试命令 |
| [Issue 分类与填写](development/issue-templates.md) | 五类主表、领域分类、Sub-issue 自主表达与 PR 衔接 |
| [Roadmap](roadmap/README.md) | 阶段方向、版本安排与按需版本计划 |
| [Changelog](../CHANGELOG.md) | 已实现的变化与发布记录 |
| [版本维护](development/versioning.md) | 版本规划、PR 变更记录和手工发布步骤 |
| [验证记录](validation/README.md) | 已执行检查、结果与局限 |
| [重大事故复盘](postmortems/README.md) | 永久保留的影响、根因、遗漏与修正 |
| [决策索引](../.agents/decisions/README.md) | 期望与理由的权威入口 |

规划与当前行为明确区分。功能落地后再更新操作示例和验证事实，不因决定已接受就写成已实现。

当前使用入口：

- [串行 Workflow](guides/workflow.md)、[文件交接](guides/workflow-files.md)、[Script](guides/workflow-scripts.md)与 [Effect](guides/workflow-effects.md)。
- [Claude 组合](guides/claude-execution.md)、[DeepSeek 组合](guides/deepseek-adapter.md)、[认证管理](guides/auth-management.md)、[订阅登录](guides/subscription-login.md)与[有限备份恢复](guides/credential-recovery.md)。
- [显式中断恢复](guides/workflow-recovery.md)、[实际 Agent 阶段](guides/workflow-phases.md)、[订阅资源恢复](guides/subscription-resource-recovery.md)与 [#13 作者验收对照](validation/2026-09-10-issue13-acceptance.md)。
- [持久批卷应用](guides/persistent-tutor-grading.md)：原始来源、Script 评分、用户返修、JSON 转换和当前发布授权共用正常引擎接口。已验证合成答卷与协议替身；真实学生卷、报告和 PDF 待验收。

[完整指南索引](guides/README.md)保存其他能力入口；[验证索引](validation/README.md)保留各次版本、范围与失败记录。历史切片的待办不代表当前仍缺该能力，以当前指南和验收对照为准。
