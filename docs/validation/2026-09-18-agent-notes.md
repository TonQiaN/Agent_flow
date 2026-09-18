# agent_notes 更名与 CI / AI 审查分工

日期：2026-09-18。对应 [Issue #54](https://github.com/TonQiaN/Agent_flow/issues/54)。基线 `main@d53e3f8319f946fe0dd91a7f2f00beca05474db2`；分支 `codex/agent-notes-review`。TonQiaN 主责，Codex 实施与作者自查，未进行其他开发者的人工审阅。

## 范围

将正式笔记目录统一为 `.agents/agent_notes/`，保留原有记录、稳定 ID 和分类生命周期，同步受影响的 Markdown 入口、链接、示例路径和指令归属。新增 [CI 与 AI 审查分工 note](../../.agents/agent_notes/development/README.md#d-20260918-ci-ai-review)，并在当前开发与 CI 指南中提供操作入口。

本次检查限定于正式仓库文件及 materials 的五份根级管理文件，没有读取或修改本地原始资料。历史验证文档只更新现行路径映射，日期、提交和测试结论保留原身份。历史资料公开验收的最新范围在已关闭的 [Issue #50](https://github.com/TonQiaN/Agent_flow/issues/50)，本次不重新执行历史清理或凭据审计。

## 平台与配置读回

- GitHub 仓库为 public，`allow_auto_merge` 为 false；main 要求严格的 `CI required`，来源为 GitHub Actions app 15368，管理员也受约束。当前没有强制批准人数。
- `.github/workflows/check.yml` 为 PR 与手动触发；七个 job 定义均使用标准 `ubuntu-latest`，Node 矩阵展开后为八项检查。本次没有修改工作流、产品代码或版本。
- Codex 仓库设置为 Review all PRs，触发及全面审查继承个人设置；个人自动审查已开启，触发为创建 PR，全面审查开启，额外积分开关关闭。本次仅读取设置，没有变更权限、认证或费用安排。
- Codex 设置页仍显示更新 GitHub 权限的提示；以上记录证明所读设置值，不单独证明新 PR 的审查已成功执行。交付 PR 的实际审查结果另在 PR 记录，不把配置状态当作本次模型验收。

能力和费用表述核对 [OpenAI 原生审查说明](https://learn.chatgpt.com/docs/third-party/github) 与 [GitHub Actions 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。只记录当前选用组合及其边界，不将未来认证选项或价格写成永久规则。

## 文档与目录检查

- 扫描 203 份正式 Markdown，核对 1,039 处相对文件链接及锚点，未发现失效引用；基线 1,023 处同样无失效项。
- 原目录的 39 个跟踪条目完整迁移，28 个既有 D-/P- ID 全部保留且唯一，新增 `D-20260918-ci-ai-review`；分类索引锚点与唯一正文路径均能定位。
- 根目录、agent_notes 与 materials 共三组 `CLAUDE.md -> AGENTS.md` 相对符号链接有效，目标内容一致；唯一书写归属沿用原负责记录。
- 正式 Markdown 的当前入口和结构图均使用 `agent_notes`，没有遗留指向旧目录的当前引用。固定历史提交的五处证据 URL 保留该提交中的原目录路径；历史验证文件名、历史分支名及稳定 ID 也保留原身份，不将其误当作现行目录。
- `git diff --check` 通过；除 Docker policy README 的文档链接外，src 无改动，Actions 工作流、包元数据与锁文件保持基线内容。

核对使用基线 Git 文件清单与当前跟踪/新增正式文件集合，逐项比较迁移完整性、唯一 ID、索引正文对应、Markdown 相对路径和目标标题锚点；临时检查脚本与输出保存在仓库外。未引入新的产品测试或 CI 门禁。

## 审查反馈与修正

[PR #55 原生 Codex 审查](https://github.com/TonQiaN/Agent_flow/pull/55#discussion_r4045689696) 指出首版 `10a4200` 将五个固定历史提交的 GitHub URL 路径一并改写；提交不可变，新目录在对应旧版本中不存在。初次相对链接检查没有覆盖这种远端证据链接。

已恢复五处 URL 的原始路径，并补查基线中的 14 个固定版本证据 URL，均完整保留。五个 URL 对应三个历史文件，GitHub API 均可按原提交和路径读取，行数覆盖原有行号锚点；此检查只读取正式文档，不读取旧原始资料。当前目录路径与固定版本证据路径分别核对，相关边界已补入维护指南及文档分层记录。首版 CI 结果只归属 `10a4200`，修正后的最新提交和 CI 结果在 PR 中续接。

## 验证边界

这是文档和目录迁移，没有修改产品执行逻辑。本地按影响范围检查目录完整性、相对链接与锚点、稳定 ID、同目录符号链接及差异；不将这些检查记为产品测试或 Issue 业务验收。PR 会按现有配置运行完整云端 CI，其最新 head/base 与结果集中记录于交付 PR。未获新的合并授权，不在本次自动合并或关闭 #54。
