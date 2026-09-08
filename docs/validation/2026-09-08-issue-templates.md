# Issue 分类与模板实施验证

日期：2026-09-08。关联 [Issue #6](https://github.com/TonQiaN/Agent_flow/issues/6)，主负责开发者 TonQiaN。预检基线 `main@f3bdd38d2da951de0e1f48646b9e49e7f7154855`；实施分支 `codex/issue-6-template-decisions`。用户已明确要求按七份决定及 Issue 验收实施，确认摘要与预检结论已登记于 Issue。Codex 实施及自查，未进行多人审阅。

## 交付范围

分类、共通字段和五类差异共七份自足决定，五份完整 YAML，分类与填写指南，以及 12 个逐字段填写演练。原开发流程决定保留阶段与责任，细则引用七份决定；索引、工作指南、仓库结构说明与 CHANGELOG 同步。未修改 AGENTS.md、CLAUDE.md、产品范围、版本目标或发布 tag。

五类均保留八项共通职责；七字段结构和提示相同，problem 按类别改写。功能/维护各增加一个专用块，缺陷/研究/决策各增加两个，合计 48 个输入块。旧 feature/maintenance 六 ID 保留，Bug behavior→problem 后保持实际/期望内容，原 reproduction/environment 保留。无 common.yml、正式生成器、第二套五类 Markdown 模板、新类别标签或固定 Assignees；config.yml 仍为 `blank_issues_enabled: false`。

## 本地检查

环境：macOS；Ruby 2.6 / Psych 3.1 解析 YAML，Python 3 与 Pandoc 解析 Markdown，Git 对照预检基线。使用临时检查程序执行以下核对，未引入项目生成器、测试框架或自动 CI。检查范围为本次正式文件；研究材料未混入正式提交。下表计数对应 PR #7 的实现版本，后续仅对受影响的文档链接及生命周期重新核对。

| 方法 / 范围 | 实际结果 |
| --- | --- |
| YAML AST 扫描重复键，safe_load 解析 5 表与 config | 6 文件通过，入口恰为五表＋配置 |
| 逐表核对控件/ID/顺序/required、标题与四个多选选项 | 9 / 10 / 10 / 10 / 9，共 48 个输入块符合七份决定；无重复 ID |
| 比较七项共通字段的完整对象 | 五表一致，包括提示、控件与必填意图；problem 的改写和各类专用块符合差异决定 |
| 与基线旧 ID 对照；核对输入默认值和验收渲染 | 原信息职责保留，Bug behavior→problem 后无重复块；无默认已确认/通过值，textarea 未设置 render |
| Pandoc 解析全部 41 份正式 Markdown 的链接和标题 | 210 处本地链接、70 处锚点通过；七个稳定 ID 各有唯一正文和索引，无正文 status 字段 |
| 12 例逐字段与实际 YAML 对照 | 114 个填写块齐全，交付物只使用现有选项；五类及反例表达可用，所有模拟验收清单保持未勾选 |
| Codex 内容自查 | 容器镜像与节点能力分层，外围回放不要求内部 agent 记录；否定/未知/未复现及仅决定交付边界清楚 |
| Git 差异、格式与范围 | git diff --check 通过；没有改动 AGENTS.md / CLAUDE.md、产品实现或 Roadmap，CHANGELOG 只记实际模板能力 |

这些检查针对当前工作分支，不能替代下方线上展示核对；GitHub schema 仅按本次使用的控件和已核对的官方字段约束检查，不宣称是平台的全量校验器。

完整例子见 [填写与边界演练](2026-09-08-issue-template-examples.md)。这些是内容与模板验证；不存在可运行产品，未进行 Container、Harness、前端回放或依赖升级实验，也未用 CLI/API 创建额外示例 Issue。

## 默认分支入口与交付核对

[PR #7](https://github.com/TonQiaN/Agent_flow/pull/7) 已于 2026-09-08 10:50:12 UTC 合并，默认分支提交为 `b131a6eacf67258bb33696d99ebb00a2c22745bb`。核对远端分支及本地文件，五份表单与已检查的实现 head `ad033537fe55e6afca5cffa01c29610683611bb2` 无差异。

随后在已登录 GitHub 的浏览器中，从真实 [New issue 选择器](https://github.com/TonQiaN/Agent_flow/issues/new/choose) 打开五个入口，读取页面可访问性树和 DOM 展示，并实际选择交付物、填写及预览研究验收清单。检查在 10:50–10:53 UTC 进行；未点击 Create，未创建任何样例 Issue。

| 实际页面 / 操作 | 观察结果 |
| --- | --- |
| 模板选择器 | 显示功能与行为改进、缺陷与回归修复、研究与证据验证、方案与决策讨论、工程与流程维护五入口；维护者另见 Blank issue (Maintainers only) |
| feature.yml | `[功能]` 前缀，9 输入块；场景/目标与行为契约分开，八项共通职责可见 |
| bug.yml | `[缺陷]` 前缀，10 输入块；只出现一块实际与期望行为，复现/证据与版本/运行条件保留；提示明确 Harness、镜像、节点能力和外围 I/O 分开 |
| research.yml | `[研究]` 前缀，10 输入块；方法与停止条件显示，预算耗尽/缺证据不等于完成的提示可读 |
| decision.yml | `[决策]` 前缀，10 输入块；候选比较与影响/落实/重开分开，实际只选择“正式决策正文”后正确显示 |
| maintenance.yml | `[维护]` 前缀，9 输入块；工程目标与改动/兼容/验证计划显示，可说明不涉及迁移 |
| 五表共同展示 | 八项共通职责、说明及 placeholder 可见；相关决定、续接字段无必填星号；均未预置 Assignees 或标签；每表展开交付菜单均有既定四选项 |
| 研究表单交互 | 先选正式决策，再选研究 / 验证记录，按钮同时保留两项；owner 填入演练文字后 Assignees 仍为 No one，未自动指派 |
| 研究验收 Preview | 两条真实输入的 Markdown 清单显示为未完成任务复选框，未包成代码块；预览中的复选框禁用，不代表已提交或已完成 |
| 检查结束 | 离开演练页返回选择器；未提交表单或改动实际工作项的责任归属 |

合并前读取 PR head/base、状态和反馈：main 无保护，required_status_checks 为关闭且空，PR 为 MERGEABLE / CLEAN、无检查运行和阻塞评审；使用匹配 head 的普通合并，未绕过门禁。分支规则 API 返回私有仓库套餐不支持（403），不据此声称读取了所有规则。Codex 完成本次自查，未另有开发者审阅。

收尾分支 `codex/issue-6-template-verification` 只将已落实且验证的七份模板决定移入 implemented，更新索引、当前指南与本记录；原开发流程决定仍为 proposed，产品运行流程尚未实测。移动后重新核对 41 份 Markdown 的 211 本地链接、70 锚点与七份唯一正文，全部通过，git diff --check 通过；表单相对已在线核对版本未变。收尾 PR 合并后再读回默认分支和 Issue 验收记录，实际合并与关闭时间保留在 GitHub。全部已承诺模板工作完成后关闭 #6，不把本页写成未来长期使用效果的证明。

本仓库私有；表单 required 的平台限制、Assignees 不自动设置以及 CLI/API 信息补齐方式见 [使用指南](../development/issue-templates.md)。本项不验证空白提交拦截、不建立自动门禁、不替代长期使用效果研究。后续迭代由实际选类冲突、字段负担、漏同步或交接问题触发，按共通/类差异的实际归属修改决定及受影响表单和指南。
