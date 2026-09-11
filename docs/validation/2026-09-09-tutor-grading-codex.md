# 真实 Codex 批卷 Workflow 验证

2026-09-09，基于本地 54fe117 的 Tutor 合成闭环继续 Issue #9。主责 @xiaoxuanli-a，Codex 实施与作者自查，没有独立多人评审。本次调用真实模型处理合成试题；真实学生答卷、完整反馈报告和 PDF 尚未验收。

## 依据、范围和环境

先核对 Tutor marking 的 v1.workflow.yaml 和既有 Blackbox/Tutor Gate/Fixer 边界，复用 AgentFlow 已通过验收的 CodexAgentDriver、CodexSubscriptionRunner、专用凭据锁与条件同步流程。用户已授权该专用凭据、实际模型调用及限定目标；本次没有扩大到桌面凭据或生产业务写入。

共享批卷应用改为显式注入驱动工厂、Component/prompt/config 绑定与 Workflow 定义。固定答案包装单独放在 fixture.ts；真实组合在 codex.ts，flow.ts 不导入具体 Harness 或认证实现。应用、Gate、文件转换和 Effect 的实现相同。

- Codex CLI 0.153.4，模型 gpt-5.6-sol，reasoning=low，subagents/search=false。
- 实际镜像 ID：sha256:b566ec5c9a620df1d9f0727ce03a15494b26074d0a09782f15f8a64a29a6d629。
- 嵌套沙箱与受控 CONNECT，只允许既有 chatgpt.com:443、auth.openai.com:443；固定 /task/input、/task/work、/task/outputs。
- 三道算术题和两页乱序作答均为仓库合成材料；无真实学生个人资料。
- 业务发布始终 dry-run，没有生产 DB 连接，内存服务也未写入。

## 实际结果

运行 `node --import tsx src/examples/tutor-grading/codex.ts`，外层沿用既有专用凭据锁、格式检查和条件同步；模型进程与凭据同步均退出 0。

| 路径 | 实际节点 | 结果 |
| --- | --- | --- |
| 正常批卷 | intake → marker → gate → projection → publish | succeeded/published；Gate passed；5/7 |
| 明确注入错分后返修 | intake → marker → gate → fixer → gate → projection → publish | Gate 先 revise、后 passed；一次真实 Fixer；5/7 |

三次 Agent 实际执行均为 Codex 0.153.4，Harness completed、Runner exited/0、停止 confirmed、容器 removed、认证收尾完成且无诊断。三个输入副本均被模型实际修改，宿主原始材料与最终接纳的源文件字节保持一致。所有 Artifact、节点、转换、Runner 和驱动物化目录清空，三次执行句柄全部释放。serviceWrites=0。

在入口自身判定之外，再独立读取保存的 Workflow、来源收据、最终候选和 Gate 报告：q1=2 分、页 1、答案 5；q2=0 分、页 2、答案 8；q3=3 分、页 2、答案 12；总分 5、满分 7。报告 decision=passed、findings=[]，candidateHash 与实际候选文件重新计算的 SHA-256 一致；正常路径有一份真实 Agent 收据，返修路径有两份，均绑定上述实际镜像。

| 最终候选 | SHA-256 |
| --- | --- |
| 正常批卷 | f1e135999de1910ca18395b875d0576fc2fab9329d57dc690d8a5fcfe03eec77 |
| 返修后 | 3942b00e57c1ca885c09c1704def0e15f3007dceb821320c70fc93ce5a1a7891 |

两份内容语义一致，但不要求模型逐字生成同样 JSON。私有证据保存 summary、Workflow、来源记录、接纳文件及 raw；正式仓库只记录上述自足的验收结论，不提交凭据或原始日志。本次 credential sourceSynchronized=false，不能宣称实际 OAuth 刷新已触发。

新增两组确定性回归验证：自定义驱动/Component 名称和用户 prompt/config 可以替换固定答案绑定，仍走同一 Gate/返修路径；异步准备期间调用方修改定义或绑定不改变已安装内容；Agent 不能占用受信 Gate 等标识或重复绑定 ID，且在构造执行器前失败。

完整回归命令：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=agentflow/harness-codex-chatgpt:55517b18fd19 npm run check
```

**151 项通过、0 失败、0 跳过**，含依赖边界、构建、测试类型检查、所有既有 Docker/受控联网/脚本/合成凭据及离线 Codex 启动测试。上文三次真实模型调用在全量回归之外单独执行，二者不混计为同一种验证。

## 限制与交付

这是首次真实模型的完整批卷 Workflow 接入验收。候选结构简单，不证明真实 PDF/OCR、题型评分质量或复杂学生反馈已完成。#10/#11 其余 Harness 组合、#13–#16 和最终真实学生批卷/报告/PDF 继续按计划推进。Workflow PR 尚未创建，现有 #17→#18→#19 已占三层短栈；本地检查不能冒充远端 CI。

[使用指南](../guides/tutor-grading-codex.md) · [合成回归](2026-09-09-tutor-grading-fixture.md)

2026-09-10 交付复核：#17、#18、#19 已按 merge commit 合并，Workflow 分支同步 main b62ce53，未改变 c251a6b 的产品源码。完整本地矩阵再次通过 **151 项、0 失败、0 跳过**，包含实际 Docker、受控网络和四种离线 Codex 启动；真实模型沿用上文已保存的验收证据。新 PR 的检查和作者评审另按其精确提交读回，不借用前置 PR 的 CI。
