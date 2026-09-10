# Issue #13 实现验收对照

2026-09-10，Codex 作者自查；主负责开发者 @xiaoxuanli-a。依据 [Issue #13](https://github.com/TonQiaN/Agent_flow/issues/13) 的十项验收逐条核对当前实现及既有故障证据。以下是本地实现证据，不表示已获独立审阅、合并或关闭。

| 验收项 | 证据与当前结论 |
| --- | --- |
| 模块边界 | engine/workflow/recovery 经端口调用共同 Runner；Store 仅持久化，正常 Runtime 接纳/路由复用。普通 recovery 测试及工程边界检查支持。 |
| 基本恢复和身份 | [真实恢复](2026-09-10-workflow-resume.md)保留 A、中断 B 同一 NodeTask 新 Attempt；queued、after-A、连续中断、恢复交接中断有检查。 |
| 旧执行核对 | [资源恢复](2026-09-10-runner-resource-recovery.md)覆盖 running/exited/absent/临时目录删除/查询失败；[恢复认领](2026-09-10-workflow-recovery-claim.md)覆盖失败阻塞及重开。未知 pending 启动操作保守阻塞，符合不盲目重跑要求。 |
| 提交边界 | [检查点](2026-09-10-workflow-checkpoints.md)验证产物先于接纳、接纳与后继同 CAS、归档失败不推进；恢复交接与后继尚未创建的边界仍沿正常调度，不漏掉或重复转换。 |
| 文件保留与损坏 | [严格加载](2026-09-10-workflow-checkpoint-loading.md)核对实际内容/收据；[完整 Tutor](2026-09-10-persistent-tutor-grading.md)删除原来源和临时目录后仍恢复；损坏或缺失明确报错，不重做已接纳上游。 |
| 定义、环境与认证 | 当前安装结构/实际 Script/镜像/Profile 比较；[Agent 验证](2026-09-10-agent-workflow.md)、[订阅恢复](2026-09-10-subscription-resource-recovery.md)覆盖实际 Driver、只读加载、正常刷新不漂移及来源隔离。 |
| 重复与并发 | [恢复认领](2026-09-10-workflow-recovery-claim.md)真实两个恢复进程竞争同一 SQLite revision、失败者不清理；旧 Attempt 迟到和清理中接管由 CAS 拒绝。 |
| 终止意图 | 普通 checkpoint/recovery/resume 测试验证取消持久化、明确失败/取消不自动重跑及恢复立即取消；通用重试不在本项加入。 |
| Effect | [独立日志](2026-09-10-effect-journal.md)、[Workflow](2026-09-10-effect-workflow.md)、完整 Tutor 的实际本地目标覆盖已确认回执复用、未知结果阻塞、输入/操作漂移及当前授权。 |
| 文档与交付 | 决定、指南、验证、Roadmap 和 Changelog 已随实现维护。待依批准方案提交/审阅/合并 PR，之后才能关闭 Issue；本地实现验收不能代替交付完成。 |

本项首版实现和作者故障验证已具备，可供后续 #14 队列/Worker 消费。无需为本项引入通用 GC、普通宿主文件闭包恢复、旧环境自动安装或队列系统。订阅操作临界区的未知状态继续明确阻塞；机器重启/硬件断电未测按 Issue 要求保留说明。真实模型矩阵与真实学生批卷、报告/PDF 是整个交付目标的剩余验收。

以上引用保留各次实际版本、测试范围和失败记录，不把历史测试冒充本轮全部重跑。当前共同绑定变更的回归结果见订阅验证记录。
