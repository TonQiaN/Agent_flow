# 私有凭据执行绑定验证

对象：Draft PR #19 的执行绑定增量，基于 f76f221；Refs #11/#12。macOS arm64、Node 26.0.0、Docker Engine 29.4.3。全部使用合成凭据，不读取真实账号材料，不调用认证服务或模型。

## 结果

启用 AGENTFLOW_DOCKER_TESTS、AGENTFLOW_EGRESS_TESTS 和已验证的 Codex 0.153.4 专用镜像后运行 `npm run check`：依赖边界、构建及测试类型检查通过，66 项测试通过，0 失败、0 跳过。既有沙箱和受控联网仍通过回归。

新增 7 组绑定测试验证：

- 租约和工作副本一一对应；普通 JSON 不含秘密或源存储位置；停止未知/清理失败时保留租约且不回存。
- 执行身份或资源不匹配不能释放；只有准备前可以放弃绑定，准备后必须提供可信执行结果。
- 损坏、丢失、符号链接和硬链接副本不覆盖原存储；删除链接不修改其指向的文件。
- 父目录被替换为链接时保留租约，不读取或删除越界文件；修复父目录后可再次收尾。
- 初始化失败不删除未由绑定创建的原有文件。
- 路径环境不能逃出 state 或覆盖 HOME、代理等后端环境，并固定调用者配置的快照。
- 已提交刷新后发生副本清理失败，可再次收尾而不重复提交旧 revision；并发 finish 串行化且结果幂等。

新增 1 组真实 Docker 测试运行三个场景：进程写入合成刷新后非零退出、主动取消、超时。每个场景均在实际停止/容器清理后回存 revision=2；提前 release 工作区被拒绝，租约仍 busy；收尾成功后另一租约读到新内容，旧工作副本移除，随后才能释放工作区。刷新内容不进入 Runner 普通结果或 stdout。

## 限制与交接

`FileExecutionCredentialBinding` 只协调本地租约、工作副本和收尾。它消费宿主返回的 RunnerResult；不能把外部 JSON 或用户提交的停止事实当作授权凭证。停止未知、资源清理或副本清理失败时的 retained 状态必须保留，#13 的崩溃恢复尚未实现。

本次测试中的格式检查和刷新均为合成行为，不证明 OAuth token 续期、账号一致性或远端有效性。真实 provider codec、Profile、Codex 计划与认证运行的组合、事件脱敏、真实模型及文件 contract 仍待接通。默认 CI 会执行本次普通 Docker 用例，但继续明确跳过未配置的 1 项专用 Codex 沙箱和 3 项外部联网测试。

使用顺序见 [Harness 与认证指南](../guides/harness-auth.md)，设计见 [认证决定](../../.agents/agent_notes/product/README.md#p-20260909-auth-lifecycle) 与 [Runner 决定](../../.agents/agent_notes/product/README.md#p-20260909-runner-lifecycle)。
