# Claude 订阅执行组合验证

2026-09-09，基于本地01c7086，在同一独立 detached 工作区推进 #10/#11 与 #9/#12 的组合边界。主责 @xiaoxuanli-a，Codex 实施和作者自查；未独立多人评审，未创建分支、新 PR 或执行远端合并。

## 参考与实现

先检查 Blackbox Agent Flow HEAD5610d1b/v0.1.22 已提交的 Claude 定义、凭据登录/独占绑定测试、状态目录测试、管理策略和相关历史，包括 f508c78 的破损写入恢复。旧工作区的其他改动未修改或作为发布能力采信。随后读取现有固定 Claude2.1.226 镜像程序中的 OAuth 保存/合并/invalid_grant 清除逻辑，只读取程序文件，没有读取任何用户凭据；临时程序片段不进入仓库。

已实现 ClaudeSubscriptionCodec/Profile/Redactor、ClaudeSubscriptionRunner 和 ClaudeAgentDriver。两个订阅组合通过内部配方共享执行/清理和文件输入交接，原 Codex 入口保留。通用 Docker 和 engine 没有新增 provider 分支。单个前导点的相对凭据文件名被明确支持；state 路径环境校验保持不变，固定非秘密开关通过分立 env argv 进入进程。

## 检查与结果

新增7组验证：4组 codec/Profile/脱敏、1组隐藏文件名绑定、1组合成 Docker 完整交接、1组真实 CLI 断网格式识别。组合测试覆盖：

- 真实 Docker 中合成可执行程序检查固定 cwd/state、只读管理文件、开关和代理配置；读取合成凭据并改写刷新，修改输入副本、生成 JSON 文件、输出单/多出口协议。
- 原始输入保持相同；AgentExecutor 接纳正确文件契约，产出可物化的独立输出；普通事件不泄露初始/刷新 token，返回视图修改不影响内部事实；执行目录和交接目录释放。
- 畸形刷新不覆盖原存储，正常 Harness 接纳被阻止；明确 invalid_grant 清除状态条件回存；下一次运行在工作副本写入前拒绝，并释放租约。管理重新配置可恢复，执行刷新不能隐式复活。
- 版本错误时不取得凭据租约（测试主动持有它），可恢复/释放版本探针句柄；官方 endpoint、capacity=1、clientId 不变、非法范围/字段及相对路径逃逸检查。
- 真实镜像 agentflow/agent-claude:21e8235ace16，image ID sha256:d1efc5c58eaef1c80176cf3f881b9d872d7a49f7638bc5e523a8a2a573d5bb74。在 network=none、合成凭据、实际 FileExecutionCredentialBinding 下，auth status 返回 loggedIn=true、authMethod=claude.ai、subscriptionType=max、email/orgId=null。原存储不变，绑定与工作区释放。这是本地格式识别，不是远端有效性。

权限核对发现旧 Read/Edit 单斜线写法不明确锚定文件系统根，已按[官方规则](https://code.claude.com/docs/en/permissions)改用双斜线绝对路径。Read 表达内置读工具的文件拒绝，Edit 表达写工具拒绝；sandbox 路径保持普通绝对路径。当前测试核对策略声明与传递，没有把它冒充实际工具执行隔离证据。

普通沙箱内首次检查的4个既有本地代理测试因 listen EPERM 被环境拒绝；在允许本机监听和 Docker 的环境重跑。首次完整组合回归164项通过；补充真实绑定格式检查后，最终完整回归结果在下方记录。

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=agentflow/harness-codex-chatgpt:55517b18fd19 AGENTFLOW_CLAUDE_IMAGE=agentflow/agent-claude:21e8235ace16 npm run check
```

**完整回归165项通过，0失败、0跳过。** 最后修正 Read/Edit 权限路径后，构建和测试类型检查再次通过，并对所有受影响的 Claude Adapter、组合和真实启动测试补跑：**9项通过，0失败、0跳过**。未在无新改动的情况下重复其余测试。

## 仍未证明

没有使用真实 Claude 凭据、调用模型或认证服务；没有真实 OAuth 刷新。当前文件格式没有稳定账号标识，clientId/结构检查不证明账号归属。真实 Claude 工具隔离、受控模型调用、单/多出口任务仍未验收；DeepSeek 及后续 Issues、真实学生批卷/完整报告/PDF 保持未完成。结果为本地测试，不是未创建的矩阵 PR 的 CI。

[使用指南](../guides/claude-execution.md) · [前一切片](2026-09-09-claude-adapter.md)
