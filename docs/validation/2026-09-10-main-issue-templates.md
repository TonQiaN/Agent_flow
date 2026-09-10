# 主 Issue 模板与 Sub-issue 自主表达验证

## 对象与确认依据

本记录对应 [Issue #21](https://github.com/TonQiaN/Agent_flow/issues/21) 当前用户明确要求实施后的版本：五类主 Issue 采用模板，增加领域，表达情况与期望结果；Sub-issue 内容与形式由负责人自主决定，暂不提供模板或写作建议；主／子项职责用自然语言说明。此前 PR #22 已关闭、未合并，相关本地改动已回滚；本轮从 main 重新实施。

基线为 `f28540c6bc3cda2f422fc10a1bca27b0df9e36ba`，工作分支为 `codex/issue-21-main-issue-templates`。开工前执行 `git pull --ff-only`，返回 Already up to date；无已跟踪文件未提交改动。主责 TonQiaN，Codex 实现与自查，未进行多人审阅。

验证对象是本记录随同提交的模板、决定和文档变更。环境为 macOS、Ruby 2.6.10 / Psych、Python 3.9.6、GitHub CLI 2.96.0。临时检查脚本读取实际 YAML、main 基线对象与本轮五类填写数据；未增加正式表单生成器、自动门禁或子项校验规则。

## 已执行的本地核对

以下为 PR #23 提交前的检查结果；合并后的实际入口核对另列于后文。

| 核对 | 结果 |
| --- | --- |
| YAML 结构与重复键 | 五表及 config 共 6 份解析通过；按字段类型核对键、ID、控件、选项和必填值，无重复键／ID |
| 入口与字段范围 | 仅五份主 Issue 表单及 config；入口名称标明主 Issue，空白入口启用；没有子项表单 |
| 领域与共同字段 | 领域为开发流程／项目内容单选，YAML 未设置 default（不代表界面未预选）；除 problem 外 8 个完整字段对象在五表中一致 |
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

## 合并后的实际入口验收

2026-09-10，按当前用户“检查 #21，完成后关闭”的要求，以 PR #23 已合入的默认分支 `5e3abbea67cad6dba5beb261e41352c00c520c96` 为对象核对。该提交的文件树与已检查的 `774101b158e8b13a64c313dbfd032c69f2893725` 一致；本地 main 执行 `git pull --ff-only` 后无新增提交。Codex 在已登录且有仓库访问权的浏览器中逐一打开实际入口，读取页面与控件并操作菜单；未提交测试 Issue。

| 实际入口或操作 | 观察结果 |
| --- | --- |
| New issue 选择器 | 五个入口均明确标注“主 Issue”；另有 Blank issue，没有 Sub-issue 模板 |
| 功能主表 | 9 个输入块；当前场景与期望能力、共同范围与成果字段正常，旧 behavior_contract 块不再显示 |
| 缺陷主表 | 11 个输入块；实际与期望行为、复现步骤与已有证据、版本与相关运行条件完整显示 |
| 研究主表 | 9 个输入块；说明已知与未知、问题及结论用途，旧 evidence_plan / stop_rule 块不再显示 |
| 决策主表 | 9 个输入块；说明当前情况与需要作出的选择，旧 options / impact 块不再显示 |
| 维护主表 | 9 个输入块；说明当前情况与期望改进，旧 change_plan 块不再显示 |
| 领域与交付物控件 | 五表初始领域均为“开发流程”；缺陷、功能菜单显示两个领域，功能表切换到“项目内容”成功。功能表交付物菜单有四个未选中的多选项，与 YAML 一致 |
| 常规 Blank issue | 只有空白标题与自由正文，不带主表字段、提示或正文样例 |
| #21 的 Create sub-issue | 原生窗口先显示共享选择器；选择 Blank issue 后只有空白标题与自由正文及责任等元数据控件，取消退出未创建 Issue。更多选项中可见 Add existing issue |

现场发现：YAML 未配置 default，不能推出界面“无默认选择”；GitHub 当前仍预选第一个领域。分类、共通决定及指南据此改为准确说明平台行为，并要求填写者核对领域。两种领域均可正常表达，未增加第三种兜底类别或对子项的写作要求。原生子项窗口共用仓库选择器，也不能宣称平台会按父子关系隐藏主表。

再次读取 #20，正文已说明研究问题、结论用途、必要边界及主／子 Issue 分工，没有预设研究步骤；该 Issue 仍开放，研究与讨论验收未开展。关联关系与整体关闭原则仍按前文的文档案例核对，原生入口可见不等于实际创建、关联或自动关闭已验证。

补齐记录后重新检查 6 份 YAML、五类主 Issue 填写数据、43 份正式 Markdown 的 210 处相对链接及锚点、七个决定 ID 与索引，均通过；原有 8 个未跟踪资料文件的 SHA-256 保持不变。本次只调整决定生命周期和文档事实，五份表单、config 以及 AGENTS.md / CLAUDE.md 与 PR #23 合并版本相同。

模板与文档在本项约定范围内已落实，七份模板决定沿用唯一 ID 移回 implemented；`D-20260907-development-workflow` 仍在 proposed，其未实现自动化和真实产品流程不属于本项验收。主责 TonQiaN，Codex 核对及维护证据，未进行多人审阅。

## 尚未覆盖

未创建真实 Sub-issue 试探任意正文，也未运行 Issue 到 PR 的自动执行、产品测试、CI/CD、测试矩阵或多人评审。未对长期协作效果、方案质量提升或未来子项模板的共性进行验证。本轮关联演练不证明 GitHub 实际执行了关闭或父子关系操作。

## 平台依据

2026-09-10 对照 GitHub 官方 [表单结构](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema)、[入口配置](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)、[创建与关联子项](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) 和 [PR 关联与关闭](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)：空白入口开关对访问者统一生效；表单配置来自默认分支；私有仓库不能只靠 required 保证信息完整；父子关系与 PR 关联分别建立。平台说明与本项目约定、已执行的本地核对分别记录。
