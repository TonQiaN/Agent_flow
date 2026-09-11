# Changelog

这里记录实际变化；未来目标见 [Roadmap](docs/roadmap/README.md)，维护方式见 [版本维护指南](docs/development/versioning.md)。目前尚无正式发布版本；Unreleased 中的编号表示目标版本归属，不代表整版完成或已发布。

## Unreleased

### 0.1.1（目标版本，未发布）

以下为已合入的首版产品变化；完整范围和剩余验收见 [0.1.1 计划](docs/roadmap/0.1.1.md)。

#### 新增

- TypeScript 工作区、严格编译、依赖边界检查、Node 测试与 Node 24/26 CI；CLI 提供可运行的确定性 Component 示例。
- Component 定义、实现注册与一次执行分离，使用 Run/NodeTask/Attempt 身份、严格 JSON Schema 和独立输入/结果副本；业务 outcome 与执行失败分别处理。
- Docker Runner 提供独立可写输入、固定任务目录、有界原始输出采集、真实停止确认、容器清理和显式工作区释放；支持只读协议配置注入与 nested-userns-v1 沙箱策略。
- 可选 CONNECT 代理为每次执行建立独立网络，限制精确公网 IPv4 目标、阻止直连与外部 DNS，并与任务共同清理。
- 独立 Harness 注册与 Codex 0.153.4 调用计划/终态解析；managed ChatGPT codec、显式 Profile、同镜像版本预检和已知凭据值脱敏组成首个订阅执行入口。
- 私有凭据存储、跨进程独占租约及 generation/revision 检查；执行使用单次副本，停止和清理后条件回存，失败保留租约并阻止提前释放工作区。
- 文件契约自动收集 outputs，校验路径、目录树、数量、大小、类型和 JSON 内容；交接复核摘要并生成独立副本。Agent 接纳使用绑定身份、快照和 outcome 的进程内可信收据，拒绝伪造前序和重复 Attempt。
- 串行 Workflow 编译、路由和有界返修，接入 JSON/文件函数、Agent、确定性 Script、文件到 JSON Transform 及模拟 Effect；支持最大步数、查询和合作式取消，保留最后接纳结果与停止未证实状态。
- 模拟 Effect 默认 dry-run，实际操作校验一次授权、独立业务凭据及幂等请求；同键不同请求拒绝，未知结果保留占位并阻止重发，取消不冒充回滚。
- Tutor 合成批卷通过业务 Gate、用户返修、来源证明及模拟发布；宿主可注入驱动和路由，真实 Codex 已通过合成试题正常及一次返修流程，输入副本可改且原始材料不变。

#### 修复

- Codex 临时 input/work/outputs 的元数据权限采用固定子路径映射，避免默认只读挂载阻止启动，仍保护认证文件。
- Codex 解析允许 turn.started 前的初始化警告，并将明确 turn.failed 识别为失败终态；仍拒绝冲突或终态后的事件。
- 文件收集忽略未归属的普通空目录，避免工具遗留空目录阻止合法交付；未声明文件、危险链接和已声明目录树仍严格验证。

#### 已知限制

- 主干尚未交付持久化恢复、队列、自动重试与并行；进程内收据、模拟 Effect 不构成跨崩溃的外部 exactly-once 保证。
- 真实 OAuth 刷新、Claude/DeepSeek 完整组合，以及真实学生批卷、完整报告/PDF 的主干验收尚未完成；合成试题通过不能代替这些验收。

### 开发协作（未分配产品版本）

- 建立决策、当前说明、原始资料的分层入口，提供 Roadmap、CHANGELOG 与手工发布维护指南；变更按目标版本归类，同一未发布功能收敛为当前行为，正式发布仍需核对远端 tag。
- 五类主 Issue 表单提供“开发流程 / 项目内容”领域分类，聚焦情况、期望结果与边界，保留缺陷事实；开放空白入口，Sub-issue 的内容与形式由负责人自主决定。见 [Issue #21](https://github.com/TonQiaN/Agent_flow/issues/21)。
- 明确主／子 Issue 与 PR 的责任、追溯和整体验收；当前交接定位最新提交及验证，历史结果保留原日期、范围和限制。见 [Issue #32](https://github.com/TonQiaN/Agent_flow/issues/32)。
