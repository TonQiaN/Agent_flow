# Issue 分类与填写指南

五份完整表单位于 `.github/ISSUE_TEMPLATE/`，手工维护。[分类决定](../../.agents/decisions/development/README.md#d-20260908-issue-classification) 说明所属领域和主类型，[共通规范](../../.agents/decisions/development/README.md#d-20260908-issue-template-common) 说明字段职责；开发阶段、确认与 PR 操作见 [工作指南](workflow.md)。

## 先说明当前情况与期望结果

制定者说明谁在什么情况下遇到什么问题、带来什么影响，以及到底希望得到什么结果。只填与本项有关的事实、目标和必要边界；不需要先想好怎样实现。

实现者可以与 AI 一起探索达到目标的方法。Issue 正文不预设技术选型、内部结构、实现步骤、研究路线或测试方案，也没有可选的“建议实现”栏。已存在的兼容、权限、资源等真实约束仍可说明，并写清依据；早期技术想法不能自动成为需求。

验收描述完成后应看到什么。例如，回放需求可以写“停在结果返回前的时间点时，审阅者看不到未来输出”，不必要求先选定存储模型、回放算法或测试工具。研究与决策可以要求结论有依据、限制清楚、可供人判断，但不用预设执行者应怎样取得这些结果。

具体取舍由执行者在工作中形成，必要内容进入对应决定；实际方法和证据进入 PR 或验证记录。Issue 保存需求澄清、实际进展、确认及产物定位。

## 选择所属领域

每份表单的第一个输入是“所属领域”，从两项中单选，没有预选答案。

| 所属领域 | 主要作用对象 | 示例 |
| --- | --- | --- |
| 开发流程 | 团队开发、协作和维护项目的方法与约定 | AGENTS.md 写法研究；Issue 模板改进；版本维护机制 |
| 项目内容 | AgentFlow 产品本身的目标、能力、契约、实现或使用说明 | Harness Adapter；产品节点隔离研究；产品使用指南 |

领域与主要类型分别选择。#20 是开发流程中的研究，产品节点隔离也可以是研究；#21 是开发流程中的维护，产品指南修订也可以是维护。文档、Prompt 或代码的文件类型不能替代作用对象判断。

跨领域工作按主要验收结果选一个领域，在范围中补充另一领域的影响。两个结果可以独立验收且拆分有价值时再拆项；目标不清楚时先澄清。领域保存在正文，不会自动设置 Labels、Issue Types 或切换 PR 流程。

## 选择主要类型

按最后承诺的主要结果选择一类，不按工作阶段或实现载体选类。

| 主要完成目标 | 表单 / 标题前缀 | 提示与专用信息 / 输入块数 |
| --- | --- | --- |
| 新增或改变产品能力 | [功能](../../.github/ISSUE_TEMPLATE/feature.yml) / `[功能]` | 当前场景与期望能力；九项共通信息 / 9 |
| 恢复已约定但失效的行为 | [缺陷](../../.github/ISSUE_TEMPLATE/bug.yml) / `[缺陷]` | 实际与期望行为；另保留 reproduction、environment / 11 |
| 回答未知问题，形成有依据的结论 | [研究](../../.github/ISSUE_TEMPLATE/research.yml) / `[研究]` | 当前情况与希望弄清的问题；九项共通信息 / 9 |
| 为明确的问题形成选择与边界 | [决策](../../.github/ISSUE_TEMPLATE/decision.yml) / `[决策]` | 当前情况与需要作出的选择；九项共通信息 / 9 |
| 改善工程、文档或协作现状 | [维护](../../.github/ISSUE_TEMPLATE/maintenance.yml) / `[维护]` | 当前情况与期望改进；九项共通信息 / 9 |

缺陷的复现步骤、已有输入和环境是描述问题的事实，不是修复方法。尚未复现或存在未知条件时如实说明，不预填根因。五类差异的依据分别见 [功能](../../.agents/decisions/development/README.md#d-20260908-issue-template-feature)、[缺陷](../../.agents/decisions/development/README.md#d-20260908-issue-template-bug)、[研究](../../.agents/decisions/development/README.md#d-20260908-issue-template-research)、[决策](../../.agents/decisions/development/README.md#d-20260908-issue-template-decision)、[维护](../../.agents/decisions/development/README.md#d-20260908-issue-template-maintenance)。

必要研究和讨论可以在同项完成，不按每次 AI 会话、分支或 PR 自动拆项。父项仍按主要结果分类，父子关系与阻塞分别说明；当前没有 Epic 第六类、必选类别标签或组织级类型。

## 填写共通信息

| ID | 应提供的信息 | 时点 |
| --- | --- | --- |
| `domain` | 开发流程或项目内容，按主要对象单选 | 创建时 |
| `owner` | 一名人类主责的 GitHub 用户名，另设置真实 Assignees | 创建时 |
| `problem` | 当前情况、影响和期望结果；标题与提示按类型变化 | 创建时 |
| `scope` | 希望解决的范围、非目标、真实约束及依据 | 创建时 |
| `deliverables` | 希望收到什么成果；不强制提前指定实现路径或内部结构 | 创建时 |
| `acceptance` | 完成后应看到的结果、问题回答或结论质量 | 创建时先写期望 |
| `dependencies` | 已知依赖、缺少的条件与责任归属；没有写“无”，未知如实说明 | 创建时 |
| `decision_context` | 已知要求及相关决定、仍待澄清的需求 | 按需补充 |
| `handoff` | 需求确认、实际进展及产物定位，不填写执行计划 | 开工、变化或交接时 |

顺序为 domain → owner → problem → 类别专用事实字段 → scope → deliverables → acceptance → dependencies → decision_context → handoff。除 problem 按类别改写，其余八项共通字段在五表中的控件、标题、提示和必填意图相同。

交付物可组合。研究或决策可以只交正式决定，但正文应足以支持结论；若还承诺模板、指南或代码，不能只写完决定就关闭。范围变动说明原因和确认，取消勾选不等于撤销已承诺的成果。原始资料链接可选，正文保持自足，不要求整段聊天、全部工具版本或 agent 内部轨迹。

## 网页、CLI 与 API

网页从 [New issue 选择器](https://github.com/TonQiaN/Agent_flow/issues/new/choose) 选择主类型，填领域和正文，并另设 Assignees。placeholder 和顶部说明不会自动成为已提交答案。[GitHub 表单结构说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema)。

CLI/API 先读取对应 YAML，用字段标题作正文小节，补齐同等信息。领域直接写所选文字，例如正文先写 `## 所属领域`，下一段写“开发流程”，再填写主责、当前情况等。交付物写所选成果名称，非必填信息可留空或按事实补充；没有另一套正式 Markdown 模板。

准备好实际正文后，可用以下命令创建工作项；替换标题、负责人及文件内容，不运行未填写的示例：

```sh
gh issue create --repo TonQiaN/Agent_flow \
  --title '[维护] 具体期望改进' \
  --assignee ACTUAL_GITHUB_LOGIN \
  --body-file issue-body.md
```

[GitHub CLI 文档](https://cli.github.com/manual/gh_issue_create) 说明 `--body-file` 和 Assignees 用法。API 使用同一正文作为 body，并设置 title、assignees。创建或修改后读回服务器保存的正文和责任人，确认情况、目标、领域及范围没有遗漏；不要为同一项重复创建。

表单由默认分支提供，分支文件检查不代替线上展示验证。[GitHub 入口配置说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)。本次工作分支改版的实际验证与待合入状态见 [2026-09-10 验证记录](../validation/2026-09-10-issue-domain.md)；[2026-09-08 的线上结果](../validation/2026-09-08-issue-templates.md) 只覆盖旧版表单。

当前仓库私有。2026-09-10 重新核对的 [GitHub 表单结构说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema) 仍对 input、textarea、dropdown 的 required 提交校验注明公开仓库限制。本项目通过人参与的就绪核对补齐信息，不能把模板声明当作自动门禁；正文中的 owner 也不会自动设置 Assignees。CLI/API 及提交后的正文编辑仍需核对。

## 完成与迁移

研究的否定结论可以验收；结果须回答约定问题并说明依据和限制。关键问题仍缺依据或必要讨论时，不因用完预算或执行过步骤就算完成；有界不确定是否可接受取决于原目标。研究完成、决定采纳与产品实现分别记录。取消、重复、延期和无法复现说明事实及去向，不写成已实现或已修复。

2026-09-10 新增 domain，并将共同验收改为结果表达。以下专用字段已移除，原有需求事实有对应位置：

| 旧字段 | 需求部分的去向 |
| --- | --- |
| feature：behavior_contract | 期望行为归 problem/acceptance，真实兼容或权限要求归 scope |
| research：evidence_plan、stop_rule | 已知事实和未知问题归 problem，真实范围与投入约束归 scope，期望结论归 acceptance |
| decision：options、impact | 待选问题归 problem，已有边界归 scope，形成的取舍与影响在正式决定中说明 |
| maintenance：change_plan | 当前问题与改善结果归 problem/acceptance，已有必要约束归 scope |

执行方法不随字段迁移到其他需求栏。共同 ID 保留；旧 Bug behavior→problem 的历史映射继续适用，reproduction/environment 保留。旧链接预填被删除字段时需重新整理，不能原样搬运方法计划。

已关闭 Issue 与旧验证样例保持历史。当前受审查的 #20 按明确反馈整理，其他活跃项按实际工作需要补充，不批量改写。共同变化回到共通决定，类别差异回到对应决定；无真实改动的记录不为凑数修订。

维护时核对字段唯一性、共同对象、显式迁移、事实与目标是否保留，以及方法要求是否以其他名称重新出现。使用指南、实际表单与验证结果同步，默认分支展示单独核对。
