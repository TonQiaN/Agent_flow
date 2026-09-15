# 三种官方 Harness 联合验收

2026-09-15；关联 #9、#10、#11、#12；主负责开发者 @xiaoxuanli-a，Codex 执行及作者自查，未进行独立多人审阅。用户重新要求完成四项验收，先前延期已结束。本记录不发布版本。

## 对象与当前结论

验收产品基线为 main `d5d0cae1852edbec002ab551c0c46037d380a8be`。运行工作树 HEAD `9840df0ce8c2e4d1594a445d9fa8a8c77c9fd556` 与该 main 的 Git tree 完全相同；不是在未合入产品代码上运行。提交文档前远端 main 更新为 `c8e1890fb5c76d2ddac3c5bdb860ed061c3c9ea5`（PR #33 文档交付），已同步；核对 src、package.json、package-lock.json 无差异，产品验收证据仍适用。以下官方任务没有修改产品实现，使用专用凭据和合成材料，没有向服务发送真实学生数据。

三种组合均已通过同一 JSON 批卷 Workflow 的正常与返修路线。Claude、DeepSeek 还通过图片与结构化多出口；Claude 新登录、真实续期、占用及启动后取消已验证。Codex 后续图片任务收到远端 refresh token 撤销错误，等待专用账号重新登录及复验。#9–#12 仍开放，不能把此前成功或已配置状态替代当前尚缺的登录/复验；#13–#16 已另行逐项验收并关闭。

| 固定 CLI | 模型配置 | 认证 | 官方正常 / 返修 | 图片 / 多出口 |
| --- | --- | --- | --- | --- |
| Codex 0.153.4 | gpt-5.6-sol，low | OpenAI 订阅 | 两条通过，合计 3 个 Agent 节点 | 本轮后续调用因凭据撤销失败；历史图片证据独立保留 |
| Claude 2.1.226 | sonnet，low；本轮原始 init 记录为 claude-sonnet-5 | Anthropic 订阅 | 两条通过，合计 3 个 Agent 节点 | 读图 37 + 26 = 63；结构化 calculated 接纳 |
| dsh 0.1.1-rc.2 | deepseek-v4-flash，off；图片使用 deepseek-v4-flash-vision-exp，off | DeepSeek API key | 两条通过，合计 3 个 Agent 节点 | 图片模型配置通过 read_image / write / agentflow_outcome，calculated 接纳 |

所有配置关闭 search、subagents，使用固定 /task/input、/task/work、/task/outputs。上表模型字符串是实际请求配置；服务端别名可能变更，不能把旧模型名称写成不可变模型权重版本。

## 实际环境与证据来源

在宿主 macOS 的 Docker 环境运行产品 Runner；三个 CLI 先以 `--network none --version` 核对，然后通过产品受控 CONNECT 代理调用官方服务。实际 Runner capture 的镜像 ID 和版本与预检一致：

| 用途 | 不可变镜像 ID | 运行允许目标 |
| --- | --- | --- |
| Codex | sha256:b566ec5c9a620df1d9f0727ce03a15494b26074d0a09782f15f8a64a29a6d629 | chatgpt.com、auth.openai.com |
| Claude | sha256:f6f88f4755a5ec872d0c9085192d7c6b161dccf5f8b3cd1f7e65511961f045a8 | api.anthropic.com、platform.claude.com |
| DeepSeek | sha256:a92f35565532db0e3c9ace1454754a0232a35ff413d31ebe3c7a90e7ae78916b | api.deepseek.com |
| CONNECT 代理 | sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 | 转发上述固定目标，不取得业务凭据 |

配置预检的 `validated=configuration-only`、`networkCalled=false` 描述预检步骤，不能据此否定或证明随后的真实调用。通过判定取实际 CLI 原始记录、Runner 终态、文件 contract、Gate 和释放结果。

官方矩阵命令为 `node --import tsx src/examples/tutor-grading/matrix.ts`，按[指南](../guides/harness-grading-matrix.md)提供非秘密配置。原始 stdout/stderr、DeepSeek 具名会话、执行事实和产物仅保存在本机私有验收目录；正式记录不附 token、账号、学生内容或绝对凭据路径。

## 正常、返修与图片结果

