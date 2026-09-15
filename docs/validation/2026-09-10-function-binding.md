# 确定性 JSON 函数绑定与恢复验证

本轮接续 Issue #13，基于本地 de49706；先查 Blackbox v0.1.22 / 5610d1b 的 `_validate_resume_record`、`_component_digest_payload`、中断节点恢复和 run lease。旧实现比较命令/镜像/契约等声明摘要，并通过运行锁保护执行；它没有提供任意 TypeScript 闭包的纯度或代码一致性证明。本项目保留安装版本的明确责任，采用现有 Run CAS 和无外部副作用的可重算函数约定，不照搬 Python flock 为宿主函数停止证明。

## 实现及边界

新增 `registerDeterministic`：登记时捕获实现函数及 revision、复制实际配置，每次执行取得独立配置。函数不接收 Attempt 身份；原 ComponentExecutor 继续核对输入、结果结构、outcome 和输出 contract。普通 register 不变，但缺少确定性声明时持久启动在写库或执行前拒绝。

JsonFunctionWorkflowCatalog 导出 `agentflow-deterministic-function/v1` 并提供只读恢复检查。共同恢复入口仅对无资源端口、无资源/阶段记录、JSON contract 的 Gate/Transform 开放此分支。严格加载器先比较实际登记版本与配置，再按同一 Run CAS 认领和交接，调用原运行循环的新 Attempt。已接纳 Gate 保留，中断 Transform 重算；迟到结果不能覆盖恢复后的状态。

版本由受信实现包负责，须覆盖代码和依赖行为变化。此实现不会自动验证纯度、闭包或环境，不适用于外部 IO、可变状态或后台写入；不能因此声称任意宿主代码都可安全恢复。文件函数和文件到 JSON 尚未接入。

## 已执行验证

本地 Node 26 作者检查。新增 3 项引擎测试覆盖版本/函数/配置捕获、独立输入和配置、描述副本、只读恢复不调用函数、旧普通函数兼容及无能力/无效登记提前拒绝。

新增 6 项真实子进程/SQLite 测试覆盖：A 为已接纳 Gate，B 为 Transform，在调用前或计算后未提交时 SIGKILL；两个恢复进程竞争同一 revision；原宿主继续返回迟到结果；版本或实际配置变化；连续两次宿主中断。恢复后 A 的原结果保持相同，B 在 task-2 的 Attempt 2 或 3 完成，steps 仍为 2，输出为 5；失败认领不调用函数、不改原 Run。重新加载完成记录不执行任何节点。

首轮定向检查 27/28 通过：迟到结果已正确被拒绝，但测试辅助进程对普通持久句柄误调不存在的 dispose 方法，导致其退出码为 1。先对照 Blackbox 的 lease finally 和本项目实际句柄接口，再把辅助进程收尾改为可选方法调用；修正后 28 项定向检查全部通过，约 1.82 秒。随后增加连续中断场景并纳入完整普通回归。

最终 334 项普通测试全部通过，约 11.02 秒；42 项实际 Docker Agent/检查点/恢复回归全部通过，约 100.41 秒。均 0 失败、取消、跳过。定向测试是普通测试子集，不相加。构建、测试类型检查、包边界、文档本地路径及 diff 校验通过；路径检查不含锚点与远端。没有调用真实模型或业务服务，也不代表独立审阅、Node 24 CI 或硬件断电测试。

## 继续验收

Issue #13 保持打开，继续文件函数/转换绑定、订阅占用恢复及剩余明确验收，再进入 #14–#16。通用临时数据 GC 不作为额外前置。真实学生批卷、完整报告和 PDF 尚未验收。

[使用指南](../guides/deterministic-functions.md) · [恢复](../guides/workflow-recovery.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
