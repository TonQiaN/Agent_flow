# DeepSeek Adapter

`DeepSeekAdapter` 是纯调用计划与原生会话解释器，固定对应 dsh 0.1.1-rc.2。宿主 API key Profile、存储和受控联网执行组合尚未接通；当前由本地合成服务驱动真实 CLI 验证，不能直接当作完整执行入口。

## 调用计划

通过 `HarnessRegistry.register(new DeepSeekAdapter())` 显式注册。任务提供执行身份、原样 prompt 和 config；config 必须包含合法 model、search=false、subagents=false，可选 reasoning 为 off/low/high/max。不允许任务指定 argv、环境、路径、插件或 API 地址。

plan 固定工作目录 /task/work、只读 /task/config/deepseek.json 和容器启动程序；通过 requirements 声明 private-state、readonly-config、controlled-egress、deepseek-runtime-assets 与 deepseek-session-record。宿主须满足全部声明，提供匹配当前实现的受信容器资产，并按 DEEPSEEK_SESSION_RECORD 采集私有会话。工具服务、启动/采集程序位于 src/apps/deepseek-tools；Adapter 只声明资产位置，不读取应用文件或启动进程。所需 SDK 是镜像内精确版本的可选 peer，宿主库不加载它们。

authentication 声明 service=deepseek、method=api-key 和固定私有交接位置 /task/state/deepseek-api-key.json。Adapter 不接收、寻找或读取密钥。声明本身不等于已提供宿主认证实现。

## 完成与出口

宿主调用 interpret 时传入原始 stdout，以及 records.deepseek_session 的原生 JSONL 字节。records 的键对应 Runner capture.files；Adapter 核对两类采集的字节数与完整性，不把 stdout 当作会话。原始文件仍由可信执行边界读取，普通事件使用宿主提供的 redact。

省略 outcomes 表示单一默认出口，原生会话正常结束后仍须通过引擎文件契约校验。提供 outcomes 时必须是 2–32 个不重复的合法标识符；只读配置注册 agentflow_outcome 工具。工具说明要求全部产物完成后选择一次并结束，用户任务文本保持原样。

宿主接纳多出口须同时具备：模型声明和实际调用一致、原生工具结果明确成功、工具专属 metadata 的 schema/outcome 与调用参数及用户枚举一致、无未结工具、随后无进一步工具调用，并正常结束会话。失败的无效参数可以纠正；成功选择后重选或调用其他工具，整个 Harness 结果失败。聊天文字、模型自写的 JSON、非该工具的结果均不承担选择权限。outcome 不提供额外文件路径，也不替代 outputs contract。

主模型用量只累计原生 assistant/message，避免流式计数重复。自动标题模型插件关闭；出现压缩模型工作或重试等不能完整计费的记录时，统一用量为 null，不把主步骤数冒充完整账单。其他缺失字段同样保持未知。

验证和范围见 [Adapter 与结构化出口验证](../validation/2026-09-09-deepseek-adapter.md)。
