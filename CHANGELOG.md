# Changelog

这里记录实际变化；未来目标见 [Roadmap](docs/roadmap/README.md)，维护方式见 [版本维护指南](docs/development/versioning.md)。目前尚无正式发布版本，Unreleased 不代表已发布。

## Unreleased

### 重要变更

- 五类表单明确用于主 Issue，增加“开发流程 / 项目内容”领域分类，聚焦当前情况与期望结果，保留缺陷事实并移除预设方法字段。开放空白入口；Sub-issue 的内容与形式由负责人自主决定，暂不提供模板或写作建议。同步主／子 Issue 与 PR 的职责、追溯和验收说明，见 [Issue #21](https://github.com/TonQiaN/Agent_flow/issues/21)。

### 新增

- 增加与 Harness/认证解耦的 Agent 接纳层、Codex 执行驱动及进程内可信收据：绑定身份、输入输出快照与 outcome，拒绝伪造/跨 Run 前序和重复 Attempt，清理恢复不会升级原失败结果。

- 文件契约注册与本机快照适配解耦：自动发现 outputs、校验路径/树/数量/大小/类型及 JSON Schema，拒绝歧义和未归属内容；交接重新校验摘要并生成独立副本，失败清理半成品。已接入真实 Codex 小任务，可信前序记录已接通，完整 Workflow 仍待完成。

- 增加 Codex managed ChatGPT codec、明确 Profile、同镜像版本预检、已知凭据值脱敏及订阅执行组合入口；本地、合成 CLI 连接与获授权的真实 Codex/gpt-5.6-sol 数字任务通过，输入副本可改且原件不变；通用文件契约已接入，真实刷新与 Tutor 流程仍待验收。

- 新增独立私有凭据执行绑定：单次副本、停止和清理后条件回存、失败保留租约，以及收尾前禁止释放工作区。合成刷新已在真实 Docker 的非零退出、取消和超时场景验证；真实刷新仍待验证。

- Docker 新增可选 CONNECT 代理：每次执行独立网络、精确公网 IPv4 目标、禁用直连及外部 DNS、有界转发与共同清理；真实 TLS、拒绝路径和故障清理已验证。已接入首个 Codex 订阅组合。

- Docker 支持只读协议配置文件注入及宿主选择的 nested-userns-v1 策略；真实 Codex 沙箱验证了可写任务副本与认证文件访问拒绝。已接入首个 Codex 订阅组合。

- Harness 显式注册、Codex 0.153.4 调用计划和结束后事件/终态 parser；新增私有凭据存储、跨进程独占租约与 generation/revision 刷新检查。真实认证 Runner 组合见上述首个订阅入口。

- 离线 Docker Runner：每次执行可写独立输入副本、统一任务路径、流式有界 raw 采集、实际停止确认、容器清理和显式工作区释放；新增真实 Docker 验收。认证和联网通过独立集成层接入。

- 根 src 下的 TypeScript 工作区、严格编译、依赖边界检查与 Node 测试/CI 配置。
- 确定性 gate/transform Component、独立定义与实现注册、Run/NodeTask/Attempt 身份、严格 JSON Schema 契约和输入/结果副本；CLI 提供可运行 demo。该确定性入口不包含 Workflow 或 Agent 执行。

- Issue 表单扩展为功能、缺陷、研究、决策、维护五类；加入交付物选择、续接记录和各类专用字段，支持仅交付正式决定的研究/讨论，并提供填写指南和边界示例。

- 建立 Roadmap 总览与按需版本计划方式，区分版本安排、任务进展和实际交付。
- 增加变更记录及手工发布维护指南，明确发布 tag、维护职责和 PR 中的同步时机。

### 修复

- Codex 0.153.4 对固定临时 input/work/outputs 显式允许元数据子目录写入，避免不适用的默认只读挂载；新增真实离线启动与元数据写入/认证隔离回归。

- Codex 初始化警告可出现在 turn.started 之前；明确的 turn.failed 作为失败终态处理，避免误报事件顺序或缺失终态。冲突和终态后的事件仍拒绝。

- 文件收集参考 Blackbox 忽略未归属的普通空目录，避免 Harness 工具留下的空目录阻止合法交付；未声明文件、危险链接和已声明目录树仍严格验证。
