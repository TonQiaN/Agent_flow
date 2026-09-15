# 本机运行历史与可见日志

`SqliteRunRecordStore` 在保存最新状态的同一事务中追加历史修订。`list({after,limit})` 按记录 ID 分页；`history(runId,afterSequence,limit)`、`events(runId,afterSequence,limit)` 按稳定序号分页，每页 1–1000 条。存储中也包含队列内部记录，应用须通过 `projectRun` 筛选和投影，不能直接返回全部存储内容。

已识别 v1 库首次打开会迁移到 v2：保留原有最新修订，旧时间为 `null`，不推算缺失的过去。新修订时间是宿主提交时间；日志还保存宿主接收时间。序号负责同毫秒下排序。原有 CAS、完整性校验和私有目录权限继续生效；未知 schema 拒绝。升级前可在停止所有写入者后备份私有存储目录；v2 库不能交给旧版程序写入。

已有持久 Workflow 的检查点天然形成历史。普通入口可先 `createWorkflowRecorder(records, compiled, metadata)`，再把返回的观察器作为 `new WorkflowRuntime(undefined, observer)` 的第二个参数。观察器使用编译计划的真实结构、执行描述和值归档端口。文件节点须提供实际归档；普通闭包没有执行版本时会标记描述缺失。这条观察路径用于查看，不开放执行恢复。

`projectRun` 是纯只读投影；它不依赖当前安装的工作流、不调用恢复加载器、Docker 或文件物化。读取旧历史时配置仍来自那次保存的数据。应用不得从历史页面调用恢复或重新执行。

Codex/Claude/DeepSeek Runner 可传入受信 `events` 回调，保存每次尝试的可见 stdout/stderr、协议结果和具名会话记录。日志先按完整行汇合和凭据脱敏，再递交回调；嵌套工具参数与结果按实际输出保存。每条有执行身份和宿主接收时间。累计 16 MiB 或单行 1 MiB 上限会产生明确警告，采集失败不能冒充完整记录；它也不能改变协议原有的成功判断。

Codex 的可选 `persistSession: true` 保存本次隔离会话并归档 `sessions` 下的 JSONL，关闭长期记忆生成与使用。认证与 profile 文件不归档。此开关不恢复旧会话，也不承诺取得隐藏完整 CoT。未提供的摘要/压缩/记忆在消费端标明。默认未开启时保持原有临时会话行为。

决策依据：[运行保存](../../.agents/decisions/product/README.md#p-20260909-run-persistence)、[Harness](../../.agents/decisions/product/README.md#p-20260909-harness-adapter)。前端、接入清单与招聘工作流由 #39 的后续 stack 层提供。
