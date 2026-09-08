# Harness 与凭据接口（首个组合实施中）

当前可独立使用 Harness 注册、Codex 调用计划/结束后 parser，以及 POSIX 本机私有凭据存储和独占租约。尚无可启动真实 Agent 的公共命令：计划不是 RunnerRequest，现有 DockerBackend 仍拒绝 CODEX_HOME 等未接通的环境配置。不能把以下接口当作已完成的认证 Runner。

## Harness

`HarnessRegistry.register(adapter)` 显式注册，重复 ID 或未知 Harness 报错。`CodexAdapter.plan(task)` 接收 Run/NodeTask/Attempt 身份、原样 prompt 和配置。当前配置必须明确 `model`、`subagents: false`、`search: false`；可选 `reasoning` 为 low/medium/high/xhigh。模型名称仅检查合法字符串，远端模型/账号可用性仍须实际调用验证。未知字段、预算、任意 argv/env、启用搜索/子 Agent 或不支持档位启动前拒绝。

计划针对 Codex 0.153.4，声明 cwd=/task/work、CODEX_HOME=/task/state/codex、私有认证文件和受控网络/内部沙箱需求。身份目录统一由 engine 的 TASK_PATHS 定义；configFiles 可经 Invocation.configFiles 注入只读 /task/config。用户 prompt 使用 argv 的 `--` 分隔符原样传入；调用计划可能含业务文本，应按该数据的访问范围保管。

Docker 环境支持宿主选择 `sandbox: 'nested-userns-v1'`，内置固定 Moby 基线派生策略以运行 Codex 的 bwrap；普通脚本默认 standard。已在 macOS Docker Desktop 使用真实 Codex 0.153.4 和合成凭据验证任务路径可写、auth.json/profile.json 拒绝读取的权限映射。CODEX_HOME 其余临时程序仍可执行，不能禁止整个目录，否则会阻止 Codex 自己的沙箱启动。此结果不证明任意 Linux/AppArmor 环境兼容，也不证明真实认证或模型任务已完成。受控网络另经独立真实 Docker 测试，见 [联网指南](controlled-egress.md)；尚未与真实 Codex 认证联合执行。

`interpret({task, runner, version, stdout, redact})` 只解释已采集的字节和执行事实，不读取日志文件。宿主负责保证这些证据来自同一次执行，并提供普通事件的秘密脱敏接口。版本、身份、字节数、完整性、Runner 正常退出与 Codex 正常终态均需匹配；不从“Done”、非空目录或退出 0 单独推断完成。重复相同终态只计算一次，冲突终态失败；usage 只使用终态的明确字段，未提供为 null，不补成零。

事件保留关联身份、顺序、来源类型、item ID 和有限已脱敏字段。未知事件只记录来源，不复制未知 payload；原始记录保持私有，当前没有实时事件推送或完整工具轨迹承诺。单出口正常结束的 outcome 为 null，等待引擎验收 outputs 后赋值。多出口由 outcomes 列表生成只读 schema，解析最后 Agent 消息中唯一的 outcome 字段；不要求 artifacts 清单。实际文件 contract 与 Workflow 接纳尚未接通。

## 凭据存储

`FileCredentialStore(root, codecs)` 接收当前用户拥有的绝对目录与显式服务/认证方式 codec。root 必须为 0700，文件为 0600、当前 UID、单链接普通文件。存储根外的祖先目录须由宿主控制；当前支持非 root POSIX 进程，未宣称 Windows 或跨机器协调。

- `configure(identity, {content})` 或 `configure(identity, {file})`：仅一个受控来源，不读环境变量；codec 只验证本地格式。新记录 revision=1，变更时递增，同内容不递增。
- `inspect(identity)`：返回身份、generation、revision、remoteStatus=unknown 或 null；不验证远端订阅、token 或额度。
- `acquire(identity, waitMs)`：按 credentialRef 跨进程独占，默认立即报 busy，最多等待 60 秒。返回的 lease 普通序列化只含元数据。`readSecret()` 仅供受信执行绑定使用。
- `lease.commitSecret(content, expectedRevision)`：在同一租约内验证旧 revision 与存储 generation/revision，校验新格式后原子替换。调用者须携带生成工作副本时的 revision；旧副本不能冒充最新读取。
- `lease.release()`：幂等释放。释放后读写失败。运行绑定未来必须先证明旧执行已停止；不能在停止未知时释放给另一任务。
- `delete(identity)`：与运行共用同一个锁，只删除本地已识别记录；明确返回 remoteRevoked=false。重新配置产生新 generation。

不同 Profile 若引用同一 credentialRef，应使用同一占用身份；当前没有 Profile 管理器、远端账号别名识别或大于 1 的订阅并发。内部异常在返回租约之前释放锁；得到租约后由调用者负责生命周期。进程崩溃保留锁，未实现基于 PID 的自动抢占或恢复；PID 死亡不证明容器已经停止。损坏/未知格式明确报错，不自动覆盖或复活已删除凭据。真实 provider codec、登录入口、备份恢复、Profile endpoint 管理和 Runner 秘密绑定继续在 #11/#12 完成。

接口与真实证据边界见 [本次验证](../validation/2026-09-09-harness-auth-primitives.md)。取舍分别见 [Harness 决定](../../.agents/decisions/product/README.md#p-20260909-harness-adapter) 和 [认证决定](../../.agents/decisions/product/README.md#p-20260909-auth-lifecycle)。
