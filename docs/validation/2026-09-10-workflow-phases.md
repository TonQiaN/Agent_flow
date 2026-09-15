# Workflow 通用阶段记录与恢复验证

范围为 Issue #13 的引擎阶段机制，使用本地 Node 26、TypeScript、SQLite 和 Docker Alpine 合成命令。没有使用真实凭据、官方模型、学生答卷或真实 Agent Driver。本记录不代表 #13 或批卷验收完成。

Engine 在正常 Workflow writer 中保存有序 resource/operation 阶段；执行快照升级 version 2、检查点升级 v5。编译固定新增能力，严格加载核对当前安装计划及历史，恢复共用 CAS 认领、共同 Runner 清理和正常执行循环。

## 方法与结果

- 最终普通测试 295 项通过（含 8 项新阶段测试），0 失败、取消、跳过。构建、测试类型检查、包边界检查通过。默认 E2E 另有 17 项通过、125 项因缺少开关跳过；这些跳过不算验收。
- 相关既有 Docker 回归 54 项通过，0 失败、取消、跳过，包括 Runner、执行定义、检查点、Script、恢复竞争和 CONNECT 恢复。
- 新真实 Docker E2E 4 项通过（末轮重跑也通过）：在首个资源和第二个资源启动完成时杀死宿主；连续两次中断后恢复；在宿主操作未完成时拒绝接管。使用真正的 SQLite 持久记录和新进程恢复，无手写恢复状态。
- 成功恢复保留 A，B 在同一 NodeTask 上进入 Attempt 2/3，输出 seedAB；所有已记录旧容器消失，新进程只读加载成功且不执行节点、不修改 revision。宿主 operation 中断时认领失败，原记录不变。
- 单元验证包括阶段顺序、重复/迟到端口、CAS 失败阻止操作、缺少完成不得接纳、逐个中间记录严格加载、资源/环境/计划篡改、部分清理重试和旧 worker 迟到写入冲突。

## 问题与参考

先检查 Blackbox Agent Workflow 的 runtime.py 正常 Attempt 保存与恢复路径：执行前保存事实，恢复继续共同调度路径。本实现保持同一顺序，不复制认证领域状态机到 Engine。

首轮阶段测试失败：compileWorkflow 固定执行器时漏拷贝新增 resourcePlan 和 restorePhaseResource，导致运行时缺少阶段端口。修复编译绑定后 6 项单元与 4 项 Docker 用例通过。暂停测试改为同时观察提前结束，避免同类失败让测试无限等待；真实夹具也输出执行失败原因。

最终审阅发现普通对象查找可能把 constructor/toString 等合法节点名的继承属性当作阶段计划。先核对 Blackbox execution_plans.py 的字典键查找，再改用实际自有属性；新增覆盖有/无阶段计划及每个中间检查点加载的回归。最终 295 项普通测试通过；54 项既有 Docker 回归在该窄范围查找修正前执行，修正后重跑 4 项阶段 Docker 测试。625 个本地文档链接、构建、测试类型、包边界和 diff 检查通过。随后补齐单资源节点不能复用前序阶段资源 ID 的写入检查，新增混合节点回归；最终普通测试包含这项修复，真实 Docker 轮次在该去重修复前运行。以上是作者验证，不是独立审阅或 Node 24 CI。

## 剩余边界

实际 Agent Executor/Driver/FileWorkflowCatalog 的阶段接线和严格文件收据尚未实现；宿主凭据获取中断没有可恢复证据，不能自行解锁。订阅刷新与占用、探针和物化临时目录的崩溃收尾、其他绑定与完整 #13 验收仍需继续。测试的 operation 只是无副作用模拟步骤。

[使用指南](../guides/workflow-phases.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
