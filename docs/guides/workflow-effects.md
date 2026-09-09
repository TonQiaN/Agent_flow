# 模拟 Effect 与 Workflow

Effect 用于受信业务动作，独立于 Agent Harness 和其认证。首期 `EffectExecutor` 实现进程内授权、操作占位、收据校验和幂等复用；`SimulatedEffectService` 只写内存，用于验证行为。当前没有真实业务服务接入或持久恢复。

## 定义与接入

Effect Component 的 kind 是 effect，implementation 与显式安装的服务适配器一致；输入使用 JSON contract，三个出口为 simulated、applied、already-applied，各自引用 JSON 收据 contract。Workflow 对三个出口分别定义路由。即使运行模式固定为 dry-run，也保留完整出口定义，避免切换模式后才发现缺失连线。

`EffectAdapter` 提供 implementation、非秘密 serviceIdentity 及 simulate/apply 方法。业务凭据由适配器私下持有，不经过 EffectRequest、Workflow 定义、普通运行记录或 Harness 凭据接口。默认 dry-run 只调用 simulate，不占用真实操作的幂等键。

```ts
const service = new SimulatedEffectService('fixture-service-token');
const adapter = service.connect('publish-v1', 'grading-service', 'fixture-service-token');
const effects = new EffectExecutor(contracts, components, adapter);
const catalog = new EffectWorkflowCatalog(contracts, components, effects);
catalog.register('publish', {
  operation: input => ({ target: 'fixture-workout', key: 'fixture-publication' }),
}); // 默认 dry-run
```

示例使用合成凭据，只接入内存目标。contracts/components 须事先登记对应输入、收据和三个出口。JSON 函数、文件执行和 Effect 各自提供 catalog，宿主按 Component ID 显式组合它们；编译与运行控制不检查 provider 或业务角色。文件到 Effect JSON 输入的转换需要显式 Transform，当前消费侧桥接仍待后续合成批卷切片完成。

## 一次授权

apply 必须由宿主为确切的 `EffectRequest` 调用 `effects.authorize(request)`，得到当前执行器私有登记的不透明能力。它绑定 Component、实现、业务身份、目标、幂等键、完整输入及 Run/NodeTask/Attempt。不同对象键顺序按相同 JSON 请求处理；值、目标或身份变化不会复用旧授权。

Workflow 接入可在 `register` 中显式选择 `mode: 'apply'`，并安装 `approval(request)` 宿主策略。策略应根据先前明确的业务权限返回已匹配授权，或返回 undefined。不能因为模型提供了某字段就自动授权。没有回调时不会自动放行，缺少授权返回 EFFECT_NOT_AUTHORIZED。

能力不可从 Workflow JSON、序列化副本或另一个执行器导入。每次 apply 包括已完成结果复用都需要匹配能力，并在任何异步操作前一次消费。dry-run 不接受授权。当前不会自动暂停等待审批；缺少授权的 Attempt 失败，后续经授权执行使用新身份。

## 幂等与收据

每个 EffectExecutor 中 key 唯一，绑定 Component/实现、业务身份、目标和规范化完整输入。第一次 apply 前先建立 pending 记录：

- 相同键和相同请求已 applied：重查已保存收据和输出 contract，返回 already-applied，不调用服务。
- 相同键但请求不同：返回 EFFECT_KEY_CONFLICT，不覆盖原记录。
- 相同操作仍 pending：返回 EFFECT_IN_PROGRESS，不并发发送第二次。
- 实际调用抛错、返回错误上下文或写入后输出违约：保留 unknown，后续同键返回 EFFECT_RESULT_UNKNOWN。

`effects.query(key)` 返回私有记录的只读副本：请求标识、目标、业务身份、状态及已确认收据。不返回完整输入、授权对象或凭据。公开收据包含 schema、requestId、componentId、target、key、serviceIdentity、mode、status、reference。引擎核对上下文及对应出口 contract，拒绝模型或其他请求生成的“成功收据”。

这不是跨进程数字签名或跨崩溃 exactly-once。记录只属于当前实例，不能用重建执行器、清空记录或简单重发解决 unknown。后续持久化工作需要结合目标服务事实提供恢复；当前没有解除 unknown 的 API。服务抛错一律保守处理，即使服务实际上在写入前因凭据不符而拒绝。

## 取消与控制

启动前取消不调用服务。已发出的动作等待适配器返回；如果结果不确定，Workflow 保留失败和当前身份，不报告取消完成。若动作已经确认写入，随后取消的 Run 仍在 lastAccepted 中保留 applied 收据，取消不代表回滚。

首期控制入口是 TypeScript 库的 compileWorkflow、WorkflowRuntime.start/query/cancel 及 Run 句柄。CLI 定义加载属于可选后续功能，不是 Issue #9 的额外验收前置。当前完整文件 Agent → Gate/Fixer → Transform → Effect 批卷样例仍待消费侧集成。

[验证记录](../validation/2026-09-09-workflow-effects.md) · [执行决定](../../.agents/decisions/product/README.md#p-20260909-component-execution)
