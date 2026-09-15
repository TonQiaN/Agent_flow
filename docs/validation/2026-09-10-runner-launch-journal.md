# Runner 启动操作记录验证

2026-09-10（悉尼），主负责开发者 @xiaoxuanli-a，Codex 实现与作者自查，关联 [Issue #13](https://github.com/TonQiaN/Agent_flow/issues/13)。本轮补充正常执行的操作前后记录，尚未开放自动恢复。

## 对照与实现

先查看 Blackbox v0.1.22 / 5610d1b 的 run_leases.py、runtime.py 调用点及 bdbd585：旧实现用 POSIX flock 排除同一 Run 的并发宿主，锁在描述符关闭时释放。它不能单独证明远端 Docker 命令结束，本项目继续保留 CAS、资源核对与恢复协调各自的职责。

RunnerResourceSink 增加可选 launch 端口，现有只保存资源的独立调用保持兼容。正常持久 Workflow 每次调用都提供该端口，经过原 FileWorkflowCatalog/ScriptExecutor 调用链进入共同 Runner；不新增数据库或 Docker 调度器。资源保存后状态为 allocated，依次记录 prepare_pending/completed、create_pending/completed、start_pending/completed。每个前置 CAS 返回后才调用实际 backend；准备与创建正常返回后才记录 completed。启动需要共同 observe 首次确认 running 或 exited，异步 start 返回和 created 状态均不构成启动完成。

操作抛错、完成记录失败或操作前等待提交时被取消，均不会补造完成事实。写入失败阻止后续准备/创建/启动，原停止、证据收集和清理仍执行。调用端口拒绝跳步、重复、重叠、跨调用及迟到操作；写入失败永久关闭该端口，不能追写越过 CAS 错误。

Workflow 检查点为 v3，Attempt 新增 launch；没有资源时必须为 null，有资源时必须为已知状态。严格加载不自动升级旧 v1/v2 试验记录；Runner 资源身份记录本身仍为 v1。该字段表示最后提交的操作进度，不能单独充当恢复所有权或旧宿主停止证明。没有复制输出或另建 Attempt 调度历史。

## 验证

56 项针对性 Runner/Workflow/检查点/加载检查通过（约 0.5 秒）。新增覆盖操作与写入的精确顺序、六个写入边界拒绝后实际调用集合、三个 backend 操作抛错、提交等待期间取消、start 返回后连续观察 created、端口严格转换与全部保存版本加载、重叠调用及失败后关闭。未知/缺失 launch、资源关系不一致、旧 v2 拒绝。

32 项真实 Docker/SQLite 检查全部通过（约 52 秒），包含原 Runner 资源恢复 10 项、原 Workflow 检查点 9 项和新增 13 项。六个 pending/completed 边界提交后暂停并 SIGKILL，再由新进程严格加载；另在 create/start 覆盖方法内部完成真实操作后暂停，保留 pending，证明 pending 对应 absent/created/running 均有可能。四个创建/启动前后 CAS 注入失败，实际调用计数和数据库最后状态一致，后继不执行、资源按原 Runner 清理。一个独立 SQLite 客户端抢先更新 revision，旧宿主真实 CAS 冲突后不调用 create，不是仅模拟抛错。所有实际 create/start 入口都读取同一 Workflow 数据库核对前置状态。测试清理只操作捕获的自有容器，已知暂停点不构成产品自动接管权限。

首次 Docker 验证 23/31 通过、8 项失败。六项来自新测试没有删除旧临时目录，却沿用了“加载器释放后目录为空”的夹具断言；按已有新进程恢复夹具的边界，删除旧 temporary/work 后再独立加载。另两项暴露异步 start 已返回但容器仍为 created：先回查 Blackbox runners.py 的同步执行和清理方式，再检查当前 DockerBackend.start/observe，修正产品 completed 的观测条件。inside-start 夹具在覆盖方法内部确认真实 running 后暂停，使其明确模拟“实际已启动、方法尚未完成”。没有放宽产品停止证明或跳过断言。

最终代码完成构建、测试类型检查、模块边界检查及全部 378 项测试：普通测试 263/263、Docker/E2E 115/115（约 626 秒），无失败、取消或跳过。既有公网代理 TLS 测试本轮通过；上一轮偶发 CONNECT_TIMEOUT 的根因仍未确定，不能宣称本轮修复了该网络问题。450 个文档本地链接与 git diff --check 通过。

使用本机 Node 26、真实本地 Docker、既有合成协议测试及 example.com 公网 TLS 探测；没有真实凭据、官方模型或学生材料，不是远端 Node 24 CI 或独立审阅。

## 尚未完成

恢复 CAS 所有权、两个恢复者竞争、旧宿主隔离和新 Attempt 调度仍待接入。即便最后记录为 completed，恢复者仍须先取得所有权，再经共同 Runner 核对与清理旧资源；pending 不能由 PID 消失、超时或单次 absent 查询自动清除。准备/创建/启动的未知操作需要明确核对策略，不能把本轮故障夹具的已知暂停点当作通用恢复证明。

[检查点指南](../guides/workflow-checkpoints.md) · [Runner 资源恢复](../guides/runner-resource-recovery.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
