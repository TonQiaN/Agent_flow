# 已合入变化的版本归类与文档交接

2026-09-11，依据 [Issue #32](https://github.com/TonQiaN/Agent_flow/issues/32)，主责 xiaoxuanli-a，Codex 实施与作者自查，无其他开发者独立审阅。

## 对象与范围

基于已合并 main `fb635272b49bbb89867fbaf3821c26f07b290e8f`，核对最近合入的 #17、#18、#19、#23、#24、#26。新分支只修订版本/开发决定、指南、CHANGELOG、Roadmap 与本验证记录；开放 #25、#27–#31 的产品代码和能力没有纳入本次主干变化。

远端 tags 与 releases 在本次开工核对时均为空，当前没有正式发布版本。目标 0.1.1 来自已确认版本计划，不把它标为完整验收或实际发布。0.1.2/0.1.3 仅保留计划入口，不建立没有本次主干实际条目的 CHANGELOG 空组。开发协作变化单列，不给文档历史虚构产品版本。

## 事实映射与修正

| 原有记录 | 本次处理 | 已有证据入口 |
| --- | --- | --- |
| Component、Runner、首个 Codex 组合及串行 Workflow 的逐步新增 | 在目标 0.1.1 下按最终功能归类，保留隔离、失败、授权、收据及模拟 Effect 边界 | [执行基础](2026-09-09-execution-foundation.md)、[Runner](2026-09-09-docker-runner.md)、[组合](2026-09-09-codex-composition.md)、[Workflow](2026-09-09-workflow-serial.md) |
| 旧“完整 Workflow/Tutor 流程待完成” | 明确已完成串行合成闭环，单列真实刷新、其他组合和真实学生/报告的主干验收缺口 | [合成闭环](2026-09-09-tutor-grading-fixture.md)、[真实 Codex 合成试题](2026-09-09-tutor-grading-codex.md) |
| 0.1.1 计划累计测试次数与“下一步 Workflow” | 改为四个已合并 PR、当前能力及剩余整体验收，链接原验证结果 | 上述记录与 [文件交接](2026-09-09-workflow-files.md)、[模拟 Effect](2026-09-09-workflow-effects.md) |
| 五表旧方法字段与新版主/子项要求同时出现 | 只描述当前五类主表与子项自主表达，历史变更继续由原验证记录保存 | [主 Issue 线上验收](2026-09-10-main-issue-templates.md) |

参考核对限定为 Blackbox Agent Flow 的 CHANGELOG 入口及当前 AGENTS.md 中版本相关内容；没有复制其版本历史，也没有将参考仓库的检查结果当作 AgentFlow 验证。

## 本次校验

校验方法为正式 Markdown 的相对路径/标题锚点、决策唯一 ID 与生命周期路径、AGENTS/CLAUDE 未变、非文档树未变、差异空白及 CHANGELOG 分组检查。已核对 80 份正式 Markdown 的 354 处相对链接与标题锚点、20 个决定 ID，均无缺失或重复；无正文 status 字段或对 materials 路径的正式决定依赖。CHANGELOG 仅包含有实际条目的目标版本分组，每组分类不重复，未生成发布日期或空版本。差异空白检查通过，AGENTS/CLAUDE 与非文档文件相对 main 无改动。本次不重新执行代码、Docker、官方模型或学生材料验收，原运行证据保持对应提交与限制。

## 交接边界

开放 PR 的文档/流程问题分别交回各自 PR，不把本记录作为它们全代码正确性的批准。旧 head 的审阅或 CI 不能自动代表更新后的提交；仍可据明确的无行为变化和受影响验证复用原证据，不机械要求每次文档更新全量重跑。

本次不修改产品验收范围、自动门禁、审阅人数或 AGENTS 归属，不创建 tag、执行发布或合并。版本管理决定本次范围仍是已落实的文档机制；开发流程决定的完整产品流程与自动化尚未完成，继续保留 proposed。
