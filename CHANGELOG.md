# Changelog

这里记录实际变化；未来目标见 [Roadmap](docs/roadmap/README.md)，维护方式见 [版本维护指南](docs/development/versioning.md)。目前尚无正式发布版本，Unreleased 不代表已发布。

## Unreleased

### 新增

- 增加 Codex managed ChatGPT codec、明确 Profile、同镜像版本预检、已知凭据值脱敏及订阅执行组合入口；本地和合成 CLI 连接测试通过。真实账号与模型验收仍待明确授权，未宣称完成真实 Agent 执行。

- 新增独立私有凭据执行绑定：单次副本、停止和清理后条件回存、失败保留租约，以及收尾前禁止释放工作区。合成刷新已在真实 Docker 的非零退出、取消和超时场景验证；真实 provider 组合仍待完成。

- Docker 新增可选 CONNECT 代理：每次执行独立网络、精确公网 IPv4 目标、禁用直连及外部 DNS、有界转发与共同清理；真实 TLS、拒绝路径和故障清理已验证。真实 provider 联合运行仍在实施。

- Docker 支持只读协议配置文件注入及宿主选择的 nested-userns-v1 策略；真实 Codex 沙箱验证了可写任务副本与认证文件访问拒绝。真实 provider 联合运行仍待完成。

- Harness 显式注册、Codex 0.153.4 调用计划和结束后事件/终态 parser；新增私有凭据存储、跨进程独占租约与 generation/revision 刷新检查。当前为独立接口与存储实现，真实认证 Runner 组合仍在实施。

- 离线 Docker Runner：每次执行可写独立输入副本、统一任务路径、流式有界 raw 采集、实际停止确认、容器清理和显式工作区释放；新增真实 Docker 验收。认证和联网 Harness 后续接入。

- 根 src 下的 TypeScript 工作区、严格编译、依赖边界检查与 Node 测试/CI 配置。
- 确定性 gate/transform Component、独立定义与实现注册、Run/NodeTask/Attempt 身份、严格 JSON Schema 契约和输入/结果副本；CLI 提供可运行 demo。尚不包含 Workflow、容器或真实 Agent。

- Issue 表单扩展为功能、缺陷、研究、决策、维护五类；加入交付物选择、续接记录和各类专用字段，支持仅交付正式决定的研究/讨论，并提供填写指南和边界示例。

- 建立 Roadmap 总览与按需版本计划方式，区分版本安排、任务进展和实际交付。
- 增加变更记录及手工发布维护指南，明确发布 tag、维护职责和 PR 中的同步时机。
