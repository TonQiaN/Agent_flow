# Harness 与凭据接口（首个组合实施中）

当前可独立使用 Harness 注册、Codex 调用计划/结束后 parser，以及 POSIX 本机私有凭据存储和独占租约。尚无可启动真实 Agent 的公共命令：计划不是 RunnerRequest，普通 Invocation.env 仍拒绝 CODEX_HOME 等额外配置；宿主须通过独立 PrivateStateBinding 注入受限的 state 路径环境。已有首个 managed ChatGPT codec、明确 Profile 与组合 API；已通过真实合成数字任务，通用文件 contract 已接入示例，可信前序执行证据、真实刷新与完整 Workflow 仍待验收。

## Harness

`HarnessRegistry.register(adapter)` 显式注册，重复 ID 或未知 Harness 报错。`CodexAdapter.plan(task)` 接收 Run/NodeTask/Attempt 身份、原样 prompt 和配置。当前配置必须明确 `model`、`subagents: false`、`search: false`；可选 `reasoning` 为 low/medium/high/xhigh。模型名称仅检查合法字符串，远端模型/账号可用性仍须实际调用验证。未知字段、预算、任意 argv/env、启用搜索/子 Agent 或不支持档位启动前拒绝。

计划针对 Codex 0.153.4，声明 cwd=/task/work、CODEX_HOME=/task/state/codex、私有认证文件和受控网络/内部沙箱需求。身份目录统一由 engine 的 TASK_PATHS 定义；configFiles 可经 Invocation.configFiles 注入只读 /task/config。用户 prompt 使用 argv 的 `--` 分隔符原样传入；调用计划可能含业务文本，应按该数据的访问范围保管。

Docker 环境支持宿主选择 `sandbox: 'nested-userns-v1'`，内置固定 Moby 基线派生策略以运行 Codex 的 bwrap；普通脚本默认 standard。已在 macOS Docker Desktop 使用真实 Codex 0.153.4 和合成凭据验证任务路径可写、auth.json/profile.json 拒绝读取的权限映射。CODEX_HOME 其余临时程序仍可执行，不能禁止整个目录，否则会阻止 Codex 自己的沙箱启动。此结果不证明任意 Linux/AppArmor 环境兼容，实际订阅模型小任务另见 [组合验证](../validation/2026-09-09-codex-composition.md)。受控网络也经独立真实 Docker 测试，见 [联网指南](controlled-egress.md)。

`interpret({task, runner, version, stdout, redact})` 只解释已采集的字节和执行事实，不读取日志文件。宿主负责保证这些证据来自同一次执行，并提供普通事件的秘密脱敏接口。版本、身份、字节数、完整性、Runner 正常退出与 Codex 正常终态均需匹配；不从“Done”、非空目录或退出 0 单独推断完成。初始化 error item 可在 thread.started 后、turn.started 前出现，只记录其类型；它不能替代终态。turn.failed 作为失败终态保留，不再误报缺失终态。重复相同终态只计算一次，冲突终态失败；usage 只使用终态的明确字段，未提供为 null，不补成零。

事件保留关联身份、顺序、来源类型、item ID 和有限已脱敏字段。未知事件只记录来源，不复制未知 payload；原始记录保持私有，当前没有实时事件推送或完整工具轨迹承诺。单出口正常结束的 outcome 为 null，等待引擎验收 outputs 后赋值。多出口由 outcomes 列表生成只读 schema，解析最后 Agent 消息中唯一的 outcome 字段；不要求 artifacts 清单。[通用文件 contract](file-contracts.md) 已提供，完整 Workflow 接纳尚未接通。

## 凭据存储

`FileCredentialStore(root, codecs)` 接收当前用户拥有的绝对目录与显式服务/认证方式 codec。root 必须为 0700，文件为 0600、当前 UID、单链接普通文件。存储根外的祖先目录须由宿主控制；当前支持非 root POSIX 进程，未宣称 Windows 或跨机器协调。

- `configure(identity, {content})` 或 `configure(identity, {file})`：仅一个受控来源，不读环境变量；codec 只验证本地格式。新记录 revision=1，变更时递增，同内容不递增。
- `inspect(identity)`：返回身份、generation、revision、remoteStatus=unknown 或 null；不验证远端订阅、token 或额度。
- `acquire(identity, waitMs)`：按 credentialRef 跨进程独占，默认立即报 busy，最多等待 60 秒。返回的 lease 普通序列化只含元数据。`readSecret()` 仅供受信执行绑定使用。
- `lease.commitSecret(content, expectedRevision)`：在同一租约内验证旧 revision 与存储 generation/revision，校验新格式后原子替换。调用者须携带生成工作副本时的 revision；旧副本不能冒充最新读取。
- `lease.release()`：幂等释放。释放后读写失败。执行绑定先证明旧执行已停止且清理成功；停止未知时不会释放给另一任务。
- `delete(identity)`：与运行共用同一个锁，只删除本地已识别记录；明确返回 remoteRevoked=false。重新配置产生新 generation。

