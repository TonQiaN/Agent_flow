# DeepSeek 宿主执行组合

关联 #10/#11 和 [Harness 决定](../../.agents/agent_notes/product/README.md#p-20260909-harness-adapter)、[认证决定](../../.agents/agent_notes/product/README.md#p-20260909-auth-lifecycle)。本次接通 DeepSeekApiKeyRunner、DeepSeekAgentDriver、受信运行资产交接与统一执行收尾。真实 DeepSeek/Claude 模型调用及真实学生批卷仍未验收。

## 参考与实现

先查 Blackbox 的 DeepSeek 定义、Runner、镜像版本和 egress 路径。保留只允许官方目标、固定版本、私有状态、全程受控网络及显式凭据来源；沿用其已解决的 Node 全局 fetch 代理开关，不以普通环境变量存在就断言代理有效。

原两个订阅组合的内部执行代码更名为 credential-runner/credential-agent-driver，通过配方选择长期订阅租约或短期 API key 快照，以及可选的具名原始记录。公共 Codex/Claude 类和类型导出保留；engine 和通用 Docker 没有增加 DeepSeek 条件分支。

DeepSeek 组合先把宿主 image 解析为不可变 ID，通过离线 Runner 执行该镜像的 dsh --version；版本和采集完整性通过后才获取 key 快照与开放受控代理。任务执行固定使用同一 image ID，官方目标为 api.deepseek.com:443。受信应用资产与配置只读，私有 key 经固定启动程序进入 CLI，运行结束后先核对并清理凭据副本，再解释私有会话。

新增有界原始字节读取器，按 capture 记录检查长度、完整性、链接和读取期间变化，保留字节而非重新序列化 JSON；版本 stdout、执行 stdout 和具名会话复用这个边界。缺失/截断记录不能被解析成正常完成。执行句柄保留清理能力，retryCleanup 不把原业务失败升级；AgentDriver 复用既有文件契约与 ArtifactStore 交接。

## 容器资产

应用内 export-assets.mjs 是固定、无参数的宿主打包命令，不加载容器 SDK。它导出精确版本和 13 个固定运行文件；DeepSeekApiKeyRunner 的独立受信资产参数拒绝缺项、重复、错误版本、额外字段、任意名称、NUL 或单文件超过 64 KiB。构造时复制全部数据，调用者随后修改原对象不会改变运行内容。组合的只读配置共 14 个文件，仍在既有 16 文件预算内。

资产来自宿主部署，不来自 Workflow。结构/版本校验不证明来源可信，也不声称签名或内容认证；库不反向导入应用包或隐式搜索源码。

## 实际验证

合成组合测试在 node:22-bookworm-slim 内安装测试专用 dsh 协议程序及版本元数据。它替代模型与原生工具，不冒充真实 CLI；当前应用的固定启动、会话采集、宿主 Runner、凭据快照、真实 Docker/代理和 Agent 接纳均使用产品实现。

- 正常单出口由原生格式记录解释，消息中的合成 key 被脱敏；stdout 中伪造的 outcome/终态文本不承担完成权限。输出 sum=6，输入副本可改而宿主源文件不变，执行和版本采集使用同一镜像 ID。
- 代理实际启动，采集的允许目标为 api.deepseek.com；对不允许主机的 CONNECT 得到 403，没有联系真实服务。此用例不证明真实官方模型请求成功。
- 缺失会话、非零退出、key 副本篡改和运行期间取消均不被接纳；篡改不回写源存储，源 revision 保持 1。收尾后可释放执行工作区。
- AgentExecutor 的单出口、多出口分别得到 completed/rejected 收据并验证输出文件。Harness 完成但输出契约错误的情况被拒绝；释放后输入临时目录和产物存储无残留。
- 将同一测试镜像 tag 改指不同 CLI 版本，再使用尚未配置的 credentialRef，执行停在 version 阶段且 authentication=null，证明没有先取得凭据再检查版本。
- 资产打包和反例无需宿主 DeepSeek SDK；原始读取器覆盖字节保真、长度不一致、完整性、软/硬链接和超预算拒绝。

定点组合验证通过，耗时约 16 秒。完整 npm run check 启用 Docker、受控联网和三个既有 Harness 镜像：209 项通过、0 失败、0 跳过，约 104 秒；包含依赖边界、构建、测试类型检查、Codex/Claude 既有组合及 DeepSeek 原生工具回归。作者验证，无独立评审、远端 CI 或发布。

## 证据与剩余范围

完整回归继续运行已安装 dsh 0.1.1-rc.2 的原生工具、图片、会话、结构化出口和宿主 key 交接测试；这些原生能力证据与本次合成 CLI 的执行组合证据分别成立。本次没有把真正 dsh 的模型请求通过产品代理发给官方服务，没有访问真实 DeepSeek/Claude 凭据，也没有完成真实视觉理解、学生批卷、报告和 PDF。
