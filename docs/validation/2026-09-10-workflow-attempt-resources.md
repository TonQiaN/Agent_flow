# Workflow Attempt 资源检查点验证

2026-09-10（悉尼），主负责开发者 @xiaoxuanli-a，Codex 实现与作者自查，关联 [Issue #13](https://github.com/TonQiaN/Agent_flow/issues/13)。本次把已有 Runner 资源保存端口接入正常 Workflow；恢复所有权及新 Attempt 执行尚未完成。

## 对照与实现

先查看 Blackbox v0.1.22 / 5610d1b runtime.py 的 active_step 创建/保存、runtime_identity 记录、结果接纳和后继位置一起提交，以及失败记录处理。沿用调用前保存实际身份与活动事实的顺序，保留本项目每个 NodeTask/Attempt 的独立边界，不复制旧 pending 重置。

Workflow 每次调用生成独立 RunnerResourceSink，经 FileWorkflowCatalog 和 ScriptExecutor 传给原 Runner.run。资源回调保存实际 backend 描述和分配身份，CAS 完成后 Runner 才进入 prepare/create/start；调用结束立即关闭回调，跨身份、不同环境、重复资源及迟到保存拒绝。没有全局可变回调，存储仍不调用 Docker。

检查点升级为 agentflow-workflow-checkpoint/v2，新增 attempts：记录节点、完整身份、单个 Runner 资源或 null、对应结果步骤索引或 null。Attempt 开始就登记；明确失败或接纳时，步骤索引与原结果同步更新，业务输出不再复制一份。普通 JSON 函数没有 Runner 资源时仍登记 Attempt。加载器严格核对身份、步骤关联、当前活动位置、资源唯一性及实际资源环境；具体容器归属与停止证明仍交给 Runner。旧未发布试验格式 v1 明确拒绝，不自动升级补造资源证据。

## 针对性验证

37 项检查点/加载/串行 Workflow 检查通过（约 0.4 秒），其中 6 项为新增资源集成验证：实际每个 Attempt 的资源先提交；资源 CAS 拒绝不继续当前调用或后继；跨身份、环境变化、重复和迟到保存拒绝；8 类 Attempt/资源/旧格式变更拒绝；两个 Run 并发调用的端口和历史互不混用；资源 CAS 等待期间取消仍保留完整 Attempt 与失败步骤关联，且不进入后继。此前正常、取消、停止不明、路由/步数上限和归档完成时取消等记录全部继续通过严格加载。

9 项真实 Docker/SQLite 检查通过（约 24.5 秒），包含此前 6 项文件检查点回归及本轮 3 项集成场景：

1. 每次实际 Docker create 之前，夹具读取同一 Workflow 数据库，核对当前 Attempt、请求身份、已提交资源 ID 和尚无结果步骤；共享正常 A → B 流程通过。
2. 在 A 的资源已提交、保存回调尚未返回时暂停并 SIGKILL 宿主。确认容器尚未创建；新进程严格加载完整 Workflow 记录，用该 Attempt 自带的 Runner 检查点确认 absent 并完成共同清理。
3. A 已接纳、B 实际运行时 SIGKILL 宿主；删除原输入及文件适配器临时目录，新进程恢复 seed 和 seedA，仅从 Workflow Attempt 记录核对并停止/移除旧 B。数据库不变，不重新执行 A 或启动新节点；B 的新 Attempt 仍未执行。
4. 在资源 CAS 写入处注入失败，实际 create/start 均未调用、B 未执行。数据库保留此前完整的活动 Attempt（resource/resultStep 均为 null、steps 为空）；实时查询保留 SCRIPT_EXECUTION_FAILED 和已确认停止的失败步骤，completion 因未能提交而拒绝。夹具按该失败身份完成本地清理，不把实时失败结果冒充已经持久化。

首次 Docker 检查为 8 通过、1 失败：测试把“未提交的数据库 steps 为空”错误扩展为“实时查询也没有失败步骤”。先回查 Blackbox 失败记录方式及本项目 ScriptExecutor/FileWorkflowCatalog 的失败保留语义，修正测试分别核对实时状态与数据库，并增加 create 调用计数。未修改产品失败处理来迎合测试；随后 9 项全部通过。

## 完整回归

完整回归完成构建、测试类型检查、模块边界检查和 358 项测试：普通测试 256/256 通过，Docker/E2E 101/102 通过（约 498 秒），无跳过或取消。本轮新增验证均通过；唯一失败为既有外网代理 TLS 测试的 CONNECT_TIMEOUT。

先回查 Blackbox egress-proxy.py、tests/test_egress_proxy.py 及两项相关提交：旧实现也设置连接超时，拒绝路径在本地验证，允许路径另作真实网络探测；未找到本次超时的确定修复。核对当前代理的就绪探测、10 秒连接上限与该测试的 5 秒客户端上限后，保持产品代码、超时及断言不变，单独重跑原代理测试和代理单元测试，8/8 通过（约 10.8 秒），其中原失败 TLS 场景约 3.5 秒通过。这表明原失败本次未能复现，尚不能确定根因或声称修复了网络波动；没有把首次全量结果改写为全绿，也未重复无关测试。

本轮使用本机 Node 26、真实本地 Docker、受控合成网络服务及既有 example.com 公网 TLS 探测；三种固定 CLI 镜像仅使用协议替身/合成材料。没有真实凭据、官方模型或学生数据，没有 Node 24 远端 CI、新增独立审阅或发布。442 个文档本地链接与 git diff --check 通过。

## 后续边界

资源事实现已进入正常 Workflow，但还没有跨进程恢复 CAS 所有权、旧宿主迟到 create/start 隔离、中断 Attempt 收尾及同一 NodeTask 新 Attempt 调度。单次 CAS 检查不等于与 Docker 操作原子完成；不能据此直接开放自动恢复。受控 SIGKILL 夹具只证明正常写入和旧资源共同清理，不证明并发恢复者下的 A 不重跑/B 新 Attempt 完成。Agent/认证/Effect、队列、重试、并行和真实学生批卷/报告/PDF 均保留后续验收。

[检查点指南](../guides/workflow-checkpoints.md) · [Runner 资源恢复](../guides/runner-resource-recovery.md) · [持久化决定](../../.agents/agent_notes/product/README.md#p-20260909-run-persistence)
