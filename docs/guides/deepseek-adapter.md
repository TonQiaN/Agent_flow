# DeepSeek Adapter

`DeepSeekAdapter` 是纯调用计划与原生会话解释器，固定对应 dsh 0.1.1-rc.2。宿主 API key Profile、存储、不可变绑定、DeepSeekApiKeyRunner 与 DeepSeekAgentDriver 已接通；已通过[官方正常/返修及图片多出口验收](../validation/2026-09-15-official-harness-acceptance.md)。

## 调用计划

通过 `HarnessRegistry.register(new DeepSeekAdapter())` 显式注册。任务提供执行身份、原样 prompt 和 config；config 必须包含合法 model、search=false、subagents=false，可选 reasoning 为 off/low/high/max。不允许任务指定 argv、环境、路径、插件或 API 地址。

plan 固定工作目录 /task/work、只读 /task/config/deepseek.json 和容器启动程序；通过 requirements 声明 private-state、readonly-config、controlled-egress、deepseek-runtime-assets 与 deepseek-session-record。宿主须满足全部声明，提供匹配当前实现的受信容器资产，并按 DEEPSEEK_SESSION_RECORD 采集私有会话。工具服务、启动/采集程序位于 src/apps/deepseek-tools；Adapter 只声明资产位置，不读取应用文件或启动进程。所需 SDK 是镜像内精确版本的可选 peer，宿主库不加载它们。

authentication 声明 service=deepseek、method=api-key、variable=DEEPSEEK_API_KEY，不声明任务密钥文件。Adapter 不接收、寻找或读取密钥。静态凭据边界见下节；声明本身不等于完整执行入口。

## 完成与出口

宿主调用 interpret 时传入原始 stdout，以及 records.deepseek_session 的原生 JSONL 字节。records 的键对应 Runner capture.files；Adapter 核对两类采集的字节数与完整性，不把 stdout 当作会话。原始文件仍由可信执行边界读取，普通事件使用宿主提供的 redact。

省略 outcomes 表示单一默认出口，原生会话正常结束后仍须通过引擎文件契约校验。提供 outcomes 时必须是 2–32 个不重复的合法标识符；只读配置注册 agentflow_outcome 工具。工具说明要求全部产物完成后选择一次并结束，用户任务文本保持原样。

宿主接纳多出口须同时具备：模型声明和实际调用一致、原生工具结果明确成功、工具专属 metadata 的 schema/outcome 与调用参数及用户枚举一致、无未结工具、随后无进一步工具调用，并正常结束会话。失败的无效参数可以纠正；成功选择后重选或调用其他工具，整个 Harness 结果失败。聊天文字、模型自写的 JSON、非该工具的结果均不承担选择权限。outcome 不提供额外文件路径，也不替代 outputs contract。

主模型用量只累计原生 assistant/message，避免流式计数重复。自动标题模型插件关闭；出现压缩模型工作或重试等不能完整计费的记录时，统一用量为 null，不把主步骤数冒充完整账单。其他缺失字段同样保持未知。

验证和范围见 [Adapter 与结构化出口验证](../validation/2026-09-09-deepseek-adapter.md)。

## 静态凭据与执行快照

DeepSeekApiKeyCodec 与 FileCredentialStore 接收显式内容或受控文件中的内部交接记录，固定 schema=agentflow-deepseek-key/v1 和 api_key 两字段；错误不回显内容。密钥为 8–8192 个无空白可打印 ASCII，记录不超过 16 KiB，不自动修剪或继承环境。使用 deepseekApiKeyProfile 校验元数据：service=deepseek、method=api-key、endpoint=official、credentialRef、id、capacity=null。认证层不施加会话独占；null 不表示远端额度无限。DEEPSEEK_API_KEY_HOSTS 固定为 api.deepseek.com。

宿主通过 `EnvironmentExecutionCredentialBinding.acquire(store, {identity, credential}, deepseekApiKeyEnvironment, waitMs, remember)` 在短租约内读取不可变快照，随即释放源锁。prepare 只绑定执行资源，不创建密钥文件；Docker create 的 argv 只包含 `--env DEEPSEEK_API_KEY`，值来自这次绑定提供的客户端环境。普通 Invocation.env、配置文件、结果和后续 Docker 查询不携带该秘密。

固定启动器只读取注入的 DEEPSEEK_API_KEY，校验格式后传给原生 CLI；不会搜索文件或其他环境来源。工具进程清空继承环境，保持独立进程视图。Docker daemon 管理员仍能查看容器环境，属于受信宿主边界，不能宣称密钥对管理员不可见。

finish 核对 Runner 身份、资源、停止和清理，确认容器移除后丢弃绑定快照。refresh=unchanged 表示未回存源 key，不再表示工作副本字节比对，也不证明远端有效。停止或清理未知时保留 beforeRelease 门槛；源锁已释放，管理 configure 的轮换或删除不会被旧执行覆盖。普通事件由 DeepSeekCredentialRedactor 脱敏，原始日志仍为私有证据。

当前验证见 [环境注入](../validation/2026-09-09-credential-environment.md)；早先的 [文件快照验证](../validation/2026-09-09-deepseek-api-key.md)保留历史证据，文件绑定 API 仍存在，但已不是 DeepSeek 组合的注入方式。

## 宿主执行入口

先由受信部署过程执行 `node src/apps/deepseek-tools/export-assets.mjs`，把 JSON 输出保存在宿主管理的部署文件中。这个命令不接受参数、不读取凭据、不加载 DeepSeek SDK。宿主读取该部署资产后，构造 `new DeepSeekApiKeyRunner(store, { workspaceRoot, image, proxyImage }, assets)`。资产参数独立于任务，须来自当前应用版本的可信打包结果；结构/版本检查不替代来源信任。

`run({ task, profile, inputSource, timeoutMs }, cancellation?)` 先解析不可变镜像 ID，再离线验证实际 dsh 版本；通过后取得 key 快照，并只开放 api.deepseek.com:443 的受控 CONNECT 代理。固定 13 个容器运行资产和 deepseek.json 只读挂载，任务工作路径不变。返回 DeepSeekExecution，result 区分 version/execution 阶段、Runner/Harness/认证结果与静态诊断，不含原始日志内容。

调用者保存需要的输出或私有证据后执行 retryCleanup/release；未知停止或凭据收尾未完成时不能跳过清理门槛。清理重试不升级原 Harness 结果。DeepSeekAgentDriver 接收 runtime、ArtifactStore、Profile 和 timeoutMs，交由 AgentExecutor 执行输出契约接纳。单出口由引擎分配，多出口取结构化结果；都不能只凭退出码或“完成”文字通过。

本地协议替身验证了组合的成功/失败/取消/版本漂移路径，原生 CLI 另有工具与交接回归；官方模型正常/返修和图片多出口已于 2026-09-15 另行通过。见 [宿主执行组合验证](../validation/2026-09-09-deepseek-execution.md)。

Driver 输入在已登记的 Runner 工作目录内物化，见[输入物化](runner-owned-input.md)。

## 图片模型配置

本轮 dsh 0.1.1-rc.2 使用 deepseek-v4-flash 完成文本批卷；图片任务使用 deepseek-v4-flash-vision-exp，经原生 read_image 实际读取后完成文件与多出口交接。前一个标识在该 CLI 模型表中未声明图片能力，read_image 会明确拒绝，即使远端服务改变同名别名的能力，也不能视为 CLI 已支持。宿主只更改现有 model 配置，不更新或绕过模型能力表；实际组合、保留失败和服务端别名限制见[本轮验收](../validation/2026-09-15-official-harness-acceptance.md)。
