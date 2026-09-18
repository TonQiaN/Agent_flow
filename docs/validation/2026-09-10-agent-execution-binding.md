# Agent 实际执行定义验证

## 范围与依据

Issue #13，本地基线 3623e22，沿用[持久化决定](../../.agents/agent_notes/product/README.md#p-20260909-run-persistence)。用户已确认保存必要定义、认证只保存非秘密身份，并授权常规细节先参考 Blackbox。主负责开发者 @xiaoxuanli-a；Codex 实施及作者检查，未进行独立审阅。

先读 Blackbox v0.1.22 / 5610d1b 的 execution_plans.py、runtime.py 定义检查，以及提交 78d53c5：Profile 在 Run 开始前解析固定，恢复重新核对 Profile 内容，防止中途换配置。当前项目不引入旧角色选择器或整 Run 锁，沿已注册的实际 Driver/运行组合导出定义。

## 交付与检查

AgentExecutor 增加可选 Driver 定义端口；FileWorkflowCatalog 的 Agent 定义取自同一注册实例。CredentialAgentDriver 保存独立 Profile 副本，CredentialHarnessRunner 导出实际 Adapter 计划、用户说明、期限、实际调用参数和资产、非秘密 Profile/认证传输以及 Docker 配置。Recipe 的方法与数据在构造时保留；定义与执行共用同一配置工厂。

执行镜像和代理镜像都成功解析后，Runner 固定两个 ID；后续版本探针与运行都消费该选择。并发定义请求共享解析。未先冻结而已经开始运行时，拒绝事后补造定义。Docker 配置描述使用后端已有规范化和沙箱策略；其普通资源 definition 仍拒绝未支持的私有或联网恢复，不把配置快照当作完整资源证据。

新增 2 项普通测试核对实际 Driver 描述、无文件读取/执行，以及旧自定义 Driver 可普通运行但不能声称存在持久化定义。新增 3 项真实本地 Docker 元数据测试分别覆盖 Codex、Claude、DeepSeek：相同安装可匹配；prompt、model、Profile 引用、期限、执行镜像或 DeepSeek 资产变化不匹配；endpoint 不支持和镜像缺失拒绝；调用者及返回值修改不改变已注册配置；并发描述一致。凭据存储所有方法均为禁止调用的替身，调用次数为零，根目录没有产生任何执行文件。

合成 Codex 执行测试先持有凭据租约，再取得定义，证明定义不需认证占用；随后把仅本测试使用的 Agent 标签改指普通 Node 镜像，把代理标签改指 Alpine，正常执行依然使用先前固定 ID。实际捕获同时核对 Agent 与代理镜像，合成 token 刷新后定义保持一致。Claude 原有合成执行后追加事后首次冻结拒绝检查；DeepSeek 运行资产与合成协议、取消/输出接纳继续回归。测试不访问真实凭据，不调用提供商模型。

初始构建发现新增镜像查询表达式少一个数组结束括号，修正后构建/类型/边界通过；首轮相关集成 10 项通过。随后补入并发描述和事后首次冻结断言，再运行最终相关回归。

## 验证结果

Node 26 本地作者检查：全部 285 项普通测试通过（10.0 秒）；最终 42 项相关集成检查通过（80.6 秒），零失败、取消或跳过。集成范围为三种实际 Agent 描述、三种合成执行组合、已有执行定义、Workflow 检查点与恢复；包括旧 A 不重跑及 B 第 2/3 次 Attempt 的真实 SIGKILL 恢复。构建、测试类型、依赖边界、597 个本地文档链接与 git diff --check 通过。

本轮没有重跑其余原生 CLI/登录矩阵，不将基线 3623e22 的 408 项证据当作当前全部测试通过；当前验证范围为上述 327 项。没有远端 Node 24 CI 或独立审阅，也没有发布远端 PR。

## 仍未完成

本轮交付定义及运行消费的一致性。Agent 的 resourceDefinition、资源保存/共同恢复、认证占用重建、版本探针中断和可信文件收据恢复仍未接入；startPersisted 在资源描述缺失处拒绝，测试确认未写库且未执行。函数/Effect 等其他绑定仍有缺口。没有宣称 #13、真实 Harness 账号矩阵或真实学生批卷验收完成。

[使用指南](../guides/workflow-execution-snapshot.md) · [已有脚本恢复](2026-09-10-workflow-resume.md)
