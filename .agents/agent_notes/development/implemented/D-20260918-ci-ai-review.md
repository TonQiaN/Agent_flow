# 两人团队的 CI 与 AI 审查分工

创建于 2026-09-18。对应 [Issue #54](https://github.com/TonQiaN/Agent_flow/issues/54)。

## 结论与边界

当前两人团队采用公开仓库、标准 GitHub 托管 Actions runner 和订阅内原生 Codex Code Review。用户接受源码及本次已讨论的历史资料公开，希望减少私有仓库 CI 分钟超额带来的费用，并优先使用已有订阅的审查能力。历史资料的具体公开边界由 [资料管理记录](../README.md#d-20260911-materials-management) 与 [Issue #50](https://github.com/TonQiaN/Agent_flow/issues/50) 负责，本 note 不扩大资料公开范围。

| 参与方 | 负责的结果与边界 |
| --- | --- |
| PR 作者与开发代理 | 根据 Issue 完成实现和本地验证，在 PR 中逐项列出验收证据、未覆盖内容与尚需真实场景验证的部分，处理审查反馈 |
| GitHub Actions | 在标准 `ubuntu-latest` runner 上执行可重复的质量、构建和测试检查，由 `CI required` 汇总；检查成功提供工程验证证据，不等于完整满足 Issue |
| 原生 Codex Code Review | 检查 PR 差异及相关仓库上下文，遵循适用的 AGENTS.md 指引并提出问题；没有发现问题或回复通过意见，不等于完成全部业务验收，也不授予合并权限 |
| 人类主负责开发者与已获授权的工具 | 对照 Issue 和实际证据判断本次交付范围，核对阻塞反馈、最新提交及目标分支的必需检查；由有权限的人或已有明确授权的工具合并、读回结果并核对关闭条件 |

日常本地检查、完整 PR 云端 CI、合并后的读回，以及最新 head/base 的要求沿用 [开发流程记录](../README.md#d-20260907-development-workflow) 和 [工程记录](../README.md#d-20260909-source-layout)。本 note 负责工具分工与成本选择，不另维护一套检查矩阵或审批人数。

### Issue 验收与关闭

审查先看关联 Issue 的需求和验收标准，再对照 PR 的实现与证据。AI 可协助指出漏项，负责人仍须确认实际完成边界；当前没有自动判定 Issue 已完整验收的门禁。

完整满足某个 Issue、无需保留后续真实场景验收且最终 PR 面向默认分支时，用 `Closes #编号` 随合并自动关闭。部分交付或尚需整体验收时用 `Refs #编号`，验收完成后再关闭。多项 PR、父子 Issue 的整体核对与合并条件统一归 [开发流程记录](../README.md#d-20260907-development-workflow) 管理；这两种引用方式不需要自建模型调用。

### 原生审查与自定义 Actions 的范围

仓库已开启原生 Codex 自动审查，具体触发时机以 Codex 设置为准；需要针对当前版本重新审查时，可在 PR 评论中使用 `@codex review`。仓库专属审查指引通过适用的 AGENTS.md 维护，单独新建一个 `review.md` 或本 note 不会替代该配置入口。写入审查指引只能引导模型，不能证明每项规则或 Issue 验收都已被完整检查。[OpenAI 官方审查说明](https://learn.chatgpt.com/docs/third-party/github)，2026-09-18 核对。

Actions 内自定义 Codex 审查，以及“自动判断满足 Issue 后合并”的设置继续暂停。本次不为此配置 API key、导入订阅登录凭据或启用自动合并；这一暂停是当前团队选择，不记为永久否决，也不把某一种认证方式写成适用于所有未来环境的限制。

### 费用边界

公开仓库的标准 GitHub 托管 runner 使用免费运行分钟；较大规格 runner 和其他计费项目另按平台规则核对，不能将这一选择解释为所有 Actions 服务均免费。[GitHub Actions 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)，2026-09-18 核对。

原生 Codex 审查使用当前账号可用的订阅审查额度，受账号计划和用量限制；额度不足时不自动改走付费 API 或开启额外付费审查。当前未启用超额积分审查，后续变更费用安排需有明确的新选择。账号额度与平台价格不在本 note 固定为长期数值。

## 方案考量（alternatives）

- 继续使用私有仓库的托管 CI：用户已指出免费分钟用尽后每次 CI 会产生费用，随后明确接受公开源码并选择标准公共 runner。采用公开组合的理由是控制这部分运行成本，具体资料范围另由 #50 记录。
- 在 Actions 内配置 Codex 审查并自动合并：用户曾提出该方案，并询问能否使用订阅；讨论到公开仓库认证和额外 API 费用后，明确要求先暂停设置，再选择原生订阅审查。当前保留暂停事实，不推断其永久不可用。

以上只提炼用户实际提出并给出理由的方案，确认摘要见 [Issue #54](https://github.com/TonQiaN/Agent_flow/issues/54)。

## 影响与验证

当前操作入口为 [开发工作指南](../../../../docs/development/workflow.md) 与 [CI 指南](../../../../docs/development/ci.md)。核对仓库公开状态、标准 runner、Actions 触发与固定检查、原生审查设置，以及暂停的自动化未被启用；平台状态与文档检查结果见 [本次验证记录](../../../../docs/validation/2026-09-18-agent-notes.md)。

本 note 记录已确认并配置的协作组合，不证明每个 PR 已获得充分审查、全部 Issue 已通过真实验收或整个开发流程已自动化。原有开发流程记录仍按其尚未完成的整体范围保留生命周期。

## 重开条件

尚未另行约定固定复评周期。若未来需要恢复自定义 Actions 审查或无人值守合并，须重新确认任务范围、验收证据、认证与费用安排；本次暂停不会自行解除。

## 确认与变更留痕

- 2026-09-18：用户先提出原生审查和 Actions 验收后合并，随后明确暂停 Actions 内 Codex 审查设置，并明确选择“公开仓库 + 免费标准 Actions runner + 订阅内原生 Codex 审查”。仓库可见性和原生审查已在本次记录前完成配置。
- 2026-09-18：[Issue #54](https://github.com/TonQiaN/Agent_flow/issues/54) 登记用户要求将这项分工写进一份 note，并统一 `agent_notes` 命名。TonQiaN 主责，Codex 提炼、核对及作者自查；没有其他开发者的人工审阅，不将原生 AI 审查视为人工批准。
