# Issue 分类与填写指南

当前有五份完整表单，位于 `.github/ISSUE_TEMPLATE/`，手工维护。分类理由见 [分类决定](../../.agents/decisions/development/README.md#d-20260908-issue-classification)，字段与同步取舍见 [共通规范](../../.agents/decisions/development/README.md#d-20260908-issue-template-common)。本页说明实际用法；阶段、确认与 PR 操作仍按 [开发工作指南](workflow.md)。

## 选择主要类型

按本项最后承诺交付什么选择一类。工作性质和交付物分开，选“研究”或“决策”不表示免除已承诺的实现。

| 完成时主要回答的问题 | 表单与标题前缀 | 对应例子 |
| --- | --- | --- |
| 新增或改变什么产品能力？ | [功能与行为改进](../../.github/ISSUE_TEMPLATE/feature.yml) · `[功能]` | 实现只读的外围时间回放；新增节点 skill 配置 |
| 什么已约定的行为失效，如何恢复？ | [缺陷与回归修复](../../.github/ISSUE_TEMPLATE/bug.yml) · `[缺陷]` | 假设已有回放，退回结果返回前仍泄露未来输出 |
| 哪个未知事实需要证据才能判断？ | [研究与证据验证](../../.github/ISSUE_TEMPLATE/research.yml) · `[研究]` | 验证指定 DSH 版本的节点插件隔离是否可行 |
| 团队现在需要选定什么及其边界？ | [方案与决策讨论](../../.github/ISSUE_TEMPLATE/decision.yml) · `[决策]` | 确认 high level 范围，仅交付自足的正式决定 |
| 要落实什么工程、文档或协作改进？ | [工程与流程维护](../../.github/ISSUE_TEMPLATE/maintenance.yml) · `[维护]` | Issue #6 交付模板；版本维护指南、依赖升级 |

产品例子是填写演练，当前仓库尚无对应可运行产品。原三份路径保留，新增 research.yml 和 decision.yml；config.yml 继续关闭常规空白入口。首版不设置类别标签、组织级 Issue Types 或固定 Assignees。

交叉情形可这样判断：

- 改 Prompt 来新增行为是功能；修复现行输出契约是缺陷；改善开发指令是维护。文件类型、Harness、模块和优先级不单独决定主类。
- Issue #6 包含研究、讨论和实现，但最终要交付可用模板，因此一直是维护。只有研究能独立验收、由不同主责独立交付或成为必要阻塞时，才考虑拆项。
- 父项仍按主要结果分类，在依赖字段区分父子与阻塞；不增加 Epic 第六类，不按每个 AI 会话、PR 或阶段自动新建 Issue。
- 暂未复现不改称“已修复”；取消、重复、延期说明原因与去向。开放聊天或同项交接优先留在已有沟通或 Issue，不强制独立建项。

## 填写共通信息与类别补充

每份表单都包含以下八项职责。创建必填表示应提供的信息；未知事实如实标记，必要阻塞在实施前处理，不能用“待定”冒充已就绪。

| ID | 如何填写 | 时点 |
| --- | --- | --- |
| `owner` | 一名人类主责的 GitHub 用户名；协作者写分工，另设置真实 Assignees | 创建时 |
| `problem` | 为什么做、要完成什么；标题和提示按类别变化 | 创建时 |
| `scope` | 包含、排除、受影响模块/接口和须保留的行为 | 创建时 |
| `deliverables` | 多选实际交付物，在范围或验收中说清具体内容、位置 | 创建时 |
| `acceptance` | 可观察结果、验证方法及必要反例；执行后补实际结果 | 创建时先写标准 |
| `dependencies` | 无，或所需交付、解除条件、处理人；区分参考和父子关系 | 创建时 |
| `decision_context` | 现行决定 ID、待决问题与已知分歧，可在预检补齐 | 按阶段补充 |
| `handoff` | 基线、已做/未做、实际参与者、确认范围及依据、阻塞和下一步 | 开工、实质变化或交接时 |

交付物提供四个可组合选项：正式决策正文、实现文件（代码 / 配置 / 模板）、当前说明或使用指南、研究 / 验证记录。取消选择不能暗中撤销已确认的验收承诺；实质调整仍记录原因和确认范围。原始材料链接可选，正文须自足，不强制粘贴聊天、全部工具版本或内部 agent 轨迹。

类别专用字段紧跟 problem，其余七项共通字段在五表中的控件、标题、提示和必填意图完全一致。

| 类别 / 输入块数 | problem 标题及专用字段 | 填写重点与差异决定 |
| --- | --- | --- |
| 功能 / 9 | 问题、场景与目标；`behavior_contract` 行为与接口契约 | 输入输出、正常/失败/边界、副作用与兼容；[功能决定](../../.agents/decisions/development/README.md#d-20260908-issue-template-feature) |
| 缺陷 / 10 | 实际与期望行为；`reproduction` 复现步骤与已有证据；`environment` 版本与相关运行条件 | 观察与根因猜测分开，未知项如实填写；[缺陷决定](../../.agents/decisions/development/README.md#d-20260908-issue-template-bug) |
| 研究 / 10 | 研究问题与决策用途；`evidence_plan` 方法、比较与证据计划；`stop_rule` 结束条件与投入边界 | 真实假设、基线、方法、证据限度及结束边界；[研究决定](../../.agents/decisions/development/README.md#d-20260908-issue-template-research) |
| 决策 / 10 | 需要敲定的问题与适用范围；`options` 候选方案与比较依据；`impact` 影响、落实与重开条件 | 保留已确认约束，不编造替代方案或固定审阅人数；[决策决定](../../.agents/decisions/development/README.md#d-20260908-issue-template-decision) |
| 维护 / 9 | 当前问题与工程目标；`change_plan` 改动、兼容与验证计划 | 指定工程结果、兼容及适用迁移/回退，不涉及则说明；[维护决定](../../.agents/decisions/development/README.md#d-20260908-issue-template-maintenance) |

完整填写与边界演练见 [样例记录](../validation/2026-09-08-issue-template-examples.md)。样例不代表产品已实现或已发生故障，也没有为演练创建真实 Issue。

## 网页、CLI 与 API 使用

网页从 [New issue 选择器](https://github.com/TonQiaN/Agent_flow/issues/new/choose) 选对应入口，保留合适的标题前缀，填写正文并另设 Assignees。输入框提示不会自动成为答案，验收清单须自己填写真实标准。顶部说明只辅助填表，不作为提交后保存的确认记录。[GitHub 表单结构说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema)。

CLI/API 不依赖网页替你展开字段。先读取对应完整 YAML，用其中的字段标题作 Markdown 小节，补齐八项共通信息与该类专用内容，保存为一个工作用正文文件。交付物写所选项的文字即可；decision_context 和 handoff 建项时可以留空或标“待补充”，开工前按实际补齐。无需维护另一套正式 Markdown 模板。

例如已经准备好 `issue-body.md` 后，可使用下列命令**实际创建**工作项；替换标题、负责人和正文，不运行未填写的示例，也不要随后再用 API 重复创建同一项：

```sh
gh issue create --repo TonQiaN/Agent_flow \
  --title '[维护] 具体工程结果' \
  --assignee ACTUAL_GITHUB_LOGIN \
  --body-file issue-body.md
```

`--assignee` 接收实际 GitHub 登录名，正文 owner 仍写主责。`--body-file` 的使用见 [GitHub CLI 文档](https://cli.github.com/manual/gh_issue_create)。API 使用同一正文作为 `body`，并明确设置 `title` 和 `assignees`；例如先准备包含这三个字段的 `issue.json`，再用 `gh api --method POST repos/TonQiaN/Agent_flow/issues --input issue.json`。文件中的换行用 JSON 编码，避免手工 shell 拼接正文。无论入口，创建后核对服务器保存的标题、正文和真实 Assignees；CLI 可用 `gh issue view NUMBER --repo TonQiaN/Agent_flow --json title,body,assignees` 读回。没有为本次演练调用这些创建命令。

Issue 表单由默认分支提供，工作分支的文件检查不能代替默认分支实际显示验证。[GitHub 配置说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)。五表已合入默认分支，2026-09-08 已核对选择器与五类表单的字段、提示和交付物展示；结果与边界见 [实施验证](../validation/2026-09-08-issue-templates.md)。

当前仓库私有。GitHub 官方对 input、textarea、dropdown 的 required 校验标注公开仓库限制；本项目按就绪核对补齐信息，不把表单当作自动门禁。正文中的 owner 也不会自动设置 Assignees，提交后的编辑和 CLI/API 入口仍需核对。关闭空白入口不等于取消维护者创建空白 Issue 的能力。以上平台行为边界于 2026-09-08 对照 [表单结构说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema) 与 [入口配置说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)；本次不提交空白 Issue 来试探拦截。

## 研究、仅决策交付与关闭

研究可以得到支持、不支持或有界不确定结论。完成按约定方法回答问题并交付证据和限制的工作，否定答案可以验收；缺少必要环境、样本或证据时须补证、交接或明确调整范围。预算用完不等于完成，只有原验收允许有界不确定、且约定方法已完成时，才可按该结果验收。

研究和决策都可以只选择“正式决策正文”，但正文须足以说明结论、真实比较、理由或证据、适用限制、确认范围、落实去向与重开条件。Issue 保存实际讨论、分工及具体确认；决定浓缩取舍。采纳方案不表示产品已实现，不能据研究 Issue 关闭就自动把产品决定移为 implemented。

如果本项还承诺模板、代码或指南，须逐项交付并验证后再关闭。例如 Issue #6 不能只凭七份决定或研究 artifact 完成验收。PR、合并、剩余项与关闭核对按工作指南；已取消或不继续的事项记录事实与去向，不伪装为实现完成。

## 维护与迁移

旧功能/维护的 owner、problem、scope、acceptance、dependencies、decision_context ID 保留；增加各类专用字段、deliverables 与 handoff。旧 bug.yml 的 `behavior` 合并为同义 `problem`，保留“实际与期望行为”的内容职责及 reproduction、environment，不并列重复问题块。链接预填或其他外部工具若使用旧 behavior 参数，应在下次维护时改为 problem；历史 Issue 的已提交 Markdown 不回写。

七份决定是分类和字段设计依据，五份完整 YAML 是可提交表单，当前指南是使用入口，验证记录保存实际结果。没有 common.yml、YAML 继承、生成器或另一套五类正式 Markdown 模板。

实际选类争议、漏填追问、无用字段、交接失败或共同文字漏同步时，由改动 Issue 的主负责开发者归纳并敲定：共同变化修订共通决定及受影响五表；类内变化修订对应差异决定、表单与说明；需要改分类则回到分类决定。无真实变化的决定不为凑数修改。

每次实际改动核对：YAML 与单表 ID 唯一、共通七字段完整对象相同、problem 职责与类差异有依据、标题/控件/提示/必填意图和字段顺序、历史 ID 映射、链接、受影响填写例、默认分支实际入口。将来有明确例外时按决定中的职责去向核对，不能让同步检查覆盖已确认例外。已有 Issue 只在活跃工作需要时补缺口，不批量改写历史。没有自动迁移、固定审阅配额或定期过期机制。
