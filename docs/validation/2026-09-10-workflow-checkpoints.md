# 共享 Workflow 检查点与实际中断验证

2026-09-10（悉尼），主负责开发者 @xiaoxuanli-a，Codex 实现与作者自查，关联 [Issue #13](https://github.com/TonQiaN/Agent_flow/issues/13)。本轮不新增独立审阅、远端发布、真实凭据或模型调用。

## 对照与实现

先读 Blackbox v0.1.22 / 5610d1b runtime.py 的 active_step 保存、可信收据和 transition 提交；旧流程在调用前保存活动步骤，接纳后更新 current_value_artifact、execution_receipts、current_node 再 persist。参考这一顺序，保留本项目已确认的 NodeTask/Attempt 与“失败、取消不是自动恢复请求”边界，不复制旧整 Run 锁或恢复入口。

在原 WorkflowRuntime 中引入共享 cursor 和可选 CheckpointWriter。普通运行与持久运行使用同一校验/接纳/路由循环。先建立包含初始耐久输入的 Run 记录；调用前保存当前身份，接纳前保存输出，再将接纳和后继位置同一次 CAS 提交。实际脚本/镜像描述来自上一切片的编译绑定，不接受另外填写的环境声明。

FileWorkflowCatalog 的 checkpointValue 从实际活跃文件引用生成归档及来源收据，检查 Run、contract 和清单一致性，保护正在保存的引用不被释放。engine 保存端口结果，不自己处理文件路径。当前只提供写出事实，没有开放从任意 JSON 导入收据或恢复运行的接口。

## 定向验证

共享流程及文件交接定向检查最终 32 项通过：24 项原有回归、8 项新增检查点测试，约 1.0 秒。新增检查包括：

- 调用 A/B 前数据库已有各自活动身份；接纳 A 与后继 B 的位置、当前值、路由计数在同一版本出现；最终快照与正常运行一致。
- A 接纳的 CAS 冲突不调用 B，不继续尝试写入后续版本；初始存储或执行描述失败不调用节点。
- 延迟取消提交时 cancel 不提前确认；提交成功后记录保留取消意图，等待执行停止后才结束。取消写入失败返回失败，停止后的 completion 也不假装落盘。
- 循环再入保留不同 NodeTask、相同路由计数和 exhausted 结果，复用普通执行语义。
- 初始文件值保存期间拒绝提前取消，不创建缺少耐久输入的 Run 记录；完成初始化后正常执行。
- 最终提交失败不让 query 留在成功状态，保留 WORKFLOW_PERSISTENCE_FAILED；数据库仍是之前完整版本。

真实 Docker/SQLite 的三项检查最终全部通过（约 8.0 秒）：

1. 独立子进程实际执行 A → B。脚本读写容器输入副本，宿主源内容仍为 seed；新进程读库、从归档恢复三个值，分别为 seed、seedA、seedAB，同时核对 A 的 ScriptEvidence 和前序关联。
2. A 接纳、B 经 Runner observe 确认运行后，对宿主子进程发 SIGKILL。Docker inspect 仍确认该测试 B 容器运行；只移除这个已捕获 ID 的测试容器，再删除 source、temporary、work、attempts。新进程读到 A 已接纳、B 当前身份 task-2/attempt-1，以及 seed、seedA 的完整归档。该用例没有恢复 B 或声明其已完成。
3. 在实际 A 输出归档时注入失败。Run 保存失败和 WORKFLOW_VALUE_PERSISTENCE_FAILED，没有接纳 A 或调用 B；新进程只读到初始输入归档。

首次 Docker 测试的两项失败属于测试假设错误，保留记录：脚本误读 /task/work/value.txt（真实输入在 /task/input），且缺少 set -eu，得到 A/B 而非拼接内容；中断信号紧随 start 返回，误把尚处 created 的容器当作 running。先回查 Blackbox Runner 与当前 TASK_PATHS、既有脚本验收及 start/observe 实现，修正输入路径、shell 失败退出并等实际 running 后重跑；没有改变生产 Runner 的启动或停止定义。之后两项通过，再加入真实归档失败用例后三项通过。

代码核对另发现最终数据库提交失败可能让实时视图停留在 succeeded；修正为失败并加入确定性的拒绝写入测试，未用重跑代替修复。

代码核对还发现初始文件归档期间 writer 已建立但 Run 尚未创建，外部 cancelPersisted 可能抢先提交缺少初始值的记录。先查 Blackbox cancel_run 读取已存在记录、storage.request_cancel 只从已有 runs 行写入控制事实的边界，再为本项目添加初始化完成条件；定向暂停初始值保存的测试确认取消明确拒绝、数据库仍为空。最终检查以该修正后的代码重新执行。

## 最终完整回归

最后初始化条件修正后，重新执行完整 `npm run check`，233 项普通测试与 86 项端到端测试全部通过：共 319 项、0 失败、0 跳过、0 取消，两组耗时合计约 541.3 秒。包含产品构建、测试类型及依赖边界检查；最终三项检查点 Docker 场景约 3.1 / 3.7 / 1.7 秒。变更文档 138 个本地链接和 diff 空白检查通过。

环境为本机 Node v26.0.0，启用 AGENTFLOW_DOCKER_TESTS=1 与 AGENTFLOW_EGRESS_TESTS=1。原生镜像固定为 Codex `agentflow/harness-codex-chatgpt:55517b18fd19`、Claude `agentflow/agent-claude:21e8235ace16`、DeepSeek `sha256:a92f35565532db0e3c9ace1454754a0232a35ff413d31ebe3c7a90e7ae78916b`。真实 CLI 配合合成服务、协议替身和真实官方调用分别记账；本轮没有实际官方模型调用，也未运行 Node 24 远端 CI。

## 剩余验收

没有完整检查点加载/校验、文件引用重新注册、Runner 旧资源身份接管、新 Attempt 恢复、并发恢复者争用或 Effect unknown 核对。实际 SIGKILL 与耐久数据证明这些基础已经连入正常流程，但仍不能作为 #13 整项完成证据。下一步直接贯通上述恢复路径，保持现有八项和真实学生批卷/报告/PDF 范围。