不同 Profile 若引用同一 credentialRef，应使用同一占用身份；当前没有持久 Profile 管理器、远端账号别名识别或大于 1 的订阅并发。内部异常在返回租约之前释放锁；得到租约后由调用者负责生命周期。进程崩溃保留锁，未实现基于 PID 的自动抢占或恢复；PID 死亡不证明容器已经停止。损坏/未知格式明确报错，不自动覆盖或复活已删除凭据。Codex managed ChatGPT codec 已提供；登录入口、备份恢复、持久 Profile 管理及真实账号联合验收继续在 #11/#12 完成。

## 执行凭据绑定

`FileExecutionCredentialBinding.acquire(store, {identity, credential, stateFile, environment})` 取得一份执行租约。identity 是本次 Run/NodeTask/Attempt，credential 是存储身份；stateFile 是宿主选定的相对位置（例如 codex/auth.json），environment 只能声明 /task/state 下的路径（例如 CODEX_HOME=/task/state/codex）。秘密和源目录不放入 Invocation 或 DockerOptions。

将 binding 作为 `new DockerBackend(options, binding)` 的第二个参数。后端只调用 PrivateStateBinding 的初始化和释放前检查，不读取秘密或判断 provider。绑定为一个资源创建私有目录/0600 文件，不能给两个执行复用。Profile 和 Harness 计划的兼容性仍须由后续组合层验证。

调用顺序为：取得绑定 → Runner.run → binding.finish(runnerResult) → 检查 Harness 与输出 → Runner.release。finish 仅接受来自宿主同一次执行的结果：确认停止且资源已清理才读取副本、用原 revision 条件回存、删除副本并释放租约。非零退出、取消和超时也可能已经刷新，不能跳过收尾。未到准备阶段的异常可调用 abandon；初始化开始后 abandon 拒绝。

finish 返回 status=released 或 retained，以及 refresh=not_prepared/unchanged/updated/failed/pending 和静态 diagnostics。retained 时不能启动相同 credentialRef 的下一任务，也不能 release 工作区；恢复须先证明真实清理完成，再重试 finish。refresh=failed 表示未接纳新内容，原凭据不被损坏副本覆盖，调用方不能把它当作无异常完成。绑定没有完成前，DockerBackend.release 会拒绝删除工作区。

普通序列化只提供凭据元数据和释放状态。首个 codec 和已知凭据值脱敏已接入组合层；真实模型小任务已通过，但未触发远端刷新；这部分目前由合成凭据及真实 Docker 进程验证，见 [执行绑定验证](../validation/2026-09-09-credential-binding.md)。

接口与真实证据边界见 [本次验证](../validation/2026-09-09-harness-auth-primitives.md)。取舍分别见 [Harness 决定](../../.agents/decisions/product/README.md#p-20260909-harness-adapter) 和 [认证决定](../../.agents/decisions/product/README.md#p-20260909-auth-lifecycle)。

## 首个 Codex 订阅组合 API

CodexSubscriptionCodec 仅接纳 auth_mode=chatgpt、完整 id/access/refresh token 和 account_id；不是远端认证检查。存储的 validateRefresh 可选方法约束运行刷新，Codex codec 拒绝账号变更，显式 configure 仍可替换。

CodexSubscriptionRunner 接收存储以及宿主 workspaceRoot/image/proxyImage。run 的 Profile 必须完整提供 id、service=openai、method=subscription、credentialRef、endpoint=official、capacity=1。组合先在离线 Runner 中验证同一不可变镜像内的实际 codex --version，再申请租约并接通实际执行。只授权 chatgpt.com 与 auth.openai.com 的 443 CONNECT；不接受任意 endpoint 或环境凭据。

返回 CodexExecution 句柄，result 是独立快照，分别保留版本、Runner、Harness、authentication 与 diagnostics。需要清理恢复时调用 retryCleanup，它先实际停止/删除资源再重试凭据收尾，不升级原业务结果；保存需要的产物/私有证据后 release。普通事件由绑定收集初始和刷新凭据的已知值后脱敏；刷新或脱敏失败不发布消息 payload。

受信宿主可在 FileExecutionCredentialBinding.acquire 的第四参数传入材料观察器，供脱敏器记住本次值；该回调不来自 Workflow 配置，也不进入普通序列化。

`src/examples/codex-subscription.mjs` 是明确选择已配置私有存储的合成数字验收示例。它要求 AGENTFLOW_ACCEPTANCE_ROOT、AGENTFLOW_CREDENTIAL_STORE、AGENTFLOW_CREDENTIAL_REF、AGENTFLOW_CODEX_IMAGE、AGENTFLOW_PROXY_IMAGE 和 AGENTFLOW_CODEX_MODEL，不自动寻找或导入登录材料。已用明确授权的专用凭据及 gpt-5.6-sol 完成真实小任务；当前已验证范围见 [组合验证](../validation/2026-09-09-codex-composition.md)。
