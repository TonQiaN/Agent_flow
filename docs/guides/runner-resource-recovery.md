# Runner 资源保存与恢复

Runner 可在正常执行时通过显式 `RunnerResourceSink` 保存实际分配的资源，重启后使用同一 backend 定义核对、停止并移除旧执行。当前内置实现支持断网 Docker；资源保存已接入 [Workflow 活动 Attempt 检查点](workflow-checkpoints.md)；恢复所有权和新 Attempt 调度仍未完成。

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
