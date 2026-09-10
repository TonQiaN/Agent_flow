# 项目文档

这里说明项目当前是什么、怎样使用、怎样验证；roadmap 是明确标识的当前规划区域。决定及其取舍只在 .agents/decisions 维护；materials 是独立的宽松原始资料区。

**当前状态：可运行确定性 Component、JSON contract、离线 Docker Runner、示例及工程检查。完整 Workflow、文件 contract、认证/Harness、持久化、队列、重试和并行尚未实现。**

| 入口 | 内容 |
| --- | --- |
| [架构](architecture/README.md) | 当前边界与尚待设计的问题 |
| [使用指南](guides/README.md) | 当前仓库用法与未来用户指南入口 |
| [仓库结构图](reference/repository-map.md) | 正式目录职责，原始区只列边界 |
| [文档维护](development/documentation.md) | 决策的查找、记录、转换及校验 |
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
