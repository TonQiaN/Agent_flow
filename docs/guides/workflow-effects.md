# 模拟 Effect 与 Workflow

Effect 用于受信业务动作，独立于 Agent Harness 和其认证。首期 `EffectExecutor` 实现进程内授权、操作占位、收据校验和幂等复用；`SimulatedEffectService` 只写内存，用于验证行为。可选持久日志及固定操作的 apply Workflow 恢复已实现；动态映射和真实业务服务接入仍待完成。

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

未安装持久日志时，记录只属于当前实例。不能用重建执行器、清空记录或简单重发解决 unknown；当前没有解除 unknown 的 API。服务抛错一律保守处理，即使服务实际上在写入前因凭据不符而拒绝。持久日志也不是跨进程数字签名或任意服务的 exactly-once 保证。

## 可选持久操作日志

```ts
const journal = await SqliteEffectRecordStore.open('/absolute/private/effect-journal');
try {
  const effects = new EffectExecutor(contracts, components, adapter, journal);
  const approval = effects.authorize(request); // 仍由宿主根据明确业务权限决定。
  const result = await effects.execute(request, approval);
  const operation = await effects.queryDurable(request.key);
} finally {
  journal.close();
}
```

`SqliteEffectRecordStore` 从 integrations 导出。使用明确的专用持久目录，不能使用每次启动新建的临时目录。命名空间身份由首次事务创建并在重开时保持；`persistenceIdentity()` 返回该非秘密身份，未安装日志返回 null。持久 Workflow 将该身份纳入实际安装一致性核对；换成新建的空日志不能恢复旧 Run。

EffectRecordStore 与 RunRecordStore 的业务端口分开，本机底层复用 SQLite 的事务、完整性、WAL/FULL 同步和 CAS。逻辑 key 的存储行名使用哈希，避免与命名空间元数据冲突；引擎仍验证正文中的原 key，不把哈希当成认证。持久请求的 requestId 使用逻辑 key，独立于 Attempt；Component/实现、业务身份、目标和完整 JSON 输入须一致。输入含文件时，消费方仍须把实际文件摘要明确写入 JSON 输入。

apply 消费授权后，先读取日志；已确认 applied 才可复用为 already-applied，仍需本次授权及当前 contract。不存在时先唯一创建 pending，再调用适配器，核对并 CAS 写入 applied 后才返回 accepted。创建冲突或不明返回 EFFECT_RESERVATION_UNCONFIRMED，不调用 apply；读取失败/损坏返回 EFFECT_RECORD_UNAVAILABLE。pending 一律返回 EFFECT_RESULT_UNKNOWN，不能根据宿主退出或存储中没有回执推断外部动作未发生。实际动作完成而日志提交失败同样返回 unknown；后续读取若发现 applied 已真正提交，才可复用。

`queryDurable(key)` 是异步只读查询；pending 是持久不确定状态，不是进程仍存活的证明。原 query 只看当前实例的内存观测。日志不保存授权对象或业务凭据，不提供删除、解锁、导入回执或盲目重试。dry-run 不读写日志。取消在等待占位期间发生时阻止 apply，但已提交占位保留，后续仍保守视为未知。

独立执行器的中断边界见[日志验证](../validation/2026-09-10-effect-journal.md)，实际 Workflow 恢复见下方。

## 固定操作的持久 Workflow

```ts
catalog.register('publish', {
  mode: 'apply',
  operation: { target: 'workout-1', key: 'publication-1' },
  approval: request => hostPolicy(request),
});
const run = await new WorkflowRuntime().startPersisted(compiled, runId, input, runStore);
// 新进程按同一实际定义组装 compiled、Effect 日志和服务适配器。
const recovery = await claimWorkflowRecovery(compiled, runId, runStore);
await recovery.cleanup();
const resumed = await new WorkflowRuntime().resumePersisted(recovery);
```

这是首个支持组合：apply、明确的固定 target/key、持久日志以及实际适配器的 `definition()`。该方法返回含 schema 的版本化 JSON，描述实际服务实现，不读取业务凭据、不执行外部动作。内存模拟服务已提供固定实现描述；其他服务须由其受信适配器提供真实描述，不另传一份无关配置冒充实现证据。快照保存固定操作、实际 implementation/serviceIdentity、适配器描述和日志命名空间身份；不保存授权对象或 approval 回调。实际定义、目标或日志身份改变时拒绝恢复。

任意 operation 函数和 dry-run 继续支持普通运行；缺少可比较的实际定义时拒绝持久启动，在写 Run、请求授权或调用服务之前返回错误。固定描述在注册时复制，已编译方法和已安装适配器描述方法固定；调用方修改原对象不能改写已安装组合。此处固定 key 代表本逻辑操作，同一 Run 的新 Attempt 不更换它；新业务操作需要明确的新 key。

严格加载器对已接纳 Effect 也签发一次性校验请求，由 Effect 适配层将前序输入、固定操作、outcome 和完整回执与持久日志核对。读操作不调用服务、不请求授权、不导入模型提交的回执；日志缺失、输入冲突或回执不符拒绝。已完成 A 保留，B 恢复使用同一 NodeTask 的新 Attempt。

活动 Effect 在 Run CAS 认领之前只读检查日志。pending 返回 EFFECT_RESULT_UNKNOWN，保留原 Run；无占位或已有 applied 回执才进入共享正常恢复路径。初始只读检查不能代替并发约束，后续正常执行仍由唯一占位防止旧宿主和新 Attempt 双重 apply。已保存回执由普通 EffectExecutor 复用，仍须当前宿主明确授权；旧授权不会复活。迟到的旧 Run 写入与两个恢复者的竞争继续由同一 CAS 保护。

这是操作回执核对，不是接管服务内部会话。没有外部结果核对能力时，未知操作仍阻塞；也没有声明任意服务 exactly-once。[实际 Workflow 验证](../validation/2026-09-10-effect-workflow.md)。

## 取消与控制

启动前取消不调用服务。已发出的动作等待适配器返回；如果结果不确定，Workflow 保留失败和当前身份，不报告取消完成。若动作已经确认写入，随后取消的 Run 仍在 lastAccepted 中保留 applied 收据，取消不代表回滚。

首期控制入口是 TypeScript 库的 compileWorkflow、WorkflowRuntime.start/query/cancel 及 Run 句柄。CLI 定义加载属于可选后续功能，不是 Issue #9 的额外验收前置。当前完整文件 Agent → Gate/Fixer → Transform → Effect 批卷样例仍待消费侧集成。

[验证记录](../validation/2026-09-09-workflow-effects.md) · [执行决定](../../.agents/decisions/product/README.md#p-20260909-component-execution)
