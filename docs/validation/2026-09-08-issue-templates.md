# Issue 分类与模板实施验证

日期：2026-09-08。关联 [Issue #6](https://github.com/TonQiaN/Agent_flow/issues/6)，主负责开发者 TonQiaN。预检基线 `main@f3bdd38d2da951de0e1f48646b9e49e7f7154855`；实施分支 `codex/issue-6-template-decisions`。用户已明确要求按七份决定及 Issue 验收实施，确认摘要与预检结论已登记于 Issue。Codex 实施及自查，未进行多人审阅。

## 交付范围

分类、共通字段和五类差异共七份自足决定，五份完整 YAML，分类与填写指南，以及 12 个逐字段填写演练。原开发流程决定保留阶段与责任，细则引用七份决定；索引、工作指南、仓库结构说明与 CHANGELOG 同步。未修改 AGENTS.md、CLAUDE.md、产品范围、版本目标或发布 tag。

五类均保留八项共通职责；七字段结构和提示相同，problem 按类别改写。功能/维护各增加一个专用块，缺陷/研究/决策各增加两个，合计 48 个输入块。旧 feature/maintenance 六 ID 保留，Bug behavior→problem 后保持实际/期望内容，原 reproduction/environment 保留。无 common.yml、正式生成器、第二套五类 Markdown 模板、新类别标签或固定 Assignees；config.yml 仍为 `blank_issues_enabled: false`。

## 本地检查

环境：macOS；Ruby 2.6 / Psych 3.1 解析 YAML，Python 3 与 Pandoc 解析 Markdown，Git 对照预检基线。使用临时检查程序执行以下核对，未引入项目生成器、测试框架或自动 CI。检查范围为本次正式文件；研究材料未混入正式提交。

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

尚待首次实现 PR 合并到默认分支后，用真实 GitHub 选择器及五类表单核对名称、前缀、字段、交付物与说明展示。当前不将这些项目写成通过；七份决定保留 proposed，Issue #6 保持打开。合并后记录实际结果，再核对生命周期、默认分支文件及剩余验收。

本仓库私有；表单 required 的平台限制、Assignees 不自动设置以及 CLI/API 信息补齐方式见 [使用指南](../development/issue-templates.md)。本项不验证空白提交拦截、不建立自动门禁、不替代长期使用效果研究。后续迭代由实际选类冲突、字段负担、漏同步或交接问题触发，按共通/类差异的实际归属修改决定及受影响表单和指南。
