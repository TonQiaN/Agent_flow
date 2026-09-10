# Codex 订阅组合入口验证

对象：Draft PR #19，在 9172547 后接入 CodexSubscriptionCodec、明确 Profile、秘密脱敏与 CodexSubscriptionRunner。宿主 macOS arm64 / Node 26.0.0 / Docker Engine 29.4.3。

## 已验证

启用普通 Docker、受控联网及既有专用 Codex 0.153.4 沙箱环境后运行 `npm run check`：72 项通过，0 失败，0 跳过；依赖边界、构建和测试类型检查通过。新示例通过 Node 语法检查。

- 4 组本地测试：只接纳完整 managed ChatGPT token bundle；拒绝其他认证模式、API key 混入和未知字段；租约刷新不能更换 account_id，显式管理配置仍可替换；Profile 限定官方 endpoint 和 capacity=1；初始/刷新 token 及已知 ID claims 从普通事件替换，脱敏器序列化不含值。
- 1 组真实 Docker 版本预检：无 Codex 的镜像、预检前取消，都不会申请凭据租约。
- 1 组合成 CLI 测试：在 Docker 中运行明确标识的协议替身，声明测试版本但不调用模型/认证服务；验证同一镜像版本探测、工作副本、模拟刷新、双终态解释、初始和新 token 脱敏、输出交接及释放。此用例只证明组合连接正确，不能当作真实 Codex 任务成功。
- 原有真实 Codex 0.153.4 内部沙箱测试及公开 TLS 联网测试继续通过，仍分别保留其验收范围。

默认 CI 启用普通 Docker，用例总数中的 1 项专用 Codex 沙箱、3 项外部联网、1 项合成 CLI 镜像/网络测试需要本地环境，明确跳过。真实账号从不进入 CI。

## 真实小任务验收（2026-09-09）

用户明确授权专用测试凭据、chatgpt.com:443 / auth.openai.com:443 的令牌与任务内容发送，以及原锁内条件同步刷新后执行。最初拒绝发生在启动前，随后授权已补齐，当前没有待确认门槛。真实材料、原始流和凭据存储只留本机私有区，不提交到仓库或 CI。

同一不可变镜像 `sha256:b566ec5c9a620df1d9f0727ce03a15494b26074d0a09782f15f8a64a29a6d629` 的 Codex 0.153.4，使用 Blackbox 当前示例中的 gpt-5.6-sol 完成合成数字任务：Runner 实际退出 0、停止确认、容器删除，Harness 正常终态且没有诊断。`answer.json` 通过独立 JSON Schema 的 sum=6 检查；容器输入副本追加换行，宿主原件逐字不变；凭据租约和工作区均已释放。产物 SHA-256 为 `bf36dad286f560eec09aa880450f26dc03cc401e35c35299a2805058b5af6c8a`。

本次 refresh=unchanged、存储 revision=1，未修改原认证文件。因此实际模型调用通过，但不能将合成刷新回归当作真实 OAuth 续期证据。usage 直接取终态：input=71828、cached input=66304、output=1000、reasoning output=447，不累加嵌套字段或重复事件。

按用户要求先查 Blackbox Agent Flow 的实现与修复历史：其 5f58036 已处理节点间 provider-state 干扰，cd0e9f6 已补订阅请求和刷新域名；当前实现采用独立状态与受控域名，保留本项目独占租约和条件回写设计。参考工作树基线为 5610d1b，存在本地未提交审计改动，不将这些改动当作已发布行为。

实际失败带来两项明确回归：Codex 可在 thread.started 后、turn.started 前发出 item.completed/error 初始化警告；turn.failed 是明确失败终态。parser 现区分这些事件，不把警告单独当作失败，也不把失败终态误报为缺失或要求正常出口。失败、冲突终态、终态后事件仍不能通过。新增 2 组回归后，完整本地检查为 **74 通过、0 失败、0 跳过**，包括真实 Docker、Codex 内部沙箱与受控联网。

曾有一次完整会话启动报 bwrap 无法只读重挂载工作目录内 `.agents`。查参考实现和修复记录未找到同一修复；离线合成凭据对照在预建与未预建目录两种条件下均能启动，后续真实调用也成功。目前原因未确定，没有添加预建目录或关闭沙箱的补丁，也不声称该偶发问题已修复；再次出现时按保存的症状继续定位。

此前 gpt-5.4-mini 和 gpt-5.4 均被远端明确返回不支持该 ChatGPT 账号的模型；名称格式通过不代表账号可用，实际模型由调用配置选择，不在引擎里做静默替换。

示例读取拒绝符号链接/共享文件并限制 64 KiB；这是示例验收逻辑，通用文件 contract 收集器和可信前序证据仍未完成。真实多出口、其他 Harness、Tutor 批卷与报告/PDF 尚未验收。PR 保持 Draft，#9–#12 不据此关闭。

## 来源与局限

文件模式与刷新方式参考 [官方认证说明](https://learn.chatgpt.com/docs/auth) 和 [可信自动化的认证保存流程](https://learn.chatgpt.com/docs/auth/ci-cd-auth)（2026-09-09 核对）。格式校验和本地 token 存在不证明远端有效性。普通事件替换只保护已知凭据值，不保证识别任意编码或所有业务 PII；原始日志持续保持私有。

对应设计见 [Harness 决定](../../.agents/decisions/product/README.md#p-20260909-harness-adapter) 与 [认证决定](../../.agents/decisions/product/README.md#p-20260909-auth-lifecycle)。
