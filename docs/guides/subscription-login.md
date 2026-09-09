# 订阅登录协调接口

当前提供独立的登录协调器和管理租约，用于组合宿主登录执行驱动。尚未提供 Codex/Claude 原生登录驱动或 CLI `auth login`；本接口的合成验证不等于真实账号登录已通过。

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

当前尚无进程重启后的持久句柄恢复，后续与 #13 对账。真实驱动还须兑现版本检查、受控网络、交互、私有文件权限与原始记录完整性；相关验收保持开放。见 [验证记录](../validation/2026-09-09-subscription-login-coordination.md)。
