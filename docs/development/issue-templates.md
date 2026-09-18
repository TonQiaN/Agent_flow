# Issue 分类与填写指南

本页对应 `.github/ISSUE_TEMPLATE/` 的五份主 Issue 表单与空白入口配置。设计依据见 [分类决定](../../.agents/agent_notes/development/README.md#d-20260908-issue-classification) 和 [共通决定](../../.agents/agent_notes/development/README.md#d-20260908-issue-template-common)，开发与交付衔接见 [工作指南](workflow.md)。本轮变更已通过 PR #23 合入默认分支，五类主表和空白入口已实际核对，验证范围见 [验证记录](../validation/2026-09-10-main-issue-templates.md)。

## 主 Issue 与 Sub-issue

主 Issue 让需求制定者说明当前情况、遇到的问题、想要的结果、必要边界及完成标准，使相关人员对整体需求有共同理解。制定者不必在建项时知道具体实现方式。

Sub-issue 关联到主 Issue，由对应负责人自主组织其承担的具体工作，对执行方案与交付负责。当前内容与表达形式完全由负责人自己决定，接受任意形式；项目不提供子项模板、固定字段、写作建议或示范正文。下面的选类、字段和填写例均用于主 Issue，不套用到 Sub-issue。待足够多的方案经过实施验证后，再从实践提炼共性形成模板。

通过 GitHub 的父子关系、Assignees 与交付 PR 可以追溯工作归属。这些关联不会把主表字段变成子项正文要求，也不把子项的自主表达当作取消人的责任。

## 选择领域与主要类型

主 Issue 的“所属领域”单选“开发流程”或“项目内容”。前者指团队开发、协作、文档治理及工作约定，后者指 AgentFlow 产品的能力、行为、架构与相关研究；交叉影响在范围中表达。主要类型按最后承诺交付什么选择，与领域独立。

2026-09-10 的实际 GitHub 表单会预选第一项“开发流程”，即使 YAML 没有配置 default。提交前请确认所属领域，必要时切换为“项目内容”；界面初始值不表示已完成分类判断。

| 主要目标 | 主 Issue 入口与标题前缀 |
| --- | --- |
| 新增或改变产品能力 | [主 Issue：功能与行为改进](../../.github/ISSUE_TEMPLATE/feature.yml) · `[功能]` |
| 恢复已约定但失效的行为 | [主 Issue：缺陷与回归修复](../../.github/ISSUE_TEMPLATE/bug.yml) · `[缺陷]` |
| 回答未知问题，得到有依据的结论 | [主 Issue：研究与证据验证](../../.github/ISSUE_TEMPLATE/research.yml) · `[研究]` |
| 作出团队需要的选择并形成正式决定 | [主 Issue：方案与决策讨论](../../.github/ISSUE_TEMPLATE/decision.yml) · `[决策]` |
| 落实工程、文档或协作改进 | [主 Issue：工程与流程维护](../../.github/ISSUE_TEMPLATE/maintenance.yml) · `[维护]` |

例如 #21 属于“开发流程＋维护”。产品功能内部有研究步骤也不因此更换主类；Prompt、文档或代码是载体，不能单凭文件名决定类型。父子关系不是第六种类型，任务依赖也不等于父子关系。不按每次 AI 会话或每个 PR 机械创建子项。

## 填写主 Issue

五类主表都有九项共同信息；除各类问题提示外，八项共同字段完整对象一致。必填表示就绪信息要求，事实未知时如实说明，必要阻塞在实施前处理。

| ID | 内容 | 填写时点 |
| --- | --- | --- |
| `domain` | 选择开发流程或项目内容 | 创建时 |
| `owner` | 一名人类主责的 GitHub 用户名，另设置 Assignees | 创建时 |
| `problem` | 当前情况、问题及期望结果，按类别提示表达 | 创建时 |
| `scope` | 包含、不包含，以及真实约束与依据 | 创建时 |
| `deliverables` | 多选实际承诺的交付物，在范围或验收中说明具体内容 | 创建时 |
| `acceptance` | 完成后应看到的结果、行为或结论质量 | 创建时 |
| `dependencies` | 无，或影响开工／交付的条件、所需结果及关联工作 | 创建时 |
| `decision_context` | 已知约束、依据和相关决定，可保留待澄清问题 | 可后补 |
| `handoff` | 实际确认、进展、未完成部分与关联交付的短摘要 | 可后补 |

交付物保留四个多选项：正式决策正文、实现文件（代码 / 配置 / 模板）、当前说明或使用指南、研究 / 验证记录。取消勾选不会自动撤销已确认的交付承诺。原始材料链接可选，正文应能独立说明需求。

主 Issue 不要求提前填写技术选型、内部结构、实现步骤、研究方法或测试方案。“完成后应看到的结果”表达成果，不把执行特定方法作为验收条件。确实必须保持的兼容行为、权限边界或已有用户约束可以写明，并说明依据。

| 类型 / 输入块数 | 问题提示与保留的专用内容 |
| --- | --- |
| 功能 / 9 | 当前场景与期望能力；正常、边界或失败时的期望行为可融入问题和结果 |
| 缺陷 / 11 | 实际与期望行为；保留 `reproduction` 复现步骤与已有证据、`environment` 版本与相关运行条件 |
| 研究 / 9 | 当前情况与希望弄清的问题；明确结论用途和可接受的完成边界 |
| 决策 / 9 | 当前情况与需要作出的选择；区分已确认要求与仍待选择的问题 |
| 维护 / 9 | 当前情况与期望改进；明确实际文件、行为或协作结果 |

缺陷复现和环境是已有问题事实，不是修复方案；根因未知或暂未复现仍可如实填写。五类主 Issue 的完整填写核对见 [本轮案例](../validation/2026-09-10-main-issue-examples.md)，均为演练，不表示产品已运行。

## 创建入口

网页从 [New issue 选择器](https://github.com/TonQiaN/Agent_flow/issues/new/choose) 选择主 Issue 表单。填写后另设真实 Assignees，核对提交的标题、正文与责任人；提示文字不会自动成为确认记录。

Sub-issue 可以从主 Issue 的 Create sub-issue 创建。当前原生窗口先显示仓库共享的模板选择器，选择 Blank issue 后只有空白标题和自由正文，不附带主表字段。也可以用 Add existing issue 关联已有 Issue，或先从常规 Blank issue 入口创建再关联。这里只说明平台入口，正文由负责人自主决定。[GitHub 子项说明](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)，2026-09-10 核对。

`config.yml` 设置 `blank_issues_enabled: true`，因此有访问权限的用户可以看到空白入口。这个开关无法只对 Sub-issue 开放，主 Issue 使用五表仍由人参与整理落实；不表示已配置自动拦截。[GitHub 入口配置](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)。

通过 CLI/API 创建主 Issue 时，先读取对应完整 YAML，按其字段标题准备正文，补齐共同信息及缺陷专用事实；可选项可后补。用 `gh issue create --body-file` 提交准备好的文件，并明确设置标题和 Assignees。读取服务器保存的内容核对，不把工具入口当作表单会自动展开的保证。Sub-issue 不受这套正文准备要求约束。

当前仓库私有，GitHub 对 input、textarea、dropdown 的 required 校验标注了公开仓库限制。表单字段、正文编辑和 CLI/API 均不能代替人参与的就绪确认；owner 文字不会自动设置 Assignees。[GitHub 表单结构](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema)，2026-09-10 核对。配置只在默认分支生效；本轮已实际打开新版选择器、五类表单、空白入口和子项创建窗口，检查范围与未提交真实测试 Issue 的边界见验证记录。

## 与 PR 的关联和验收

| 关联 | 说明什么 |
| --- | --- |
| 主 Issue 与 Sub-issue 的父子关系 | 具体工作归属哪个整体需求 |
| Assignees | 谁对相应工作负责 |
| 任务依赖 | 哪个实际结果会阻塞另一个工作项 |
| PR 对 Issue 的引用 | 本次提交覆盖哪些工作及验收 |
| stacked PR 的 base | 代码分支的实际依赖和合并顺序 |

PR 引用本次覆盖的主 Issue 及实际存在的 Sub-issue，使审阅者能追溯需求、负责人和交付。不要求子项与 PR 一一对应，也不要求无须拆分的工作为了开 PR 再建子项。PR 的说明要求不延伸为 Sub-issue 正文格式。

关联演练：主 Issue M 已关联两个由各自负责人承担的子项 S1、S2；PR A 只交付 S1 的工作。审阅者从 A 找到 S1 和 M，核对相应需求与实际成果。S1 完成后，M 仍需核对 S2 及整体结果，不能用分项进度代替整体完成。这只是关联关系示例，不提供任何子项正文或写法。

部分交付用 `Refs #编号`。只有某个 Issue 的完整验收已满足，且最终 PR 面向默认分支，才使用相应关闭关键字；涉及主项时另核对整体要求。GitHub 的 PR 正文关闭关键字只在目标为默认分支时生效。[GitHub PR 关联说明](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)。具体审查和合并核对见工作指南。

研究可以交付有依据的否定结论；只有原验收接受有界不确定且证据与限制足够时，才可据此验收。预算耗尽、关键证据缺失或仅产生文件都不能自动算完成。研究和决策可以只交正式决定，但最终正文须自足；若还承诺实现，则仍须完成对应成果。取消或不继续如实记录，不写成实现完成。

## 本轮迁移与维护

新增 `domain`，保留其他同义共通 ID；修改验收和范围提示，使需求制定者可以不预设方法。`behavior_contract` 的真实行为要求融入问题、范围与结果；研究的 `evidence_plan`、`stop_rule`，决策的 `options`、`impact`，维护的 `change_plan` 不再作为主表字段。真实边界和最终成果质量继续表达，执行方法由负责人负责。Bug 的 problem、reproduction、environment 完整对象保持基线，早先 behavior→problem 的迁移继续有效。

历史验证记录描述其对应版本，不批量改写。#20 已按本轮目标表达原则整理，其研究仍未执行。七份模板决定、五表与本指南保持同一版本；子项模板化等待充分实践，当前不提供候选写法。
