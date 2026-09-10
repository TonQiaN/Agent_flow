# 确定性 JSON 函数的持久运行

`FunctionRegistry.registerDeterministic` 将受信实现的版本、实际执行函数和行为配置一起登记。`JsonFunctionWorkflowCatalog` 随后可以导出执行快照，并通过现有 `startPersisted`、`claimWorkflowRecovery` 和 `resumePersisted` 保存及恢复 JSON Gate/Transform。

```ts
// 安装的实现包导出代码及其版本；行为或依赖改变时必须更新 revision。
const increment = {
  revision: 'grading-normalizer-v1',
  run(input, config) {
    return { outcome: 'done', output: input + config.amount };
  },
};
functions.registerDeterministic('increment', increment, { amount: 1 });
```

函数只收到独立 JSON 输入和独立配置；不收到 Run/Attempt 身份。结果仍通过原 ComponentExecutor 的输入、outcome 和输出 contract 校验。登记捕获函数和版本，复制配置；修改原登记对象、配置或返回的定义副本不会改变已安装绑定。每次调用取得新的配置副本，函数对本次配置的修改不会污染后续调用。

这是受信代码安装约定：函数必须只根据输入与配置计算，不读取时钟、随机数、环境变量或可变外部状态，不写外部系统，也不留下后台写入。引擎不分析闭包、不证明纯度、不自动识别依赖变化。实现包负责准确声明版本；行为依赖也须纳入版本管理。不要把任意用户配置中的“版本”填入这里冒充实际安装版本。真正的业务副作用使用 [Effect](workflow-effects.md)。

执行定义 `agentflow-deterministic-function/v1` 包含实现 ID、revision、实际配置和 `recovery: recompute`。新进程重新安装实现，严格加载器比较全部定义和 contract。版本或配置变化时，在认领 Run 和调用函数之前拒绝；不会从检查点 JSON 构造函数。原 `register(id, fn)` 继续支持普通运行，但不能持久启动或恢复。

恢复只适用于无 Runner 资源、无阶段的 JSON Gate/Transform。已经接纳的节点、outcome 和输出直接保留；尚未接纳的计算在同一 NodeTask 的新 Attempt 中重算，即使上次已计算出结果但尚未提交。CAS 阻止原宿主迟到结果覆盖新记录；它不能停止仍在计算的宿主函数，这正是该模式要求无外部副作用的原因。计算重做不增加业务步骤或用户路由次数。

文件函数的目录写入和文件到 JSON 转换尚未获得此恢复绑定，不能套用这个无资源约定。订阅恢复及完整 #13 验收仍未完成。实现与真实中断证据见 [验证](../validation/2026-09-10-function-binding.md)。
