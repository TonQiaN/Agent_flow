# 单机 NodeTask 队列与 Worker

本地队列已接通持久 Run、单节点执行和共同恢复接口。当前提供程序 API，已接通认证源预占与实际 Driver 调度绑定；PR 交付尚未完成。取舍见 [P-20260910-node-queue](../../.agents/decisions/product/README.md#p-20260910-node-queue)。

## 准备与提交

使用一个专用 SQLite 存储目录作为一个部署。提交端与所有 Worker 使用相同配置和存储目录；队列内部为 Run 和调度索引分配独立记录键。不要混入原先直接用 Run ID 保存的非队列历史数据。

```ts
import { NodeWorker, WorkflowRuntime } from '@agentflow/engine';
import { PersistentNodeQueue, SqliteRunRecordStore, systemClock } from '@agentflow/integrations';

const store = await SqliteRunRecordStore.open('/absolute/private/deployment/queue');
const profile = { credentialRef: 'writer', service: 'deepseek', method: 'api-key' };
const queue = new PersistentNodeQueue(store, {
  roles: { producer: 2, fixer: 1 },
  credentials: [{ identity: profile, capacity: 1 }],
  workflows: {
    grading: {
      draft: { role: 'producer', capability: 'agent', harness: 'deepseek', credential: profile },
      repair: { role: 'fixer', capability: 'agent', harness: 'deepseek', credential: profile },
    },
  },
});

// compiled 是应用用当前 Component、contract、Runner 与认证绑定编译的流程。
// 每个可能就绪的节点都需要显式配置；这里展示 draft、repair 两个节点。
const runtime = new WorkflowRuntime();
await runtime.preparePersisted(compiled, 'grading-001', input, queue.records());
console.log(await queue.query());
```

`preparePersisted` 保存初始输入和就绪记录，不执行节点。同一 Run ID 重复提交得到 `RUN_REVISION_CONFLICT`，不会重复入队；调用方可读取已有 Run。`queue.records()` 可读及创建，更新必须使用领取绑定的 Store；不要绕过它对底层记录写入。

认证按 `credentialRef/service/method` 身份计数，别名共用一个容量条目，重复身份配置拒绝。`capacity: null` 表示没有额外的本地认证并发上限，角色上限仍生效；该值不证明远端额度。当前配置是调用方显式提供的调度要求。Worker 从实际 Driver/Profile 经 Agent/Catalog 接口取得非秘密绑定，核对 Harness、认证身份和容量；队列可以收紧 Profile 容量，不能扩大有限上限。缺少绑定或不匹配在 Attempt 前拒绝。实际 Runner 使用的源还必须暴露当前领取的预占令牌，避免应用返回 admission 却将未预占的源传给 Driver；该临时令牌不进入持久执行定义。当前 endpoint 等完整执行选择继续由持久加载校验，队列不会改选账号、endpoint 或 Harness。

## Worker 与生命周期

```ts
// source 是应用部署使用的 FileCredentialStore；这里只绑定指定身份。
const worker = new NodeWorker(queue, {
  async open(runId, records, claim) {
    const reserved = createQueueCredentialAdmission(source, claim);
    // 应用根据已存 Run 安装当前定义与存储绑定；这里不执行流程。
    // 返回 { compiled, runtime, dispose? }；资源实现留在应用组合层。
    const application = await openApplication(runId, records, reserved.credentials);
    return { ...application, admission: reserved.admission };
  },
}, systemClock, 'worker-1', ['agent']);

const processing = worker.runUntilStopped();
// 宿主收到退出请求时：停止领取，等待当前节点及其清理结束。
await worker.stop('drain');
await processing;
store.close();
```

`createQueueCredentialAdmission` 从 `@agentflow/integrations` 导入；应用必须将返回的 `credentials` 传给该节点实际使用的 Credential Runner，并将 `admission` 交给 Worker。无认证节点不需要创建预占。`openApplication` 是应用自己的工厂，不是库中预设函数。它应安装与保存定义一致的当前代码、文件存储、Runner 和授权；可选 `dispose(snapshot)` 释放本次组合持有的资源。不要在工厂中执行另一个 Workflow 或跳过正常验收。

- `runOnce()` 最多领取一个 NodeTask，执行一个 Attempt；没有可执行任务返回 `null`。契约验收和路由由正常引擎完成，后继作为新就绪任务保存。
- `runUntilIdle()` 处理当前能领取的任务后返回；所有任务在等待时也会返回，不代表全部业务已完成。
- `runUntilStopped(pollMs = 1000)` 持续轮询；默认领取期限为 30 秒并定期续期。宿主可自行启动多个进程，各有独立 Worker 名称。
- `query()` 返回 Worker 的 idle / working / draining / stopped；队列的 `query()` 返回任务状态、归属和等待原因。
- `stop('drain')` 排空当前节点；`stop('cancel')` 请求正常引擎取消当前执行。`stop()` 本身不等待整个 Worker 结束，仍须等待运行 Promise 后再关闭存储。
- `queue.cancelReady(runId)` 取消未领取的任务；与领取竞争时只有一个操作生效。活动任务返回 `QUEUE_TASK_ACTIVE`，当前没有跨进程取消命令通道。 已完成旧资源清理后因凭据繁忙重新就绪的任务也可取消；其历史 Attempt 原样保留，不启动新 Attempt。恢复清理未确认或已被重新领取时仍拒绝取消。

## 等待、失败与恢复

任务可因 `ROLE_CAPACITY`、`CREDENTIAL_CAPACITY`、`CREDENTIAL_SOURCE_BUSY` 或 `CAPABILITY_UNAVAILABLE` 等待。按就绪次序扫描并跳过不能领取的任务；等待没有 Attempt，不消耗业务重试次数。

认证源繁忙时，Worker 不创建新 Attempt，封存本次预占令牌、释放领取及调度容量，延后 1 秒再参与扫描；其他允许资源的任务仍可继续。源预占复用登录/配置/执行使用的同一互斥锁，不能以一次可用性探测代替实际占用。订阅预占在 Runner 资源已经保存后直接交给该资源，确认停止后才刷新/释放；不可变 API key 在快照读完后释放源。新的 Worker 先完成 #13 的旧资源清理，再封存此前领取令牌，因此旧进程不能迟到重新取得凭据。

Worker 丢失或期限届满不会释放容量。下一位恢复者先改变归属令牌，再通过 [Workflow 恢复](workflow-recovery.md)核对旧资源。确认清理后才能执行同一 NodeTask 的新 Attempt。无法确认时进入 blocked 并保留占用；必要条件恢复后，应用可显式调用 `queue.retryRecovery(key)` 再进行共同恢复。这是恢复协调，不是失败节点的业务重试。

工厂在创建 Attempt 之前失败时，任务 blocked、容量释放；修复配置后可显式重新调度。出现未确认执行时保留容量。认证源内部短事务最多等待 1 秒后明确失败，未知锁不按 PID 死亡清除；预占尝试本身不等待源可用。前一个节点的成功结果不能作为后一个节点停止的证明。

每次写入先核对归属和当前期限，再将观察到的队列索引版本及 Run 版本放入同一事务条件。接管或心跳等并发修改使旧条件失效，因此旧 Worker 即使在检查后暂停，也不能在新归属下实际覆盖已采用结果。这里不声称数据库在提交瞬间另行检查时钟；接管与旧写入由条件事务确定唯一先后顺序。

## 首期限制与验收边界

- 索引最多保存 2,048 个历史 NodeTask，包含已完成项；单任务最多保存 64 个未收束的领取令牌，超过时阻塞。繁忙等待完成封存后清空该批令牌。达到上限明确拒绝，不自动删除历史。配置变化与已存配置不符时拒绝打开；当前索引 schema 为 v3；没有从本地开发 v1/v2 的迁移、压缩或热更新工具。凭据源保留已封存令牌的本地收据，首期没有自动清理。
- 队列简单扫描、统一索引写入，接受单机规模限制；没有公平性保证、多主机调度、抢占、优先级或驻留 Agent 池。
- 队列容量与凭据源互斥通过显式 admission 能力组合，源预占实现当前提供 FileCredentialStore 适配；第三方源须提供同等生命周期保证。自定义 Agent 缺少实际调度绑定时拒绝排队执行，普通非队列入口保持兼容。
- 已验证多进程容量竞争、实际提交中的归属竞争和 Docker Worker 被杀后的恢复。真实官方认证、生产 Tutor 服务、学生卷和报告/PDF 不在本次验证范围，见 [验证记录](../validation/2026-09-10-node-queue.md)。
