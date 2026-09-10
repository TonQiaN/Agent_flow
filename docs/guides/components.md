# 确定性 Component

当前入口从 `@agentflow/engine` 和 `@agentflow/domain` 导出。先 `npm run build`；包内源码不重复嵌套 src，跨包通过公共入口使用。

```ts
import { ContractRegistry, ComponentRegistry, FunctionRegistry, ComponentExecutor } from '@agentflow/engine';

const contracts = new ContractRegistry();
contracts.register('number', { type: 'number' });
const components = new ComponentRegistry(contracts);
components.register({
  id: 'double', kind: 'transform', inputContract: 'number',
  outcomes: { completed: 'number' }, implementation: 'double-v1',
});
const functions = new FunctionRegistry();
functions.register('double-v1', input => ({ outcome: 'completed', output: (input as number) * 2 }));
const executor = new ComponentExecutor(contracts, components, functions);
const result = await executor.execute('double', 3, {
  runId: 'run-1', nodeTaskId: 'task-1', attemptId: 'attempt-1', attemptNumber: 1,
});
// result.status === 'accepted', result.output === 6
```

使用同一 ContractRegistry 注册定义并创建执行器。定义引用的 contract 必须先登记；实现可稍后注册，但执行前会解析。ID 和 outcome 为最多 128 字符、以字母/数字开头的字母数字及 `_.:-` 字符串；attemptNumber 是从 1 开始的安全整数。调用者目前自行提供身份，不能据此宣称引擎已有身份分配、重试或恢复功能。

JSON Schema 使用 Draft 2020-12 严格校验及 format 检查，只支持当前 schema 内片段引用。数据不自动转型、不补默认值、不去除额外字段。NaN、Infinity、undefined、稀疏数组、循环引用、Date、Map、getter 和非 JSON 属性会被拒绝；登记后修改原 schema 不改变已登记契约。

定义和函数分开，Workflow 路由尚未实现。当前执行器只执行 gate/transform，agent/effect 返回 `DefinitionError`。可信函数运行在当前进程：它得到可修改的独立输入副本和只读身份；引擎在接纳前复制返回对象，避免实现事后改变已接纳值。内存副本不是容器，无法约束可信函数自行读取外部状态或阻止死循环；尚无超时/取消实现。调用方自己修改返回对象属于调用方本地数据操作，当前没有持久化存储。

执行结果分为 accepted 和 failed。合法的 `rejected` 等业务 outcome 也属于 accepted；调用者依 outcome 作业务判断。failed 的 code 为 INVALID_INPUT、IMPLEMENTATION_FAILED、INVALID_RESULT、UNDECLARED_OUTCOME 或 INVALID_OUTPUT，不能作为业务返修结论。结果仅允许 outcome/output 两字段，output 按该 outcome 的 contract 校验。缺失定义/实现、非法身份等在调用前抛 `DefinitionError`，不会运行函数。

契约诊断提供 contractId、instancePath、schemaPath、keyword，不回显数据值或任意抛出错误文本；路径可能包含调用者字段名，业务同样不应把秘密编码进字段名和 ID。诊断不是完整审计日志。

文件契约、可修改容器输入、outputs 目录交付、可信前序证据和路由在后续 #9/#12 切片继续实现，当前 API 不承诺这些行为。
