# 订阅执行资源恢复

CodexSubscriptionRunner 与 ClaudeSubscriptionRunner 配合 FileCredentialStore，现可通过各自 AgentDriver 接入持久 Workflow。调用方式沿用[持久批卷组合](persistent-tutor-grading.md)及[共同恢复入口](workflow-recovery.md)，无需用户定义凭据路径或另一套恢复流程。

版本探针完成后，Driver 直接进入 execution 资源阶段；Runner 先保存资源，再在 prepare 中取得订阅源的独占占用并生成私有副本。加载定义和资源不会读取秘密或取得占用。自定义源存储须显式实现 ExecutionCredentialStore 才能支持此模式；只有普通 CredentialStore 的组合继续拒绝持久执行，不假装支持恢复。

配合 FileCredentialStore 时，普通非持久订阅执行也复用同一资源占用与收尾实现：占用从执行前取得改为 prepare 内取得，源存储新增按资源记录的收尾结果；不调用 startPersisted 则不会保存 Workflow Run 或阶段检查点。普通 CredentialStore 的自定义组合继续使用原租约绑定。普通执行没有 Workflow 启动日志和恢复认领，不因存在认证收尾记录就自动获得恢复资格。

恢复由共同 Runner 查询、确认停止、移除任务容器、代理和网络，然后调用绑定收尾。FileCredentialStore 核对资源归属及取得时的 generation/revision，使用原 Codec 验证刷新，保存收尾结果后释放占用。旧句柄再读或同一资源再次取得均被拒绝。已收尾资源再次恢复不会重写之后配置或删除的来源；新的 Attempt 使用新资源并取得当前凭据。

运行记录包含非秘密 Profile、源存储位置、私有副本位置和运输配置，不含凭据内容、凭据摘要或 generation/revision。正常刷新不改变执行定义；更换来源位置或认证身份会导致定义不一致。源存储内的私有占用及收尾记录只管理认证，不保存业务状态或决定路由。

源操作有短临界区。若宿主恰在该临界区内死亡、原占用没有可识别的执行归属，或来源版本冲突，恢复明确阻塞。不能删除锁、凭 PID/超时抢占或从历史秘密回滚。无效/丢失副本不会覆盖来源；停止后的收尾记为 failed，新任务仍需通过正常认证检查。当前进程确认从未准备副本时记录 not_prepared，认证结果的 credential 可为空。

本机收尾记录暂不自动回收。没有实现锁管理产品、任意损坏修复、凭据迁移或真实认证服务容灾。[验证记录](../validation/2026-09-10-subscription-resource-recovery.md)区分合成凭据与官方模型验收。
