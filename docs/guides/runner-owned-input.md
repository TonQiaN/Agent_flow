# Runner 内的输入物化

输入副本可直接在已登记的 Runner 工作目录中生成。DockerBackend 保留路径输入；RunnerRequest 的 `inputSource: null` 在没有物化能力时建立空的可写 input，有物化能力时使用该能力生成输入。

```ts
const backend = new DockerBackend(options, binding, undefined, {
  materialize: destination => artifacts.materialize(manifest.id, destination),
});
const runner = new Runner(backend, systemClock);
const result = await runner.run({ identity, inputSource: null, timeoutMs, invocation }, cancellation, persistence);
```

物化能力是宿主明确安装的 `RunnerInputMaterializer`，不是请求 JSON、Workflow 配置或可从检查点恢复的函数。方法在安装时固定；路径输入和物化能力同时出现会拒绝，不能静默选择其中一个。其他 ExecutionBackend 必须自行实现 null 输入的语义。

持久运行先保存实际资源身份和 prepare pending，再调用物化。目标 `input-source` 位于该资源工作目录内；物化成功后，经原有复制检查生成固定 `/task/input` 的可写副本，然后移除暂存。路径、链接、文件类型、大小及读取变化检查继续沿用原复制器。物化失败阻止创建和启动；部分文件、物化器的相邻原子暂存及尚未删除的 input-source 都留在同一个已登记资源目录内。

正常 release 和恢复后的共同 Runner release 清理该资源目录；恢复只需要实际资源身份与环境，不需要旧物化函数，也不会再次调用它。未知 prepare pending 仍不能自动认领。不会扫描旧的版本探针或 Driver 目录前缀删除历史遗留文件。

CredentialHarnessRunner 的版本探针直接使用空 input，不再创建 version-input 临时目录。实际 Agent Driver 把已捕获的 ArtifactStore 快照物化能力传给认证运行器，再由同一个 DockerBackend 准备输入，取消了 Driver 独立输入目录。Driver 选项现在只有 `{ timeoutMs }`，原未发布 API 中的 inputRoot 已移除；仓库示例和三类 Driver 已同步。

若直接调用 CredentialHarnessRunner，原路径请求保持不变。选择 `inputSource: null` 时，第四参数须提供物化能力，第三参数仍为可选的持久化端口；方法在该调用第一次异步等待前固定，模型和凭据内容不进入该能力的持久描述。

Catalog 与 AgentExecutor 共享同一个支持 inspect 的实际 ArtifactStore 时，直接借用已登记快照，省掉 Agent 的 Catalog node 目录及重复输入捕获。借用保持原输入所有权，停止不明时 Catalog 禁止释放引用；Driver 仍在 Runner 目录内创建独立可写副本。不同存储或不支持 inspect 时保留原路径回退。

内置存储已通过直接物化消除 Catalog checkpoint/restore 中间目录；目标存储未发布暂存、其他节点或回退路径的 node 目录、旧进程初始/已接纳临时快照及分配后尚未提交记录的窗口仍需后续处理，不能把输入调整当作完整崩溃 GC。[验证记录](../validation/2026-09-10-owned-runner-input.md) · [资源恢复](runner-resource-recovery.md)
