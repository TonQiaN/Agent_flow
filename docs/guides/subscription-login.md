# 订阅登录协调接口

当前提供独立登录协调器、管理租约，以及 Codex 0.153.4 / Claude 2.1.226 的 Docker 原生登录驱动。宿主可通过私有交互能力或 CLI `auth login` 使用；Claude 已通过专用真实账号登录及后续模型调用；Codex 专用来源需要重新登录复验，见[本轮验收](../validation/2026-09-15-official-harness-acceptance.md)。

## 管理占用

`FileCredentialStore.acquireManagement(identity, waitMs)` 可在凭据尚未配置时取得同一 credentialRef 的跨进程锁。租约的 metadata 为 null 或非秘密元数据，`configure(content)` 校验格式、核对原 generation/revision 并原子保存；这是明确的管理替换，不使用运行刷新时的同账号限制。`release()` 幂等，释放后不能再配置。

占用期间其他登录、执行、配置和删除须等待或报 CREDENTIAL_BUSY。原 `store.configure` 复用此租约，调用方式不变。持有进程崩溃不证明登录执行已停止，当前不会自动回收锁；不能把 PID 不存在当成安全解锁依据。

## 登录执行端口

`SubscriptionLoginCoordinator(store).run({identity, credential}, driver, cancellation?)` 首先取得管理占用，再调用受信 driver；返回保留清理能力的 attempt。credential.method 必须为 subscription，具体服务由存储 codec 支持范围决定。

宿主驱动提供四个方法：

| 方法 | 责任 |
| --- | --- |
| run(identity, cancellation) | 运行所选 Harness 登录，返回同一身份与资源的 RunnerResult；负责实际命令、版本、交互、网络和执行证据 |
| readCredential(result) | 停止和资源移除确认后读取该次登录的私有材料；返回值只交给认证模块 |
| recover(previous) | 只核对和清理原执行，返回可信结果；不能重新登录或凭外部 JSON 伪造已停止 |
| release(result) | 删除本次私有临时材料与工作区；不删除长期存储 |

这个端口是宿主执行能力，不是可从 Workflow JSON 加载的插件配置。协调器不解析 provider 登录 URL、不启动浏览器，也不向普通事件输出原始材料。引擎与通用 Runner 不增加各家的登录分支。

## 成功、失败与收尾

只有原执行正常退出且停止确认，才具备保存条件；资源移除确认后读取材料，经 codec 和管理租约检查再保存。读取后、保存开始前再次检查取消。成功保存仍须完成私有材料清理，最后释放管理占用。

`attempt.result` 只提供执行身份、status、非秘密 credential 元数据和静态 diagnostics。status=configured 表示本地保存及清理完成，远端状态仍为 unknown；failed 表示未确认本次配置；pending_cleanup 表示占用和清理责任仍保留。存储提交发生 IO 错误时，不能从 failed 推断磁盘一定未变化，应检查本地状态。

`attempt.retryCleanup()` 重试原执行清理；错误执行、错误资源或停止未知不能释放占用。它不会重新登录，不会把原失败升级成成功；已经保存过的材料不会重复保存。私有工作区已删除而管理锁释放失败时，重试只处理管理锁，不再次查询已删除工作区。原执行成功但资源移除失败时，可在确认清理后完成一次保存。驱动抛出异常也返回保留责任的句柄，不能因异常直接释放管理锁。

当前尚无进程重启后的持久句柄恢复，后续与 #13 对账。原生驱动已实现版本检查、受控网络、交互、私有文件权限与原始记录完整性检查，合成 Docker 验证不能代替官方登录验收。见 [验证记录](../validation/2026-09-09-subscription-login-coordination.md)。

## 原生 Docker 登录驱动

`CodexSubscriptionLoginDriver(options, interaction)` 和 `ClaudeSubscriptionLoginDriver(options, interaction)` 使用相同的 `SubscriptionLoginCoordinator`。options 明确选择 workspaceRoot、image、proxyImage、timeoutMs（1 毫秒至 30 分钟）；不读取默认桌面凭据。驱动是一次性能力，不能并发或重新运行。

驱动先将镜像解析为不可变 ID，在断网容器核对 CLI 版本并清理探针。版本正确后，同一镜像运行登录，私有状态目录初始为空。Codex 命令为 `codex login -c cli_auth_credentials_store="file" --device-auth`；Claude 为 `claude auth login --claudeai`，另固定关闭自动更新和非必要流量。两个驱动均不启动宿主浏览器。

登录容器通过 CONNECT 代理访问 HTTPS 443：Codex 为 auth.openai.com、chatgpt.com；Claude 为 claude.ai、claude.com、platform.claude.com、api.anthropic.com。登录地址集合与任务执行地址集合分开维护；允许集合是本地限制，不等于对实际账号访问的授权或完整官方流程已验证。

