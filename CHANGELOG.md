# Changelog

这里记录实际变化；未来目标见 [Roadmap](docs/roadmap/README.md)，维护方式见 [版本维护指南](docs/development/versioning.md)。目前尚无正式发布版本，Unreleased 不代表已发布。

## Unreleased

### 重要变更

- 五类表单明确用于主 Issue，增加“开发流程 / 项目内容”领域分类，聚焦当前情况与期望结果，保留缺陷事实并移除预设方法字段。开放空白入口；Sub-issue 的内容与形式由负责人自主决定，暂不提供模板或写作建议。同步主／子 Issue 与 PR 的职责、追溯和验收说明，见 [Issue #21](https://github.com/TonQiaN/Agent_flow/issues/21)。

### 新增

- 根 src 下的 TypeScript 工作区、严格编译、依赖边界检查与 Node 测试/CI 配置。
- 确定性 gate/transform Component、独立定义与实现注册、Run/NodeTask/Attempt 身份、严格 JSON Schema 契约和输入/结果副本；CLI 提供可运行 demo。尚不包含 Workflow、容器或真实 Agent。

- Issue 表单扩展为功能、缺陷、研究、决策、维护五类；加入交付物选择、续接记录和各类专用字段，支持仅交付正式决定的研究/讨论，并提供填写指南和边界示例。

- 建立 Roadmap 总览与按需版本计划方式，区分版本安排、任务进展和实际交付。
- 增加变更记录及手工发布维护指南，明确发布 tag、维护职责和 PR 中的同步时机。
