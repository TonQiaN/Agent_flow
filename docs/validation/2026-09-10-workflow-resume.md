# Workflow 新 Attempt 恢复验证

## 范围与依据

Issue #13，本地基线 dba71f2。按用户已确认的中断后同 NodeTask 新 Attempt、已接纳结果复用和参考 Blackbox 的授权实现；主负责开发者 @xiaoxuanli-a，Codex 实施及作者检查，没有补造独立审阅。沿用[持久化决定](../../.agents/agent_notes/product/README.md#p-20260909-run-persistence)，#13 保持未整体验收。

先核对 Blackbox Agent Flow v0.1.22 / 5610d1b 的 runtime.py resume、任务 attempts 递增，以及 tests/test_runtime.py 的定点故障和恢复测试。复用恢复前检查及任务内递增边界；不照搬原地清空中断记录、清除取消意图或旧格式升级。

## 实现与证据

恢复协调器内部签发一次性交接句柄，绑定实际安装定义、存储、最新 CAS revision 和恢复文件引用。WorkflowRuntime.resumePersisted 先提交恢复运行记录，再进入原正常执行循环。共享 writer/路由和 contract 接纳，无第二套调度器。恢复前的旧 Attempt 标记 interrupted，保留原身份/资源/launch；业务结果继续只关联原 steps。

严格加载同步到 v4，检查中断历史的连续任务/Attempt、资源唯一性、结果位置、路由和文件收据。旧 v1/v2/v3 试验格式不自动迁移。文件加载责任经内部句柄转交，原 recovery.dispose 不会提前销毁恢复运行的输入，恢复运行 dispose 等 completion 收尾。

新增 9 项普通测试：A 保留/B 第 2 次 Attempt/旧结果 CAS 失败；伪造、未清理及重复交接拒绝；后续 claim 阻止旧恢复执行；连续中断保留第 1/2 次并以第 3 次完成；路由再入产生新 NodeTask 且不额外占 maxSteps；交接提交后、尚未创建新 Attempt 又中断；恢复后立即取消；损坏历史与旧格式拒绝。另覆盖 queued 和 A 已接纳但 B 尚未创建的持久边界，恢复下一未使用任务；路由测试还限制 B 的转换仅可采用一次。其中所有真实 writer 中间版本（含恢复封套）逐一交给同一严格加载器检查。

新增 2 项真实 Docker / SQLite / 新进程测试：A 已接纳且 B running 后 SIGKILL 宿主，分别一次和连续两次；删除原 source、temporary、work，仅保留耐久 archive、Run 数据库和资源归属标记。新进程清理旧 B，仅创建 B 的 task-2/attempt-2 或 attempt-3，最后输出 seedAB；A 未重跑，旧资源移除，资源身份不复用。最终由另一新进程严格加载初始 seed、seedA、seedAB，并确认读操作不改 revision。

首轮新增真实测试 1 通过、1 失败：故障注入错误地匹配了恢复交接中保留的旧 Attempt，尚未到新 B 就暂停。先回查 Blackbox 按节点/执行位置定位故障的夹具，加入非 interrupted 条件；复测两项通过，没有放宽产品恢复校验或延长期限。新增普通测试起初存在测试 Store 参数的 TypeScript 形状错误，改为加载器实际要求的只读端口后通过。补跑全部普通测试时，未开放本地监听的沙箱使代理测试出现 EPERM；检查 Blackbox 的 test_egress_proxy.py 同样使用本地临时端口后，在已有授权的测试权限下重跑，283 项通过，未修改代理实现。

## 验证结果

Node 26 本地作者检查：最终 283 项普通测试、125 项 E2E 全部通过，零失败、取消或跳过，共覆盖 408 项。完整 npm run check 包含构建、测试类型和依赖边界，在普通测试 281 项时启动，后续串行 125 项 E2E 通过（580.4 秒）；补入 queued/after-A 两项边界并收紧路由测试后，重新运行全部普通测试，283 项通过（14.2 秒）。最终再次通过构建、测试类型、依赖边界和 git diff --check。

E2E 启用 AGENTFLOW_DOCKER_TESTS=1、AGENTFLOW_EGRESS_TESTS=1，使用已有固定本地镜像：Codex agentflow/harness-codex-chatgpt:55517b18fd19、Claude agentflow/agent-claude:21e8235ace16、DeepSeek sha256:a92f35565532db0e3c9ace1454754a0232a35ff413d31ebe3c7a90e7ae78916b。原生工具的本轮检查使用断网或合成输入/凭据，未调用真实模型。当前通过不等同于远端 Node 24 CI 或独立审阅，也不证明历史偶发超时已永久修复。

## 限制与下一步

当前实际内置恢复组合限于断网 Docker Script。pending prepare/create/start 保守拒绝，不能从宿主死亡、时间或一次 absent 推断旧操作已结束。Agent、函数版本、联网/私有执行绑定及认证恢复仍缺完整证据；Effect unknown 不能自动重发。没有测试机器断电、真实模型账号、学生材料或批卷报告/PDF，不把此切片等同于 #13 或八项全部完成。归档及死进程留下的临时数据未自动 GC。