三个组合分别执行 `intake → marker → gate → projection → publish` 和 `intake → marker → gate → fixer → gate → projection → publish`。第二条明确要求初始 Marker 错判一个分数，独立 Gate 驳回后 Fixer 重算，最终均为 5/7。两条的业务 outcome 均为 published、accepted/released 为 true。三个组合均确认输入工作副本发生修改而宿主来源摘要不变，执行/产物资源为空，模拟 Effect 的 serviceWrites 为 0。这里的三次 Agent 执行不是三次 API 请求或费用上限。

独立图片探针由宿主生成只含两行数字的 PNG，用户任务只要求读图相加，未把正确数字写进 prompt。独立 JSON contract 要求 sum=63；两个业务出口为 calculated/review。Claude 通过最终 structured_output，DeepSeek 通过原生成功 outcome 工具记录，均通过真实文件契约和释放后源摘要核对。探针使用既有 AgentExecutor 和 Driver；没有放宽引擎的接纳规则。

### 保留的失败与配置边界

第一次 DeepSeek 图片探针使用 deepseek-v4-flash。固定 CLI 的模型表未给该标识声明图片能力，read_image 明确拒绝，模型未产生有效 outcome 工具结果；进程退出 0，但 Adapter 返回 MISSING_STRUCTURED_OUTCOME，引擎拒绝接纳。停止及清理成功，凭据可继续使用。聊天自称 review 没有被当成可信出口。

