# Run 状态存储首个切片验证

2026-09-09；主负责开发者 @xiaoxuanli-a，Codex 实现与作者自查。依据 [Issue #13](https://github.com/TonQiaN/Agent_flow/issues/13) 已确认的保存/恢复分离与最小接口依赖；按照用户授权落实常规存储细节，未新增独立审阅或远端发布。

## 预检与对照

先检查 Blackbox v0.1.22 / 5610d1b 的 storage.py、run_leases.py、execution_plans.py、artifacts.py 及 runtime.py 的创建/恢复入口：SQLite 使用 WAL、FULL、有限忙等待和显式事务；恢复与存储分开，已有定义和输入快照。但旧实现允许某些 cancelled 恢复和整 Run 锁，不能覆盖本项目取消意图及 NodeTask 身份约束。未重新运行旧 Python 测试。

当前接口具备 WorkflowSnapshot、进程内执行、ArtifactStore 和 Runner 身份，但没有引擎重启后的共同资源接管接口，也没有耐久的 Workflow checkpoint。首个切片采用独立 RunRecordStore，不改 WorkflowRuntime 的运行语义。新 [持久化决定](../../.agents/agent_notes/product/README.md#p-20260909-run-persistence)覆盖本项，保持 proposed，后续恢复仍未全部落实。

## 已验证

- Run JSON 内容及返回值独立，重开连接后可读；重复创建、缺失 Run、旧 revision 更新分别拒绝。
- 非 JSON/getter/超量内容和非法身份/版本拒绝，未写入记录。
- 两个真实独立进程同时提交同一 revision，仅一方成功，另一方收到明确冲突；已提交内容不被旧写入覆盖。
- 两个真实 SIGKILL 注入点：在 UPDATE 后、COMMIT 前终止写进程，重开仍为旧完整 revision；COMMIT 后终止，重开为新完整 revision。两种情况均能继续 CAS，不靠清理 PID 锁恢复数据库。
- 损坏 payload 与摘要不匹配拒绝读/覆盖；未知 schema 拒绝打开，保留原版本和数据，不静默重建。
- 私有目录和数据库权限、目录/数据库符号链接、数据库硬链接及不安全旁文件拒绝。

上述进程注入通过测试子进程覆盖 SQLite 提交点，产品代码没有崩溃开关。只终止自己创建的合成状态写进程；没有 Agent、Docker 或真实凭据执行，不能由这些检查推断旧容器状态。

定向 7 项通过，包含实际多进程与 SIGKILL。最终完整检查 288 项通过、0 失败、0 跳过，112.5 秒；启用 Docker、受控网络和三种固定原生 CLI 镜像。当前本地运行 Node 26；Node 24 属于现有 CI 矩阵，本地未额外执行 Node 24 或宣称远端 CI 已通过。

## 尚未验收

这是存储实现，不能宣称 #13 的 A 保留/B 恢复场景已通过。引擎快照定义及历史、耐久输入/产物、接纳/后继创建一致性、Runner 重启 query/stop、恢复互斥与迟到结果 fencing、定义变化阻塞、失败/取消和 Effect unknown 均需后续实现及联合故障注入。没有进行整机重启、硬件断电或历史环境重建。

下一步先落实引擎 checkpoint 与耐久产物引用/校验，再接正常路由与 Runner 恢复；不要将普通 JSON 内容当成满足这些语义的记录，也不要以单行 CAS 代替执行占用。真实矩阵和既有偶发 DeepSeek 超时风险继续保留，后续回归再现时优先看已保留诊断。


## 完整回归中发现的测试问题

第一轮完整回归为 288 项中的 285 项通过、3 项失败；新增存储检查通过，失败来自既有 Claude 合成执行、DeepSeek 原生工具及 Docker 超时场景。先回查 Blackbox 的 Docker 测试及超时处理，再核对本项目 Runner 的截止时间位置。

Docker 测试把 1.5 秒总期限误当成任务必定已启动的保证，并在取消场景使用固定 1.2 秒计时。已移除不成立的启动保证，保留真实超时/停止/移除断言；取消场景改为看到两个任务各自的启动标记才取消，仍验证目标停止且另一个任务完成。失败清理也等待这两个已启动的测试 Promise 收尾。

三个受影响文件逐文件检查 18 项通过；第二轮完整回归 287 项通过、DeepSeek 工具一项失败。新保留的 Runner 记录显示外层 exited/0、已停止/移除，而内层原生 CLI 返回 1、只有部分工具步骤，整个场景约 63.5 秒。合成 HTTP 辅助程序另有 60 秒 SIGTERM 计时器，早于外层 Runner 90 秒期限。已去掉这一未属于场景契约的提前终止，以 Runner 的同一总期限为准；显式 failModel/cancelModel/cancelCapture 场景仍保留。旧日志没有单独记录 timer-fired，不能把全部偶发失败一概归为这一原因。Claude 首轮失败未保留足够原始材料，之后未复现；现已在释放前复制首轮原始 stdout/stderr 并保留失败目录。

本机 Node 可用并行度为 10，旧检查程序使用默认文件并发；每个文件还会启动多个容器/代理。现在按工作指南限制为最多四个测试文件，单项的期限、断言与文件内部并发用例不变。减少调度争用不是任何产品错误已经修复的证明。删除辅助期限后的 DeepSeek 定向 9 项通过，最终完整 288 项通过、0 失败、0 跳过（112.5 秒）。这些结果不抹掉此前失败；既有未知超时风险继续保留。
