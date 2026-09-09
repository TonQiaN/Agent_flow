# Runner 资源保存与恢复

Runner 可在正常执行时通过显式 `RunnerResourceSink` 保存实际分配的资源，重启后使用同一 backend 定义核对、停止并移除旧执行。当前内置实现支持无私有认证绑定的 Docker（断网或 CONNECT）；资源保存已接入 [Workflow 活动 Attempt 检查点](workflow-checkpoints.md)；恢复所有权与同 NodeTask 新 Attempt 已接入[Workflow 恢复](workflow-recovery.md)，其他绑定及未知操作仍待验收。

```ts
const result = await runner.run(request, cancellation, {
  save: async checkpoint => {
    // 宿主选择唯一 checkpointKey；等待受信存储提交完成。
    await store.create(checkpointKey, snapshotJson(checkpoint));
  },
});
```

Runner 先取得实际执行环境描述，再 allocate。分配后由 backend 生成资源描述并调用 save；保存完成前不会 prepare、create 或 start。保存失败返回 RESOURCE_PERSISTENCE_FAILED，保留原有停止、采集和清理事实，不能继续创建容器。普通不带 sink 的运行保留既有行为。

`RunnerResourceCheckpoint` 保存 schema、完整 Run/NodeTask/Attempt 身份、资源 ID、实际 backend 环境和 backend 私有资源描述。Docker 描述包含独立容器名及工作目录；目录内另有仅宿主可见、同步写入的资源标记。任务挂载目录不包含该标记。资源记录不保存业务成功结果，不替代 Workflow 的输入、输出、提示词及执行绑定检查点。

重启后从受信存储读取记录，再由新建 Runner 调用 `restore(record)`。该方法严格检查信封、身份和实际环境一致性，然后安装 backend 资源关联，不创建目录或启动容器。同一 backend 对同一资源并发恢复只接受一个调用；这只是进程内排他，跨进程仍由上层 CAS 协调。

返回句柄提供三项操作：

- `query()` 返回实际 created、running、exited 或 absent；Docker 不可查询或资源归属不匹配会拒绝，不将连接失败解释为 absent。
- `stopAndRemove()` 经共同 backend stop/remove/observe 确认旧容器已移除后返回 confirmed=true。仅“尚未运行”或 stop 返回成功还不够；created 容器可能仍有未完成的启动命令。失败返回 false，保留记录和目录，可以重试。
- `release()` 只在停止与移除得到确认后释放工作目录；如果目录存在，必须通过私有资源标记核对归属。清理失败保留句柄以便重试，重复/并发释放不会重复执行清理。

工作目录丢失时仍能通过持久资源身份核对并停止容器；目录丢失不证明旧执行结束。容器标签绑定 Run、NodeTask、Attempt、次数和唯一资源 ID，恢复查询还核对固定镜像。恢复句柄不提供 start，DockerBackend 也拒绝重新 prepare/create/start 该旧资源；退出码只是进程事实，不能从旧日志或 outputs 直接接纳成功。

调用者必须在使用恢复句柄前取得上层恢复所有权，并阻止旧宿主晚到的创建/启动操作。该 Runner 端口不取得 Workflow CAS 租约、不刷新认证、不重新执行节点；私有绑定、交互、联网和 Agent 完整恢复继续实施。示例中的存储必须来自受信宿主，不能把模型提供的 JSON 当作资源管理授权。

[Runner 基础](runner.md) · [检查点加载](workflow-checkpoint-loading.md) · [验证记录](../validation/2026-09-10-runner-resource-recovery.md)

正常持久 Workflow 还提供 RunnerResourceSink.launch 操作记录端口，准备/创建/启动前置记录等待 CAS，启动完成以共同 observe 为准。仅使用 save 的独立 Runner 调用没有这份操作进度证据，不能将其视为具备自动恢复条件。见 [验证与边界](../validation/2026-09-10-runner-launch-journal.md)。

[Workflow 恢复协调](workflow-recovery.md)已通过实际节点的 ScriptExecutor 绑定本接口，先认领 CAS 再核对、停止、移除和释放，确认记录留在同一 Run。该协调当前仍不启动新 Attempt。

CONNECT 恢复会核对任务容器、代理和内外两张网络的完整身份；代理还核对固定镜像。即使任务容器缺失，仍须移除代理/网络才确认收尾；工作目录丢失不会跳过 Docker 核对。代理已停止或缺失不阻止恢复者收尾，但查询错误、同名异属或网络仍有其他成员导致移除失败时，不确认清理完成，不释放资源归属目录。恢复不会删除其他成员容器。见[验证](../validation/2026-09-10-network-resource-recovery.md)。

## Agent 版本探针

CodexSubscriptionRunner、ClaudeSubscriptionRunner 和 DeepSeekApiKeyRunner 共享 `versionProbeDefinition()` 与 `restoreVersionResource(checkpoint)`。宿主可通过 `run(request, cancellation, probeSink)` 单独记录认证获取前的版本探针：`save` 接收带实际探针定义的 Runner 资源，`launch` 接收共同启动日志，`complete` 在核验版本、移除容器并释放目录后被等待；任何记录拒绝都不能进入凭据获取。

恢复只返回共同 Runner 管理句柄，调用者须先确认恢复所有权，再查询、停止/移除和释放。这个端口尚未接入 Workflow 的阶段检查点，也不记录后续模型执行资源或认证占用；不能据此恢复完整 Agent。实际中断与反例见[验证记录](../validation/2026-09-10-version-resource-recovery.md)。
