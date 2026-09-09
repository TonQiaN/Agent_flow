# Claude 订阅执行组合

ClaudeSubscriptionRunner 把独立 ClaudeAdapter、Profile、私有凭据绑定、Docker Runner 和受控 CONNECT 代理组合起来；ClaudeAgentDriver 将其接入 AgentExecutor 的文件契约和收据。当前已通过合成 CLI 的完整执行/刷新/文件交接，以及真实 Claude 2.1.226 的断网启动和本地凭据格式检查。实际工具隔离现已由断网本地协议替身驱动真实 CLI 验证；真实模型交付和 OAuth 刷新仍未验收。

## 接口与目录

宿主显式配置 FileCredentialStore(root, [new ClaudeSubscriptionCodec()])，只导入专用的 Claude 文件或明确提供的内容；不能隐式读取终端环境、桌面登录或整个旧状态目录。Profile 为：

```ts
const profile = {
  id: 'marking', service: 'anthropic', method: 'subscription',
  credentialRef: 'dedicated-claude', endpoint: 'official', capacity: 1,
} as const;
```

用 `new ClaudeSubscriptionRunner(store, { workspaceRoot, image, proxyImage })` 创建宿主执行入口，`run({ task, profile, inputSource, timeoutMs }, cancellation?)` 返回带 result、retryCleanup、release 的执行句柄。先确认镜像 ID 与版本，再取得凭据租约；版本不符的句柄也必须按真实停止/清理结果释放。模型参数、prompt 和 outcomes 见 [Adapter](claude-adapter.md)。

`new ClaudeAgentDriver(runtime, artifactStore, profile, { inputRoot, timeoutMs })` 可作为 AgentExecutor 的 driver。文件准备、outputs contract 接纳、清理和可信收据沿用 [Agent 接纳](agent-acceptance.md)，Workflow 不需要 Claude 分支。Codex 和 Claude 的共同执行收尾及输入物化实现集中在 integrations 内，provider 配方分别提供计划、版本、认证和脱敏；没有可由 Workflow 动态配置的通用 provider 开关。

cwd=/task/work；input、work 和 outputs 是本次可写副本。凭据只写入 /task/state/claude/.credentials.json，0600，父目录0700；管理 JSON 在 /task/config 只读挂载。同一管理文件通过宿主固定映射只读挂到 /etc/claude-code/managed-settings.json；发布版 CLI 不采用管理路径环境变量，不能依靠它改变加载位置。两项固定非秘密开关通过 `/usr/bin/env` 的分立 argv 参数传入；state 环境接口仍只接受 state 内路径，调用者不能任意覆盖环境。代理仅允许 api.anthropic.com 和 platform.claude.com 的443端口；登录流程不在任务执行里发生。

## 格式、刷新和无效状态

固定版本 codec 只接纳顶层 claudeAiOauth，以及其中 accessToken、refreshToken、expiresAt、scopes 和可选 refreshTokenExpiresAt、subscriptionType、rateLimitTier、clientId。额外 MCP/API key 材料、未知字段、非法计数/时间和缺少 user:inference 的范围拒绝。过期时间不代表远端有效或自动刷新成功；仍由 CLI 刷新。该文件没有稳定 account_id，不能宣称如 Codex 一样核对了账号归属。条件回存保留 clientId，其他并发条件由 credentialRef 独占锁和 generation/revision 负责。

CLI 明确清除无效登录时的空 accessToken、空 refreshToken、expiresAt=0 是已识别状态，需回存以免重新启用旧 token。下次执行在写入工作副本前拒绝，需要显式重新配置；仅恢复非空 token 的执行刷新不允许复活这个状态。明确重新配置可替换它。畸形 JSON 或未知字段则不覆盖原存储，报告 CREDENTIAL_REFRESH_FAILED。

停止/清理未知时保留句柄和租约；取消、非零退出也可能产生刷新，仍按绑定收尾。普通事件替换本次初始和刷新 token，原始日志保持私有；这种替换不是任意编码或业务敏感信息的完整过滤。

## 验证边界

真实 `claude auth status --json` 在关闭网络、使用明确合成 token 时也会返回 loggedIn=true 和 authMethod=claude.ai。这只能证明本地格式与路径可识别，不能用它证明真实登录有效。

Claude Read/Edit 文件规则用双斜线标识绝对路径：Read(//task/state/**)、Edit(//task/state/**)、Edit(//task/config/**)。sandbox.filesystem 的路径仍用单斜线。旧 Blackbox 单斜线权限规则未直接复用，依据 [Claude 文件权限规范](https://code.claude.com/docs/en/permissions)。配置存在或真实 CLI 启动不单独证明工具隔离。现有 [实际工具回归](../validation/2026-09-09-claude-tool-isolation.md) 通过本地协议替身驱动真实工具，覆盖文件拒绝、链接/proc 路径、正常副本写入和 Bash 网络阻断；它仍不证明真实模型请求和远端刷新。

[验证记录](../validation/2026-09-09-claude-execution.md) · [认证决定](../../.agents/decisions/product/README.md#p-20260909-auth-lifecycle)
