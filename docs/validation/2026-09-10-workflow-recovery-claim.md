# Workflow 恢复认领验证

2026-09-10（悉尼），主负责开发者 @xiaoxuanli-a，Codex 实现与作者自查，关联 [Issue #13](https://github.com/TonQiaN/Agent_flow/issues/13)。本轮接通恢复 CAS 与旧资源共同清理，尚未执行新 Attempt。

## 对照与实现

先查看 Blackbox v0.1.22 / 5610d1b runtime.py 的 resume、_write_record/_assert_claim 与 _reset_interrupted_units，以及 run_leases.py。复用“先核对、取得写入权、再操作”的顺序；保留本项目的取消意图和完整旧 Attempt，不复制旧版本升级、清除取消或原地重置 pending 的行为。测试暂停问题另回查其 write-review 夹具与按节点注入失败的实现。

引擎新增 claimWorkflowRecovery，封套格式由独立 recovery-record 模块负责；原 loadWorkflowCheckpoint 共用解析和完整校验，仅返回恢复进度副本，不产生认领。认领、清理前校验和清理确认均使用同一 RunRecordStore CAS。FileWorkflowCatalog → ScriptExecutor → Runner.restore 为实际节点提供旧资源恢复端口；编译时捕获绑定，数据库不调用 Docker。原 v3 业务快照保留，恢复封套记录 claim revision 和资源移除确认；没有另一个业务路由引擎。

恢复者可以被后续 claim 替换，旧句柄的下一次 CAS 明确失败。清理仅使用原不可复用资源身份；没有自动启动入口。pending 操作、取消/失败/终态与缺失能力拒绝认领。查询、停止和释放不明保留恢复记录，错误使用公开代码；释放成功但确认 CAS 失败也不能对外报告持久完成。

## 验证

最终代码通过全部 274 项普通测试（约 13.3 秒）和 30 项相关真实 Docker/SQLite 测试（约 58.7 秒），均无失败、取消或跳过。包含新增 11 项恢复单元测试、8 项真实恢复场景以及此前 22 项检查点回归。构建、测试类型检查、包依赖边界、462 个文档本地链接和 git diff --check 通过。

新增引擎验证涵盖：取得 CAS 后才清理，原业务历史不变、活宿主迟到结果拒绝；同 revision 双恢复者只有一个赢家；后续认领保存已完成清理并使旧句柄失效；pending/取消/缺失能力和终态拒绝；query/stop 不明可重试且同句柄并发合并；返回资源身份不符不能查询或停止；清理途中被接管后迟到确认失败；dispose 等待当前清理提交；损坏封套拒绝；只读加载不改 revision 或接触容器；目录释放失败不提交完成，重试不泄露 backend 异常文本。

新增 8 项真实 Docker/SQLite 场景：

1. 分配资源后及 B 已实际运行后，旧宿主保持存活并暂停。新进程认领、清理自有旧资源，旧宿主随后继续时不能创建新容器或覆盖数据库；A 的已接纳值仍为 seedA，原输入仍为 seed。
2. 两个新进程通过 IPC 保证读取同一实际 SQLite revision，再同时认领，恰一个成功；失败者没有资源恢复/清理调用。
3. 恢复者在认领后、移除完成写库前、移除完成写库后三处被 SIGKILL。下一进程重新认领并共同清理，或保留已提交的完成确认；没有执行 A/B 新调用。
4. create_pending 时恢复拒绝，不改变原数据库或旧宿主；解除测试暂停后原流程仍能正常完成。
5. 认领后仅在测试子进程把 Docker 地址改为不存在的测试 socket，确认旧容器仍运行、恢复记录未完成；新进程使用正常 Docker 后可完成共同清理。

首次新增 Docker 运行 7 通过、1 因 30 秒期限取消：暂停夹具误把 A 和 B 的 create_pending 都拦住，原流程放行 A 后又停在 B。回查参考夹具后限制到目标 A，并给本测试的 IPC/退出等待加自有子进程结束期限，避免超时留下挂起子进程。测试收尾仅结束已核对 PID 的本轮暂停子进程；没有更改产品恢复拒绝规则或放宽断言。此后新增测试及原检查点回归一起通过，最终结果见上述汇总。

本轮使用本机 Node 26、真实 Docker、真实 SQLite、合成文件和受控故障，不涉及真实凭据、官方模型或学生材料。本轮没有重复无关的原生 Harness/认证/公网回归；上一轮完整 378 项通过是其当时代码的结果，不冒充本轮全量回归。没有远端 Node 24 CI、独立审阅或发布。

## 尚未完成

同一 NodeTask 的新 Attempt、旧中断 Attempt 历史收尾和恢复后共享路由仍待实施。只读加载与共同清理不能证明 A/B 已恢复完成。pending 操作继续保守拒绝，不由 PID、时间或一次 absent 查询解锁；认证、Effect、队列、重试、并行及真实学生批卷/报告/PDF 均保留后续验收。

[使用指南](../guides/workflow-recovery.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
