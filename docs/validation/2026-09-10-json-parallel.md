# JSON Map/Fork 作者验收

2026-09-10（悉尼）；主负责开发者 @xiaoxuanli-a，Codex 实现与作者自查，关联 [Issue #16](https://github.com/TonQiaN/Agent_flow/issues/16)。预检基线 98c6f56，复用 #13 持久化、#14 队列和 #15 节点重试。没有独立审阅、远端 PR 发布或正式 Issue 关闭。

## 预检与实现边界

先查 Blackbox v0.1.22 / 5610d1b 的 parallel-execution.md、Map/Fork 定义、test_parallel_runtime.py 及并行修复历史。采用稳定 ID、Map 原索引、Fork 字典序、共享容量及部分结果保留；只实施用户确认的单层 JSON、单 Component 与 wait-all，不迁移旧配置、fail-fast 或旧预算重置行为。旧 Python 测试没有在本次运行。

新增 ParallelWorkflowCatalog 与纯展开/汇合模块；每项关联普通单节点检查点，在同一 RunRecordStore 中经现有 Worker 执行。父展开、子项初始记录和队列引用共用一笔条件事务。父等待释放占用，子项全部结束后由队列唤醒父节点；正常输出契约、路由、接纳和 CAS 继续生效。结构层不依赖 Docker、Harness、秘密来源或业务评分代码。

最大 62 项来自现有原子记录接口的 64 条条件限制；空 Map 合法，Fork 至少两个分支。队列索引更新至 v3，不支持开发 v1/v2 自动迁移。对业务而言没有嵌套子流程接口；内部单节点计划是复用现有恢复与调度接口的执行记录。

## Issue 验收对照

| 条目 | 实际证据与结论 |
| --- | --- |
| Map 身份与顺序 | 故意按 B、C、A 完成，结果仍为 A、B、C，保留 index。非数组、重复/空白 ID、项目契约错误在展开前失败；空数组产生空 items。 |
| 固定 Fork | 同一逻辑输入交给 alpha/zeta，按 ID 字典序汇合；非法分支、输入 ID/schema 不一致在登记时拒绝。公开 Fork 示例输出 alpha=14、zeta=21。 |
| 契约与范围 | 验证逐项输入/输出和最终汇合；坏汇合 contract 没有后继。文件、Effect、嵌套、额外字段、非法容量和非 wait-all 策略明确拒绝。结构层不解析 Agent 日志。 |
| 调度与隔离 | 组上限、共享角色与认证上限分别进一步收紧容量；父任务 owner=null 时等待。独立进程竞争仍不超组上限。真实 Docker Script 每项使用不同 Runner 目录、可写输入副本及独立 outputs，原始输入不变。 |
| wait-all 与取消 | B 最终失败后 A/C 仍完成，父保留 B 的定位诊断且不运行 finish。未启动项直接取消；活动项协作取消后父才结束。重试项在领取期间被取消，不创建新 Attempt、不遗留 retry 元数据。 |
| 恢复与重试 | 展开事务故障不留下部分子任务；SIGKILL 父展开进程后恢复只保留一组。A 已接纳后杀死 B，恢复保留 A/C，B 用 Attempt 2；普通失败后重新打开 SQLite 也只重试 B，父展开身份不变。篡改子 Run 引用被严格加载拒绝。 |
| 解耦 | engine/parallel 只使用契约、检查点和记录端口；队列负责稳定记录键及原子写入，现有 Worker/Runner 处理执行及资源。实际依赖边界检查通过。 |
| 文档与交付 | [指南](../guides/json-parallel.md)和[可运行示例](../../src/examples/json-parallel.mjs)已提供；本地改动包含实质决策正文。作者验收已具备，PR 提交、审阅、合入核对尚未完成，不能关闭 Issue。 |

## 执行结果与修正

本地 Node 26/macOS：构建、测试类型检查及依赖边界检查通过。Map/Fork 公开示例通过：Map 顺序为 a/b/c，结果 2/4/6；Fork 顺序 alpha/zeta，结果 14/21。

最终普通测试 404/404 通过，20.67 秒，零失败、取消或跳过。包含并行登记、队列集成、实际独立进程中断，以及新增心跳竞争回归。六项相关 Docker/Agent 测试 6/6 通过，56.76 秒：一个实际 Agent 重试、一个 JSON Script 并行隔离、两个 Worker SIGKILL/查询故障恢复、两个 Attempt 2/3 SIGKILL 的有限重试。后两项验证预算没有变成 Attempt 4。

最后自查修正正常任务释放归属后迟到心跳错误触发取消的问题，并为其添加有控制的竞态测试；同时避免取消发生在准备子记录期间仍发布新并行项。早期新 Docker 夹具的脚本括号与 AJV 严格 schema 声明错误已修正，没有放宽产品契约。首次最后回归同时启动普通与 Docker 套件，两个普通队列测试文件持续等待，人工终止；具体触发点未证实，不能计为通过。单独运行这两个文件 30/30 通过，心跳竞态单测通过；Docker 结束后完整普通回归加入每测试 30 秒超时并独立运行，取得上述 404/404 结果。后续普通与 Docker 验收按阶段运行，避免共享宿主负载影响短租期测试。

## 证据局限

Docker 测试使用合成 JSON、凭据与协议替身；JSON Script 的逻辑结果转换器是隔离验收夹具，未新增开箱即用的 JSON Agent 转换适配器。已有 Agent outputs 接纳协议未变；本次没有官方模型登录/调用、真实学生卷、评分质量、完整报告或 PDF 验收。没有机器断电、生产部署、历史迁移或 Node 24 远端 CI 结果。单机数量上限、非公平扫描及资源未知时阻塞的既有边界仍适用。

产品取舍见 [P-20260910-json-parallel](../../.agents/decisions/product/README.md#p-20260910-json-parallel)。
