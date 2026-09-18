# JSON Map 与固定 Fork

`ParallelWorkflowCatalog` 登记结构节点，再通过现有 `compileWorkflow`、持久队列与 Worker 执行。每项只调用一个已有 JSON Component；结构节点负责展开和汇合，不在 Component 里启动其他 Agent。

构建后可运行两个独立示例，示例使用临时 SQLite 目录，结束后自动清理：

```sh
npm run build
node src/examples/json-parallel.mjs map
node src/examples/json-parallel.mjs fork
```

[完整示例源码](../../src/examples/json-parallel.mjs) 包含实际 contract、Component、队列配置及两个 Worker 的组合。

## 登记结构

```ts
const parallel = new ParallelWorkflowCatalog(contracts, componentCatalog);
parallel.register('analyze', {
  kind: 'map', inputContract: 'items', outputContract: 'analysis-join',
  component: 'analyzer', itemId: 'id', outcome: 'completed',
  maxConcurrency: 4, failurePolicy: 'wait-all',
  retry: { maxAttempts: 3, on: ['execution_failure', 'interrupted'], delayMs: 1000 }
});
```

整体输入必须通过 `items` contract 且为数组。每项还要通过 analyzer 的输入 contract，并带有由 `itemId` 指定的唯一、非空字符串 ID，最长 128 字符。全部项目预检通过后才登记子任务；非数组、非法/重复 ID、项目契约不符或超过 62 项会明确失败，没有部分展开。空数组允许，汇合为 `{ "items": [] }`，仍需通过汇合 contract。

```ts
parallel.register('review', {
  kind: 'fork', inputContract: 'draft', outputContract: 'review-join',
  outcome: 'completed', maxConcurrency: 2, failurePolicy: 'wait-all',
  branches: {
    zeta: { component: 'language-reviewer' },
    alpha: { component: 'fact-reviewer' }
  }
});
```

Fork 需要 2–62 个预定义分支，分支 ID 使用项目普通 identifier 规则。每个分支的输入 contract 必须与共同输入的 ID 和实际定义一致；这里不推导通用类型兼容关系。分支也可单独设置 `retry`。

Map 或 Fork 分支的 `retry` 省略时不配置重试；显式提供时使用既有重试策略校验。`null`、`false`、`0`、空字符串等无效值会在登记时拒绝，不会静默当作缺省，也不会留下部分子计划。

结构登记后，普通 Workflow 节点仍引用对应登记名，例如 `nodes: { analyze: { component: 'analyze' } }`，以约定 outcome 接到正常路由。所有项目 outcome 输出和汇合 contract 都必须是 JSON。文件/目录 contract、Effect、嵌套 Map/Fork、子流程及非 wait-all 策略在登记时拒绝。

## 汇合与失败

Map 按输入索引组织结果，与完成先后无关：

```json
{"items":[{"id":"page-a","index":0,"component":"analyzer","outcome":"ok","output":{"value":2}}]}
```

Fork 按分支 ID 字典序组织 `branches` 数组，各元素保留 `id`、`component`、`outcome`、`output`，没有 Map 的 index。结构节点不做内容合并、投票或选赢家；需要修改结构时接显式 Transform。

wait-all 会继续处理其他未取消项目。所有项最终结束后，若有失败，父节点以 `PARALLEL_CHILDREN_FAILED` 结束，issues 中保留项目位置、ID 和错误码，不启动正常后继。全部成功还必须通过汇合 contract，否则以 `INVALID_PARALLEL_OUTPUT` 结束。旧执行尚未确认停止时，相关子任务保持阻塞；其他项可以完成，父节点继续等待核对。

## 队列与恢复

`parallel.childWorkflows()` 返回已经安装的内部单节点计划。应用为这些计划的 `unit` 节点配置正常角色、能力和凭据要求；Worker 的 host.open 根据已保存的 workflowId 选择原安装的父计划或 `parallel.childWorkflow(id)`。示例展示完整接线。存储中的定义只作校验，不作为可执行代码加载。

父展开、全部子记录及队列引用原子提交。子记录由父 Run、父 NodeTask 与项目位置生成稳定键，各自使用普通 NodeTask/Attempt、输入、输出、恢复与重试记录；父检查点的 `attempts[].parallel` 保存关联。这里使用相同 RunRecordStore，不启动可扩展子流程，也没有第二套任务数据库。

父节点返回 `parallel_wait`，Worker 返回 `waiting: 'PARALLEL_WAIT'`，父任务不再占用执行槽位。每项遵守本组 `maxConcurrency`，同时受共享角色和凭据容量限制。全部子任务完成后，队列只唤醒一次父汇合；汇合及后继仍经过正常 CAS 和路由。

部分成功后重开，已接纳项不重跑。失败或中断项沿用 [有限重试](node-retries.md) 的剩余预算；重试等待不占本组并发槽位。调用 `queue.cancelReady(parentRunId)` 可取消等待中的组：未启动项直接取消，活动项通过 Worker 心跳请求协作取消，父节点等确认结束后再终止。 子项恢复后若旧执行已确认清理、仅因凭据繁忙重新等待，可直接取消并保留历史 Attempt；清理未确认仍拒绝取消。若另一 Worker 先重新领取，则记录协作取消意图，不覆盖其归属或检查点。队列已领取的父节点使用既有 Worker 取消入口；本方法不会抢夺运行中的父节点。

首版队列索引为 v3，拒绝旧开发 v1/v2 索引，没有自动迁移。62 项上限来自现有原子接口最多 64 个记录条件（父记录、索引及 62 个子记录）。运行与检查点格式继续沿用已实现的严格校验。

## Agent 与执行环境

并行结构只接受可信执行器交付的逻辑 JSON。Agent 如果通过 outputs 文件交付 JSON，仍由既有 Agent 接纳/产物适配接口转成对应逻辑结果；Map/Fork 不直接解析 Harness 日志，也不恢复旧 result.json 文件清单协议。当前示例使用确定性 JSON 函数，真实 Runner 的 JSON Script 组合用于隔离验收；这不表示新增了开箱即用的 JSON Agent 转换适配器。

验证见 [#16 作者验收](../validation/2026-09-10-json-parallel.md)，取舍见 [P-20260910-json-parallel](../../.agents/agent_notes/product/README.md#p-20260910-json-parallel)。