先按项目要求查看 Blackbox `5610d1b` 的 DeepSeek 探针记录，确认其配置需保留 provider、能力须实际验证；该旧记录未提供当前图片模型表的直接修复。随后核对 DeepSeek 官方[图片说明](https://api-docs.deepseek.com/guides/vision/)及固定 CLI 的实际行为，使用其图片模型标识 deepseek-v4-flash-vision-exp 后实跑通过。没有修改 CLI、伪造 inputModalities、改写 API 响应或借普通文本任务冒充图像能力。官方服务支持图片与旧 CLI 对某个模型标识的本地声明是不同检查；此次仅调整验收调用的 model 配置。

Codex 正常与返修通过后的独立图片调用返回“refresh token was revoked”，退出 1，Runner 确认停止/清理，绑定释放。未推断撤销原因、未恢复旧 token、未自动回退到桌面账号。必须在用户重新登录后复验；保留失败，不能用重跑覆盖。

## 订阅与凭据生命周期

用户在产品 `auth login claude` 的专用终端/浏览器完成新登录，随后三次官方任务复用同一来源。DeepSeek 经产品隐藏终端录入，官方任务证明本次 key 可用；API key 为静态环境绑定，不要求 OAuth 续期。原始录入值没有进入聊天、argv 或正式记录。

Claude 新登录缓存尚未到期，初始三次任务 revision 保持 1，不能记作续期。为验证原生续期，宿主验收脚本取得产品排他租约，仅把专用测试来源的 expiresAt 提前到当前时间之前，通过条件提交变为 revision 2；未修改 access/refresh token 或远端响应。随后未修改的 Claude CLI 发起真实续期，产物接纳后源记录为 revision 3，access 和 refresh token 的内存摘要比较均发生变化，expiresAt 更新到未来。此项是“人工提前缓存到期、真实远端续期”，不是自然等待到期。仅保存变化布尔值和元数据，不保存 token 摘要到正式记录，不恢复旧刷新 token。

Claude 图片任务持有来源期间，另一次 acquire 返回 CREDENTIAL_BUSY；任务完成后可重新 acquire/release。另一个真实 Claude 容器在 start_completed 后立即请求取消，最终 phase=cancelled、stop=confirmed、cleanup=removed、authentication.status=released，长期来源 revision 3 保留，临时目录为空。这证明实际启动/绑定后的取消收尾，不声称该取消任务完成了模型请求。探针初次遗漏显式输入目录，在启动前 INVALID_SUBSCRIPTION_REQUEST；补齐空输入目录后通过，产品未改动。

Codex 本轮正常流程前 product inspect 为 revision 1；三次官方任务后为 revision 2，同 generation；当前 access token 的签发时间及 last_refresh 位于第一条执行内，后两条实际请求通过。运行前未保存旧 token payload，因此这是修订号、时间和官方调用的组合证据，不提供旧/新 token 逐值比较。后续远端撤销说明一次成功不能承诺账号持续有效；新登录及恢复执行仍待完成。

并发保证仍限单机、同 credentialRef 的独占订阅执行；别名和外部软件持有同账号副本不在锁的保证范围内。真实远端有效性没有被写入长期 remoteStatus；本地检查继续为 unknown。

## 原 Issue 验收逐项对照

下表沿用原 Issue 顺序。基础实现的合入及合成/原生故障验证分别引用已提交记录；本轮官方调用只补齐它实际覆盖的项目。不能把本轮小任务当作重跑所有历史故障测试。

### Issue #9

| 原验收项 | 证据与结果 |
| --- | --- |
| 模块独立性 | [execution-foundation](2026-09-09-execution-foundation.md)：函数、Agent Driver 与 Workflow 执行端口分离 |
| 定义校验 | [workflow-serial](2026-09-09-workflow-serial.md)：引用、contract、路由、循环界限前置校验 |
| 输入隔离 | [docker-runner](2026-09-09-docker-runner.md)：并发修改/重命名/删除；本轮三家工作副本修改且来源不变 |
| 输出目录 | [file-contracts](2026-09-09-file-contracts.md)：自动收集、数量/大小/类型/schema/匹配拒绝 |
| 文件边界 | [file-contracts](2026-09-09-file-contracts.md)：链接、非普通文件与摘要交接反例 |
| 完成与失败 | [agent-acceptance](2026-09-09-agent-acceptance.md)：单/多出口及不合格交付；本轮真实失败不接纳 |
| 串行样例 | [workflow-files](2026-09-09-workflow-files.md)：本轮三家同一 Gate/返修/转换/dry-run 流程通过 |
| 用户路由 | [workflow-serial](2026-09-09-workflow-serial.md)：替换路由与目标、次数/步数耗尽及身份 |
| Effect | [workflow-effects](2026-09-09-workflow-effects.md)：授权、dry-run、独立业务身份与幂等冲突；本轮零写入 |
| 控制与记录 | [agent-workflow](2026-09-10-agent-workflow.md)：启动、查询、取消和真实执行收尾 |
| 真实集成 | 本记录：三家业务闭环已通过；Codex 新登录/图片复验待完成 |
| 文档交付 | 本记录：本轮更新当前矩阵；最终 PR 与合入核对待完成 |

### Issue #10

| 原验收项 | 证据与结果 |
| --- | --- |
| 独立性 | [harness-auth-primitives](2026-09-09-harness-auth-primitives.md)：计划/parser 无进程及秘密依赖 |
| 参数交付 | [deepseek-compatibility](2026-09-09-deepseek-compatibility.md)：固定版本原生配置；本轮实际 model/推理及图片模型边界 |
| 固定目录 | 本记录：三家同一目录约定实跑通过 |
| 认证与环境边界 | [credential-environment](2026-09-09-credential-environment.md)：订阅文件/静态 key 环境配方及脱敏 |
| 事件解析 | [deepseek-adapter](2026-09-09-deepseek-adapter.md)：原生会话、工具配对、未知/重复/缺失/截断 |
| 采集衔接 | [deepseek-session](2026-09-09-deepseek-session.md)：本轮先复制原始 stdout/文件，再释放；DeepSeek 会话保留 |
| 完成/失败 | [docker-runner](2026-09-09-docker-runner.md)：非零、超时、取消、采集失败；本轮退出0但无outcome亦失败 |
| outcome | [agent-acceptance](2026-09-09-agent-acceptance.md)：结构化出口及契约；Claude/DeepSeek 本轮真实图片 calculated |
| 注册 | [harness-auth-primitives](2026-09-09-harness-auth-primitives.md)：独立注册与未知 Harness 拒绝 |
| 真实支持矩阵 | 本记录：三家实际官方业务通过；Codex 新登录/图片复验待完成 |
| 文档与交接 | 本记录：当前支持/限制同步；最终合入核对待完成 |

### Issue #11

| 原验收项 | 证据与结果 |
| --- | --- |
| 解耦 | [harness-auth-primitives](2026-09-09-harness-auth-primitives.md)：Profile、Adapter、Runner 与认证协调分离 |
| 来源 | [auth-management](2026-09-09-auth-management.md)：显式受控文件/隐藏终端、冲突/缺失/不回退 |
| 存储与注入 | [credential-environment](2026-09-09-credential-environment.md)：权限/所有者/链接、名称注入且无任务密钥文件 |
| 订阅复用与隔离 | [credential-binding](2026-09-09-credential-binding.md)：本轮独立状态、跨任务复用、Claude 实际续期回存 |
| 刷新和恢复 | [credential-recovery](2026-09-09-credential-recovery.md)：条件提交/健康不回滚/不复活；本轮真实续期和独占边界 |
| Endpoint | [controlled-egress](2026-09-09-controlled-egress.md)：固定端点及代理实际阻断；三家本轮仅使用官方目标 |
| 容量与生命周期 | [subscription-login-coordination](2026-09-09-subscription-login-coordination.md)：单机多进程占用与管理互斥；Claude 本轮真实忙/取消释放 |
| 状态真实性 | [auth-management](2026-09-09-auth-management.md)：本地配置≠远端有效；Codex 撤销错误未伪装成功 |
| 清理 | [credential-binding](2026-09-09-credential-binding.md)：正常/失败/超时/取消与未知停止；本轮源保留及临时资源清空 |
| 实际组合 | 本记录：Claude 新登录、续期、任务通过；DeepSeek key 调用通过；Codex 重新登录待完成 |
| 文档与交付 | 本记录：原验收范围保留；等待 Codex 复验与最终合入 |

### Issue #12

| 原验收项 | 证据与结果 |
| --- | --- |
| 模块边界 | [docker-runner](2026-09-09-docker-runner.md)：Runner/后端替身、独立脚本与 Agent 组合 |
| 输入隔离 | [docker-runner](2026-09-09-docker-runner.md)：两个并发副本互不影响；重跑不继承 |
| 固定布局 | 本记录：三家实际目录与独立配置/state |
| 实际执行 | [docker-runner](2026-09-09-docker-runner.md)：正常/非零/无法启动/部分创建失败与真实身份 |
| 超时与取消 | [docker-runner](2026-09-09-docker-runner.md)：容器实际停止、创建取消、重复取消与退出竞争 |
| 原始采集 | [docker-runner](2026-09-09-docker-runner.md)：stdout/stderr/文件、上限/截断/错误，删除前采集 |
| outputs交接 | [agent-acceptance](2026-09-09-agent-acceptance.md)：契约与持久交接前保留，本轮全部正常产物接纳 |
| 认证隔离 | [credential-binding](2026-09-09-credential-binding.md)：必要材料、脱敏、长期来源保留；Claude 本轮实际续期 |
| 资源与网络 | [controlled-egress](2026-09-09-controlled-egress.md)：真实 Docker 权限/资源/代理；官方任务保持同一配方 |
| 清理 | [docker-runner](2026-09-09-docker-runner.md)：成功/失败/取消/部分启动、失败保留；本轮资源清空 |
| 联合集成 | 本记录：脚本及三家官方业务闭环；Codex 重新登录复验尚待 |
| 文档与验收 | 本记录：当前记录同步；四项完整关闭仍待剩余证据及合入 |

## 联合故障回归与未覆盖范围

本轮在同一 main 等价源码执行以下受影响联合测试，23 通过、0 失败、0 跳过，195.92 秒。这组使用真实 Docker/进程以及协议替身，包含资源恢复、队列、重试与并行；它们不计入上述官方模型次数。

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 node --import tsx --test --test-concurrency=1 \
  src/tests/e2e/agent-workflow.test.ts \
  src/tests/e2e/subscription-resource.test.ts \
  src/tests/e2e/queue-worker.test.ts \
  src/tests/e2e/retry.test.ts \
  src/tests/e2e/parallel-json-script.test.ts
```

此前最终合入版本普通检查 415 项通过，默认 E2E 17 通过、188 跳过；未把默认跳过写成全量 Docker 通过。各特性和精确 head 的 CI、故障注入以已合入验证记录与 PR 为准。本轮没有重新运行所有 CLI 兼容性测试，也没有发布版本或重新完整批改真实学生试卷。

历史学生样本的分阶段批改/复核/18页 PDF 见[Tutor 学生输入验证](2026-09-10-tutor-student-input.md)及[扫描件验证](2026-09-10-tutor-scanned-marking.md)，不能改写为本轮三家模型都完成真实学生验收，亦未证明从空白状态一次成功。真实服务额度、服务端模型别名、外部凭据撤销、跨主机或跨文件别名占用仍不保证。
