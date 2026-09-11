# 模拟 Effect 验证

2026-09-09，基于本地脚本 Workflow 提交 b13345a，继续 Issue #9。主责 @xiaoxuanli-a；Codex 实施与作者自查，未独立多人评审。本地独立工作区仍为 detached；没有新增第四个远端 PR 或合并现有 PR。

## 依据与范围

先核对 Blackbox 5610d1b 的 effects.py 与对应测试入口：默认 dry-run、按节点一次消费授权、收据与 mode/component/key/outcome 绑定、复用收据重新校验。再次读取 Issue #9 原文，确认首期使用模拟目标服务，真实外部恢复属于后续持久化工作；最小控制入口允许按实际实现选择库 API。

新增独立 EffectExecutor、EffectWorkflowCatalog 和仅写内存的 SimulatedEffectService。授权通过私有对象能力绑定完整操作及执行身份；操作键关联规范化输入和目标。业务凭据只在模拟服务连接的私有闭包中，服务身份与 Harness 身份分开。

## 验证结果

新增 13 组回归通过：

- 默认 dry-run 不调用 apply、不占用实际操作键，并可在没有业务凭据的模拟连接中运行；输入违约在调用前失败。
- 缺少、克隆、其他执行器、已消费或范围变化的授权均不能写入；Component、目标、键、输入和执行身份的变化不能绕过检查。
- 同请求不同对象键顺序复用已确认结果；同键不同输入/目标/Component 冲突。修改公开收据/查询副本不影响私有事实。
- pending 在异步调用前占位，同键并发只调用一次；调用方修改输入/身份不改变实际请求或授权范围。
- 模拟已写入后抛出响应丢失异常，保留 unknown；后续获新授权的 Run 仍不重发。
- 不同执行器的请求标识不混用，旧收据不能冒充另一个执行器的新请求；收据请求标识、Component、目标、键、业务身份、模式、状态及 reference 不合法时不接纳；写入后输出 contract 失败同样锁定为 unknown。
- 预先取消不写入，适配器方法事后替换不能改变已安装调用；策略和预检失败只返回静态错误。
- JSON Transform → Effect 实际运行：dry-run 零写入；明确范围授权后以独立业务身份写一次；第二个 Run 复用收据，写入数仍为 1。无授权或错误业务凭据零写入，普通结果不含合成凭据。
- 取消同时遇到写入后响应丢失仍为失败、停止未证实；已经确认写入后再取消则保留 applied 收据，不冒充回滚。

完整回归命令：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=agentflow/harness-codex-chatgpt:55517b18fd19 npm run check
```

**138 项通过、0 失败、0 跳过**。包括边界检查、构建、测试类型检查、既有 Docker/脚本/受控 egress/合成凭据和实际 Codex 离线验证。本次 Effect 仅操作内存，未使用真实业务服务、真实凭据、模型调用或学生资料。本地检查不是未创建 Workflow PR 的 CI 结果。

## 限制与后继

授权和幂等记录在当前执行器内存中；没有跨重启信任、真实外部 exactly-once 或 unknown 解除接口。服务异常保守视为结果未知，不通过重发恢复。库 API 已提供最小校验、启动、查询和取消；CLI 加载器不另列为 Issue #9 必做范围。

文件到 JSON 的显式消费侧 Transform、完整 Tutor 合成批卷与已授权真实验收仍在同一 Workflow 工作项继续。现有接口测试不代表完整批卷、报告和 PDF 验收通过；其余 Harness 组合与 #13–#16 仍未完成。

[Effect 使用指南](../guides/workflow-effects.md) · [脚本验证](2026-09-09-workflow-scripts.md)
