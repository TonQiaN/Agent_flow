# DeepSeek API key、快照绑定与原生交接

关联 #11 和 [认证决定](../../.agents/agent_notes/product/README.md#p-20260909-auth-lifecycle)。本切片实现 DeepSeek 静态凭据 Codec/Profile/脱敏与不可变执行绑定，宿主完整 Runner/AgentDriver 和受控联网组合尚未完成。

## 参考与边界

先读 Blackbox Agent Flow 5610d1b / v0.1.22 的 api_keys.py、DeepSeek Harness 定义、凭据来源和租约路径。沿用显式来源、无空白可打印 ASCII、错误不回显及 API key 非独占语义。存储和交接沿用本项目已确定的格式及安全文件规则，不复制旧系统的整个状态目录或自动寻找环境凭据。

DeepSeekApiKeyCodec 接纳与既有固定启动程序相同的 schema/api_key 记录，记录上限 16 KiB、密钥 8–8192 个无空白可打印 ASCII 字符；不自动 trim、不接纳其他服务字段。源存储复用 FileCredentialStore，普通状态仍为 remoteStatus=unknown。运行刷新接口拒绝换 key，显式管理 configure 可以轮换。

Profile 明确 deepseek/api-key、official、credentialRef 和 capacity=null。null 仅表示认证层没有订阅会话独占要求，不代表服务无限额度或取消调度限流；官方目标为 api.deepseek.com，固定 443 egress 组合仍待接入。

FileExecutionCredentialBinding.acquireSnapshot 复用当前执行副本的安全路径、身份/资源核对和清理，但在读取 versioned 内容后立即释放源租约。执行期保留内存快照，准备独立 0600 文件；其内部提交能力只检查字节未变，不能调用源存储更新。原订阅 acquire 继续持有刷新租约，行为不变。

工作副本损坏、变化或消失会报告 refresh=failed；静态快照的 refresh=unchanged 仅表示副本检查通过，并非远端刷新。未知停止/清理保留任务副本和工作区清理门槛，源存储可继续管理。删除源凭据不能使旧副本复活，也不宣称撤销已经取得的快照或远端 key。

## 实际验证

八个新增本地测试覆盖：

- 格式/字段/长度/空白/字符拒绝、显式 Profile 和官方目标、脱敏初始化/常见编码/快照变化拒绝。
- 运行换 key 被拒绝，显式管理轮换成功，remoteStatus 保持未知。
- 同一 credentialRef 的两个运行快照可同时存在；轮换后旧快照保持原字节，收尾不覆盖新 revision；源删除后另一快照收尾不重建存储。
- 私有副本为 0600，普通序列化没有密钥或源路径；错误身份/资源拒绝，未知停止保留副本，确认取消与清理后移除副本。
- 损坏/缺失/链接副本不改变源存储或链接目标；读源失败仍尝试释放短租约，读或释放错误只返回静态诊断。

原有 DeepSeek 原生隔离用例改为由宿主 FileCredentialStore 和 acquireSnapshot 提供合成密钥。测试服务不再创建该用例的密钥文件；实际固定启动程序读取副本并向本地服务发送正确认证，父环境中不同的假 key 不被使用。22 个原生工具调用、23 个模型步骤、结构化 accepted、图片字节和全部隔离断言继续验证；宿主收尾返回 unchanged、源 revision=1、私有 key 副本消失，Adapter 使用快照脱敏器。

所有材料为临时合成数据，无真实凭据读取或外部 API 调用。使用既有 dsh 0.1.1-rc.2 镜像 sha256:a92f35565532db0e3c9ace1454754a0232a35ff413d31ebe3c7a90e7ae78916b。

完整 npm run check 启用 Docker、受控联网和三个既有 Harness 镜像：206 项通过、0 失败、0 跳过，约 104 秒；包含依赖边界、构建、测试类型检查、原有订阅回归及原生 CLI 交接。作者验证，无独立评审、远端 CI 或发布。

## 剩余验收

需继续接通宿主 DeepSeek Runner/AgentDriver、同一镜像版本探测、可信运行资产供应、受控代理、原始会话读取/脱敏与统一执行收尾。当前本地服务驱动的组合不是产品联网入口；真实模型、学生卷/答案、完整批改报告及 PDF 尚未验收。

后续进展：宿主 Runner/AgentDriver、运行资产与受控代理组合已接通并通过协议替身验证，见 [执行组合验证](2026-09-09-deepseek-execution.md)。以上保留本切片当时的范围。
