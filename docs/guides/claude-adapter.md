# Claude Adapter（调用计划与协议）

ClaudeAdapter 是独立的纯映射/解析模块，可通过 HarnessRegistry 显式安装。当前针对实际离线镜像中的 Claude Code 2.1.226；它不启动容器、读取凭据或决定文件交付是否合约。订阅执行组合已接通并通过合成测试，工具权限和真实模型交付仍待后续验收，见 [执行组合](claude-execution.md)。

```ts
import { ClaudeAdapter } from '@agentflow/integrations';

const adapter = new ClaudeAdapter();
const plan = adapter.plan({
  identity: { runId: 'run', nodeTaskId: 'mark', attemptId: 'first', attemptNumber: 1 },
  prompt: '用户定义的任务说明',
  config: { model: 'sonnet', reasoning: 'high', subagents: false, search: false },
  outcomes: ['accepted', 'rejected'], // 单个正常出口时省略
});
```

首个映射支持 model、可选 reasoning=low/medium/high/xhigh/max，并要求显式 subagents=false、search=false。模型标识限 128 个字母/数字/下划线/点/冒号/连字符，首字符须为字母或数字；预算、任意 argv/env、未知字段和未支持组合拒绝。用户 prompt 原样保留，前面的 `--` 防止它被解释为选项。计划是声明，不能绕过 requirements 直接当成已满足权限的 Runner 请求。

## 目录与完成协议

计划使用 print、safe-mode、关闭会话持久化、严格 MCP、固定工具列表、stream-json/verbose 和明确模型。safe-mode 保留认证与管理策略；不使用 bare，因为实际 CLI 帮助说明 bare 不读取订阅 OAuth。cwd 固定 /task/work，input/work/outputs 均为可写任务副本，Claude 状态声明在 /task/state/claude。生成的只读策略要求禁止工具读取 state、写入 state/config、工具联网以及 unsandboxed 回退。宿主后续集成必须真实验证这些要求。

interpret 接受实际 Runner 结果、完整 stdout 字节、同镜像验证的版本，以及认证/日志层提供的 redact 函数。正常结束要求同执行身份、Runner exited/0、停止 confirmed、清理 removed、完整采集，和同一 session 内 system/init → result/success、is_error=false。真实无凭据启动已观察到 subtype=success 且 is_error=true，因此只检查 success 会误判。

多个 outcome 由 json-schema 限定终态 structured_output 中唯一的 outcome；聊天 result 字符串不提供该权威。单正常出口由后续 AgentExecutor 在 Harness 正常结束、outputs 合约后赋值。相同终态只处理一次，冲突终态、终态后事件、跨 session 或意外子 Agent 事件均失败。字段和传输方式依据[官方非交互说明](https://code.claude.com/docs/en/headless)。

## 事件、usage 与边界

普通事件只包含脱敏文本、工具名/标识、类型和执行身份；原始工具输入、错误对象、签名和未知载荷不整体复制。未知事件没有成功含义。解析有原始字节、单行、记录和事件数量边界；版本、字节编码/完整性、结构及脱敏失败均保留静态诊断。

usage 仅取唯一终态，不递归搜索或累加消息快照；失败终态中明确给出的有效计数同样保留。Claude 的 input_tokens 不包含缓存读取和创建；三桶齐全时 inputTokens 显式求和，否则 unknown。cachedInputTokens 只取缓存读取数；outputTokens 保留明确输出，reasoningOutputTokens 当前为 unknown。桶语义参考[官方缓存说明](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。

无凭据离线启动只证明实际 CLI 能解析生成的调用并报告失败，不证明登录、刷新、网络授权、工具隔离或真实任务成功。当前首个真实完成组合仍为 Codex；矩阵其他部分保持未验收。

[验证记录](../validation/2026-09-09-claude-adapter.md) · [Harness 接口](harness-auth.md)
