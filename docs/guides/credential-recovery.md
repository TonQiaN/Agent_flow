# 私有凭据备份与恢复

当前支持宿主存储记录的有限尾部截断恢复。它不修复任意损坏，不登录或联网，也不判断备份中的 token 是否仍然有效。每个新配置或成功回存的记录有一份私有备份；普通 Workflow、Agent、Adapter 不访问备份。

## 恢复入口

库调用 `FileCredentialStore.recover(identity, waitMs?)`。CLI 可明确选择 codex、claude 或 deepseek：

```sh
node src/apps/cli/dist/index.js auth recover codex \
  --store /absolute/private/credentials --credential-ref teaching
```

此操作不需要交互终端，不接受秘密来源或任意备份路径。它取得同一 credentialRef 的跨进程管理占用，默认立即报 CREDENTIAL_BUSY，库调用最多等待 60 秒。已经存在的执行/登录锁不会因恢复而被回收；PID 不存在不证明资源停止。

| 状态 | 含义 |
| --- | --- |
| healthy | live 合法，未修改 live 或备份 |
| restored | 用同一已提交记录恢复了尾部截断，generation/revision 不变 |
| not_configured | live 缺失，拒绝从残留备份恢复 |
| unavailable | 格式、完整身份、版本或备份不满足恢复条件，原文件未修改 |

结果只含状态、非秘密元数据和静态诊断。CLI 的 unavailable 返回 1，其余上述状态返回 0；权限/身份/占用/IO 错误返回 1，无效参数返回 2。restored 不是新登录，remoteStatus 仍为 unknown；无法保证损坏前最后一次远端 token 仍可用。

## 支持条件

恢复只接受规范存储记录的严格前缀，且保留完整 schema、credentialRef、service、method、generation、revision 和 payload 字段边界。完整备份须通过同一 codec、本地身份、UTF-8 和大小检查；live/backup 均须为当前用户的 0600、单一硬链接普通文件，存储目录须为 0700。恢复前重新核对 live 未变，再原子替换，现有匹配备份在恢复失败时保留。

以下情况均不尝试修复：缺失 live、截断在身份/版本之前、可解析但未知 schema 或内容、未知编码或非规范 BOM 前缀、非尾部字节损坏、不同 generation/revision、损坏或不存在的备份、链接和过宽权限。健康的新文件即使对应旧备份也不会被回滚。Claude 的清空失效标记仍是失效记录，不能通过恢复取得更早的有效 token。

这项能力针对宿主存储封装，不是 Harness 临时工作副本。工作副本损坏继续由执行绑定拒绝回存，保留宿主健康源；不把 Agent 产生的任意 JSON 当作可修复凭据。

## 写入、删除与崩溃

live 为 `<credentialRef>.json`；备份使用 `.backup-<credentialRef>.json`，其隐藏前缀不能与合法引用冲突。备份也包含秘密，不能公开、挂载给 Agent 或当作普通日志归档。

配置或刷新在持锁时先移除旧备份并同步目录，再原子写 live，最后原子写新备份。删除先持久移除备份，再删除 live 并同步目录。中途崩溃可能留下健康 live 但没有备份；恢复会保留健康文件，不使用旧备份冒充本次更新。缺失 live 永不恢复，因此残留副本不能复活已删除登录。

已有无备份记录可再次用相同内容 configure，或通过成功的同内容刷新回存建立备份，不增加 revision。必要时在持锁期间规范化有效封装的字段顺序，确保 live 与备份具有一致的可识别前缀。inspect 和 recover(healthy) 不暗中写备份。

IO 错误可能发生在 live 已提交而备份尚未保存之后，因此失败不一定表示磁盘未变化。检查本地状态后再决定后续；不自动清锁或反复登录。强杀可能留下私有临时文件及占用，跨进程执行恢复仍属于 #13。宿主须控制存储祖先目录并遵守相同锁；不支持外部绕锁同时写入，也未模拟断电或损坏存储硬件。

实际验证见 [备份恢复记录](../validation/2026-09-09-credential-recovery.md)。
