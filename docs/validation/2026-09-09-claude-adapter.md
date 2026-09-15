# Claude 调用与协议验证

2026-09-09，基于 Workflow 候选 c251a6b 开始 Harness 矩阵切片。独立 detached 工作区，未创建项目分支或新 PR。主责 @xiaoxuanli-a；Codex 实施与作者自查，未独立多人评审。对应 #10 及 #9/#11/#12 集成边界。

## 参考与实际版本

先读取 Blackbox 5610d1b 的已提交 claude/deepseek 定义、Claude managed policy、provider_adapters 测试、invocation goldens 与修复历史。旧工作区有未提交改动，本次未修改，也未将这些增量当作发布能力。借鉴其 safe-mode、独立状态、严格 MCP/工具和管理策略；新设计按用户要求允许修改 input 副本，不搬入旧 input 只读约定。

实际离线镜像 agentflow/agent-claude:21e8235ace16 的 `claude --version` 为 2.1.226 (Claude Code)，image ID 为 sha256:d1efc5c58eaef1c80176cf3f881b9d872d7a49f7638bc5e523a8a2a573d5bb74。读取实际 `--help` 核对 print、safe-mode、stream-json/verbose、json-schema、setting-sources 和 effort；帮助明确 bare 不读取订阅 OAuth，因此不采用。

结构化结果参考[官方非交互协议](https://code.claude.com/docs/en/headless)，输入 usage 桶参考[官方缓存语义](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。旧 usage 递归搜索在新项目不采用：只解释唯一终态，三种互斥输入桶齐全才计算总输入数，未知值不补零。

## 验证结果

新增 6 组纯 Adapter 测试和 1 组真实 Docker 离线启动：

- 原样 prompt 和 `--` 分隔；固定任务路径、独立状态和订阅需求；禁止工具联网、unsandboxed 回退以及读取 state/写入 state/config 的策略声明；未知配置、未支持功能、畸形模型名和 outcomes 在计划前拒绝。
- 同执行身份、指定版本和正常 Runner/完整 raw 与同 session init/result 共同构成接纳条件；重复终态不累计，冲突、跨 session、终态后事件和意外子 Agent 消息均失败。
- 多出口只取 result.structured_output 中唯一的 outcome；JSON-looking result 文本不能冒充结构化结果。
- 错误结果、畸形/超限/截断字节、错误版本/身份/停止/清理、脱敏失败不正常结束；已知错误 result 不误记为缺失终态。
- 普通事件无 raw 工具输入、错误对象、未知载荷或签名；文本经注入脱敏；usage 不读取嵌套计数或累加消息/重复快照，缺字段保留 unknown，非法计数拒绝。
- 实际镜像挂载生成的只读配置，使用临时空 Claude 状态、关闭网络和只读镜像启动，无凭据、无模型调用。CLI 正常解析调用并发出 init、assistant、result；退出码 1，result.subtype=success 但 is_error=true。Adapter 正确判为失败，未误报缺失终态；容器和临时配置清理。

测试发现初版模型名校验允许前导连字符；先查 Blackbox goldens，其旧实现明确原样传递这种形式，本项目按严格配置边界拒绝，修正后对应回归通过。独立工作区 npm 离线安装缺少锁定 tarball 缓存，随后按现有 lock 正常安装、禁用安装脚本，未修改依赖版本。

完整命令：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=agentflow/harness-codex-chatgpt:55517b18fd19 AGENTFLOW_CLAUDE_IMAGE=agentflow/agent-claude:21e8235ace16 npm run check
```

**158 项通过、0 失败、0 跳过**，包含依赖边界、构建、测试类型检查和全部既有 Docker、受控 egress、脚本、合成凭据及实际离线 Codex 检查。本地结果不是尚未创建的矩阵 PR 的 CI。

## 限制与后继

真实无凭据启动只证明调用参数及失败流可解释。此切片没有 Claude credential codec/执行组合，没有验证实际 OAuth、刷新、管理策略对模型工具的约束、受控模型联网或正常单/多出口交付。成功流测试是明确合成协议样本，不能称为真实 Claude 任务成功。

DeepSeek 尚未实现；已提前记录 Blackbox 的原生模块缓存/noexec、Node 代理环境及固定 workspace 写输出问题，后续先按新项目统一目录要求验证，不直接照搬旧 cwd。#9–#12、0.1.1 及最终真实学生批卷/报告/PDF 保持未完成。

[使用指南](../guides/claude-adapter.md) · [Harness 决策](../../.agents/decisions/product/README.md#p-20260909-harness-adapter)