interaction 是受信宿主对象，独立于 Docker JSON 配置和 Workflow：

- `open({write, end})` 取得标准输入能力并返回同步 disposer。每次 write 最多 8 KiB，总输入最多 64 KiB；end 结束输入。宿主负责从私有交互界面获取授权码并及时取消，不把代码写进任务 JSON。
- `output(channel, bytes)` 同步接收原始 stdout/stderr 字节，供私有终端显示。它可能包含登录 URL、设备码或授权码，不能转发到普通日志、遥测或公开任务结果。
- disposer 在附加进程关闭时执行一次，移除宿主输入监听。输入、输出或 disposer 错误使执行失败，由 Runner 核对并清理容器；关闭客户端本身不证明容器停止。

默认 Docker 任务仍关闭标准输入。登录不分配 TTY；原生参数支持通过离线帮助核对，Claude 专用账号已通过本轮产品终端的官方交互登录；具体证据与剩余组合见本轮验收。宿主终端入口见下节；库调用方不能把原生输出当作可信自动化指令。

停止及资源移除确认后，驱动核对原始输出采集完整性、私有目录 0700、文件 0600、当前用户所有、单一硬链接、非符号链接、大小至多 1 MiB 和有效 UTF-8，再交管理协调器校验及保存。Claude 清空 token 的刷新失效标记不能建立新登录。容器移除失败保留管理占用；重试清理只处理原资源，成功后至多保存一次。错误版本、取消或原失败不会因清理成功变成登录成功。

具体合成覆盖与局限见 [原生登录驱动验证](../validation/2026-09-09-native-subscription-login.md)。

## 终端登录与本地管理

先构建仓库，在自己的终端明确选择服务、存储、引用、临时工作区及两个镜像。镜像须已在本机准备并经宿主信任；入口不自动下载镜像，也不搜索桌面登录状态。以下命令仅说明调用形式：

```sh
node src/apps/cli/dist/index.js auth login codex \
  --store /absolute/private/credentials --credential-ref teaching \
  --workspace /absolute/private/login-workspaces \
  --image selected-codex-image --proxy-image selected-node-proxy-image
```

Claude 将 codex 改为 claude，并明确选择对应 Claude 镜像。代理镜像须能运行项目 CONNECT 服务，已验证环境使用 Node 22。`--timeout-ms` 可选，默认 600000（10 分钟），上限 1800000；终端取消时限包含版本探针与登录准备，实际退出仍须等待资源停止/清理。

stdin 和 stderr 均须为终端。启动提示前关闭回显；原生命令显示登录 URL/设备码后，用户在浏览器完成流程。如需输入授权码，粘贴后 Enter 提交；Backspace 删除、Ctrl-U 清空、Ctrl-C/Ctrl-D/Ctrl-Z 取消。每行最多 8191 个非空白 ASCII 字符，总交互至多 64 KiB；多行粘贴和非法控制字符拒绝。入口不接收 `--code`、`--file`、`--json` 或环境变量中的授权码。不要重定向私有 stderr；原始登录输出仅供终端显示，控制字节已移除，不解释为自动化命令。

SIGINT、SIGTERM、SIGHUP、终端断开或超时会请求 Runner 取消；停止、清理及协调完成后恢复原终端模式。强杀进程不能保证恢复终端、停止容器或释放租约。正常结果只在 stdout 输出 SubscriptionLoginResult，显示 configured/failed/pending_cleanup、身份、非秘密元数据和静态诊断，不含授权码。

退出码为：本地配置并清理成功 0、参数不支持 2、失败/取消/超时 1、清理仍不确定 3。遇到 pending_cleanup 会作一次原执行清理重试；仍失败时保留锁和私有工作区，不重新登录、不自动删锁。当前没有跨进程登录句柄恢复；应保留证据并核对原资源，不能因为 CLI 已退出就断言容器已停止。

检查和本地删除不需要终端，不联网：

```sh
node src/apps/cli/dist/index.js auth inspect codex \
  --store /absolute/private/credentials --credential-ref teaching
node src/apps/cli/dist/index.js auth delete codex \
  --store /absolute/private/credentials --credential-ref teaching
```

也支持 claude；相同引用按所选服务核对。删除仍遵守管理占用，不宣称远端撤销；已保存仍为 remoteStatus=unknown。Claude 官方交互登录及人工提前缓存到期后的真实续期已通过；Codex 新登录复验仍待完成。见 [终端登录验证](../validation/2026-09-09-subscription-login-cli.md)。

[有限备份恢复](credential-recovery.md)已接入存储和独立管理命令；它不改变登录清理占用，也不代替真实账号验收。
