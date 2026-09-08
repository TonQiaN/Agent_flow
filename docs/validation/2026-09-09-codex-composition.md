# Codex 订阅组合入口验证

对象：Draft PR #19，在 9172547 后接入 CodexSubscriptionCodec、明确 Profile、秘密脱敏与 CodexSubscriptionRunner。宿主 macOS arm64 / Node 26.0.0 / Docker Engine 29.4.3。

## 已验证

启用普通 Docker、受控联网及既有专用 Codex 0.153.4 沙箱环境后运行 `npm run check`：72 项通过，0 失败，0 跳过；依赖边界、构建和测试类型检查通过。新示例通过 Node 语法检查。

- 4 组本地测试：只接纳完整 managed ChatGPT token bundle；拒绝其他认证模式、API key 混入和未知字段；租约刷新不能更换 account_id，显式管理配置仍可替换；Profile 限定官方 endpoint 和 capacity=1；初始/刷新 token 及已知 ID claims 从普通事件替换，脱敏器序列化不含值。
- 1 组真实 Docker 版本预检：无 Codex 的镜像、预检前取消，都不会申请凭据租约。
- 1 组合成 CLI 测试：在 Docker 中运行明确标识的协议替身，声明测试版本但不调用模型/认证服务；验证同一镜像版本探测、工作副本、模拟刷新、双终态解释、初始和新 token 脱敏、输出交接及释放。此用例只证明组合连接正确，不能当作真实 Codex 任务成功。
- 原有真实 Codex 0.153.4 内部沙箱测试及公开 TLS 联网测试继续通过，仍分别保留其验收范围。

默认 CI 启用普通 Docker，用例总数中的 1 项专用 Codex 沙箱、3 项外部联网、1 项合成 CLI 镜像/网络测试需要本地环境，明确跳过。真实账号从不进入 CI。

## 尚未执行的真实验收

真实小任务已准备：读取合成数字输入，写入 /task/outputs/answer.json，经独立 JSON Schema 检查 sum=6，同时验证输入副本可改且宿主原件不变。文件读取拒绝符号链接/共享文件并限制 64 KiB；这是示例验收逻辑，通用文件 contract 收集器仍未完成。

只读检查确认专用测试认证文件是 managed ChatGPT 格式且有刷新字段，未输出 token 或账号值。随后真实运行命令被自动审批拒绝，进程没有启动：审批认为现有端到端授权未明确覆盖这份真实凭据、令牌对外使用及可能回写原文件，需要用户明确授权。没有绕过拒绝，未导入真实材料到新存储、未调用模型、未修改原认证文件。

待批准操作的具体边界为：独占专用测试凭据的原流程锁，仅访问 chatgpt.com:443 和 auth.openai.com:443，由 Codex 自行刷新，停止和清理后条件保存并在原锁内同步刷新。不会使用桌面应用的认证。真实结果未完成之前，PR 保持 Draft，#9–#12 不据此关闭。

## 来源与局限

文件模式与刷新方式参考 [官方认证说明](https://learn.chatgpt.com/docs/auth) 和 [可信自动化的认证保存流程](https://learn.chatgpt.com/docs/auth/ci-cd-auth)（2026-09-09 核对）。格式校验和本地 token 存在不证明远端有效性。普通事件替换只保护已知凭据值，不保证识别任意编码或所有业务 PII；原始日志持续保持私有。

对应设计见 [Harness 决定](../../.agents/decisions/product/README.md#p-20260909-harness-adapter) 与 [认证决定](../../.agents/decisions/product/README.md#p-20260909-auth-lifecycle)。
