# 版本管理骨架验证

日期：2026-09-08。工作项：[Issue #4](https://github.com/TonQiaN/Agent_flow/issues/4)。主负责开发者：xiaoxuanli-a；Codex 协助实施与自查，未进行其他开发者独立审阅。

## 对象与基线

基线为 main 的 `ec967fdc7a0e5447a43239652f339f50112b342d`；验证对象为 `codex/version-management` 相对该基线的版本管理文档改动。最终提交 SHA 在 PR 中记录，避免正文引用自身提交。

实现范围包括 [Roadmap](../roadmap/README.md)、[CHANGELOG](../../CHANGELOG.md)、[维护指南](../development/versioning.md)、相关决定、根指令、PR 模板和文档导航。首次产品版本及实际发布不在本次范围。

## 已执行验证

环境为本地 macOS、Python 3 与 Git。未加载或全文搜索 materials 内部资料。

| 验收项 | 方法与结果 |
| --- | --- |
| 文档链接与索引 | 用 Python 检查正式 Markdown 的本地相对链接、文件和标题锚点，排除外部链接及代码示例；通过 |
| 决策唯一性 | 核对稳定 ID 无重复、正文无独立 status 字段、分类索引指向实际正文；通过 |
| 指令唯一归属 | 核对两份 AGENTS.md 仍由 D-20260907-agents-writing 负责；根文件新增版本维护入口，未新增共同负责决定；CLAUDE.md 仍是根 AGENTS.md 的符号链接 |
| 目录与版本事实 | roadmap 仅有总览，没有空版本文件或系列目录；CHANGELOG 仅有 Unreleased，无伪造版本或日期；没有 VERSION 或产品包版本文件 |
| 维护职责与边界 | 按 Issue 验收逐项对照：四项版本计划内容、四个维护时点、按需文件、小补丁例外、唯一状态与正文分工均有说明 |
| 手工发布流程 | 自查准备记录、验收、确切提交、annotated tag、远端指向核对及发布事实回填；待发布记录与已发布状态分开，历史 tag 不移动 |
| PR 交接 | 模板新增 roadmap / CHANGELOG 更新或不适用说明，保留每个 PR 的实质决策正文要求；普通 PR 不执行发布步骤 |
| 文本差异 | `git diff --check` 通过；人工核对变更范围与现行流程，无产品实现或发布自动化改动 |

## 验证限制

提交前已通过 `git ls-remote --tags origin` 只读确认远端没有 tag；本次没有创建或推送 tag，没有发布 GitHub Release，也没有运行产品、CI 或真实发布演练。外部网页和链接内容未逐个在线验证，本地链接检查不能证明外部页面可访问。

验证结论仅支持版本管理骨架已建立。相关 [版本管理决定](../../.agents/decisions/development/README.md#d-20260908-version-management) 的 implemented 范围限于文档、模板和规则，不表示产品或发布自动化已经实现。
