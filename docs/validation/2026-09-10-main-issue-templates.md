# 主 Issue 模板与 Sub-issue 自主表达验证

## 对象与确认依据

本记录对应 [Issue #21](https://github.com/TonQiaN/Agent_flow/issues/21) 当前用户明确要求实施后的版本：五类主 Issue 采用模板，增加领域，表达情况与期望结果；Sub-issue 内容与形式由负责人自主决定，暂不提供模板或写作建议；主／子项职责用自然语言说明。此前 PR #22 已关闭、未合并，相关本地改动已回滚；本轮从 main 重新实施。

基线为 `f28540c6bc3cda2f422fc10a1bca27b0df9e36ba`，工作分支为 `codex/issue-21-main-issue-templates`。开工前执行 `git pull --ff-only`，返回 Already up to date；无已跟踪文件未提交改动。主责 TonQiaN，Codex 实现与自查，未进行多人审阅。

验证对象是本记录随同提交的模板、决定和文档变更。环境为 macOS、Ruby 2.6.10 / Psych、Python 3.9.6、GitHub CLI 2.96.0。临时检查脚本读取实际 YAML、main 基线对象与本轮五类填写数据；未增加正式表单生成器、自动门禁或子项校验规则。

## 已执行的本地核对

| 核对 | 结果 |
| --- | --- |
| YAML 结构与重复键 | 五表及 config 共 6 份解析通过；按字段类型核对键、ID、控件、选项和必填值，无重复键／ID |
| 入口与字段范围 | 仅五份主 Issue 表单及 config；入口名称标明主 Issue，空白入口启用；没有子项表单 |
| 领域与共同字段 | 领域为开发流程／项目内容单选、无默认值；除 problem 外 8 个完整字段对象在五表中一致 |
| 方法字段迁移 | feature 移除 behavior_contract，research 移除 evidence_plan / stop_rule，decision 移除 options / impact，maintenance 移除 change_plan；无其他旧 ID 意外丢失 |
| 原有必要信息 | 五表标题前缀、owner 和 deliverables 对象保持基线；Bug 的 problem、reproduction、environment 三个完整对象不变 |
| 输入块数量 | 功能、研究、决策、维护各 9，缺陷 11，与决定及指南一致 |
| 主 Issue 填写 | [五类完整案例](2026-09-10-main-issue-examples.md) 全部覆盖所需字段与有效选项，可选项留空；正文无需预设实施方法 |
| 指令范围 | `git diff --exit-code` 对照基线确认两份 AGENTS.md 及 CLAUDE.md 未变化 |
| 差异格式 | `git diff --check` 通过 |

上述 YAML 与字段检查使用标准库和 Psych 对实际文件及基线进行对照，不以人工勾选代替检查。完整字段映射、主表用途与入口限制见 [填写指南](../development/issue-templates.md)。另扫描 43 份正式 Markdown，核对 203 处相对链接及锚点，全部可解析；七个模板决定 ID 各有一份正文，索引均指向本轮 proposed 文件。原有 8 个未跟踪飞书资料文件的 SHA-256 与开工前一致。

## 语义与关联核对

- 主表明确区分领域和主要交付目标，表单的情况、范围与成果提示没有换名保留提前写方法的要求；缺陷复现及环境仍用于问题事实。
- 共通决定、五类差异、流程决定、填写指南、PR 模板和 Issue #21 均用自然语言描述职责，未用单个术语等同主／子项。Sub-issue 不受主表字段约束，也没有可选推荐写法或正文样例。
- 仅演练工作关联：主项 M、子项 S1/S2、PR A 的归属与验收覆盖。分项完成不能代替主项整体结果；父子关系、实际阻塞、PR 引用与分支依赖分别表达。不为测试创建子项或 PR，不规定一对一关系。
- 审查参考为先理解问题、独立思考解决方式再对照实际交付。负责人对方案负责，统一的方案调整与回退细则仍待实践；没有把参考方式写成子项写作格式或自动改选授权。
- 读取 #20 正文确认其已保留研究目标、期望交付、必要边界和未开展研究的事实，本轮无需再改写；读取 #21 并对本轮范围更新进行逐字读回，状态保持开放、Assignees 保持 TonQiaN。

## 尚未验证

新版主表和空白入口尚未合入默认分支，尚未核对其在 GitHub 新建选择器及实际表单中的最终显示。工作分支的文件检查不能代替该核对；因此七份模板决定本轮修订仍在 proposed，旧版验证不证明新版已生效。

未创建真实 Sub-issue 试探任意正文，也未运行 Issue 到 PR 的自动执行、产品测试、CI/CD、测试矩阵或多人评审。未对长期协作效果、方案质量提升或未来子项模板的共性进行验证。本轮关联演练不证明 GitHub 实际执行了关闭或父子关系操作。

## 平台依据

2026-09-10 对照 GitHub 官方 [表单结构](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema)、[入口配置](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)、[创建与关联子项](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) 和 [PR 关联与关闭](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)：空白入口开关对访问者统一生效；表单配置来自默认分支；私有仓库不能只靠 required 保证信息完整；父子关系与 PR 关联分别建立。平台说明与本项目约定、已执行的本地核对分别记录。
