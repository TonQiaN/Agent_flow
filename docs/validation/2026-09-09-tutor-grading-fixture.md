# Tutor 合成闭环与文件转换验证

2026-09-09，基于本地模拟 Effect 提交 ba9d46a 继续 Issue #9。主责 @xiaoxuanli-a；Codex 实施及作者自查，没有独立多人评审。工作在 detached 工作区，尚未新增第四层远端 PR，也未合并现有 PR。

## 依据与实现

开发前读取 Tutor marking 的 v1.workflow.yaml、candidate_gate.py、final_gate.py、publish_poc.py，以及 Blackbox 5610d1b 的 tests/test_effects.py。参考其来源/候选摘要、覆盖和证据校验、宿主 Gate 收据和不同文件内容不能共享操作结果的测试；旧工作区有其他改动，本次只读。

新增 FileJsonWorkflowCatalog，显式连接文件契约与 JSON 契约，私有登记转换结果、身份和输入来源。Tutor 样例完全位于 src/examples/tutor-grading，评分逻辑未进入核心。模拟 Agent 读取独立固定候选文件；Gate 按题目、答案和页码检查。样例使用真实 FileArtifactStore、FileWorkflowCatalog、AgentExecutor、WorkflowRuntime 与内存 Effect 服务，不使用真实模型或生产业务服务。

## 验证结果

新增 11 组测试通过：

- 文件到 JSON 读取已验证独立副本，公开来源和结果的修改不改变私有记录；清理完成后才签发转换结果，重复 Attempt 不执行。
- 伪造、跨 Run、已释放引用及私有存储字节被改动均在调用前拒绝；输出 schema、未知 outcome、额外字段、非 JSON 和函数异常不被接纳。
- 运行中不能清理或重复调用；预先取消不调用函数；歧义契约 ID 与非 Transform kind 在注册时拒绝。失败清理不会补发成功记录。
- 乱序、跨页的三道题经一次用户定义返修通过，结果 5/7；原始输入字节不变，所有执行资源和快照显式释放。
- 直接通过仅需五步；相同内容在第二个 Run 复用 already-applied，实际内存写入仅一次；源 JSON 语义相同但字节改变时，同键明确冲突而不重写。
- 用户可选返修目标、零次或两次上限；revision=999 不绕过校验或计数；全局最大步数耗尽后无后继发布。
- 候选不合约在 Agent 接纳失败；源答案被改动直接拒绝；错误页码证据须返修。
- 只有业务 JSON、自称 passed 的重新导入文件、跨 Attempt 请求，以及没有宿主许可的真实 Gate 通过记录，都不能获得 apply 能力。

可执行示例实际运行：intake → marker → gate → fixer → gate → projection → publish，status=succeeded、outcome=published、serviceWrites=0。输出 candidate.total=5、maxTotal=7；gate.decision=passed、findings=[]。候选 SHA-256 为 ccd0339582f3aa3f8b51db93d031a7eff44c53b4bbb6ce2d9bec27858ac467b6。

完整回归命令：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=agentflow/harness-codex-chatgpt:55517b18fd19 npm run check
```

最终 **149 项通过、0 失败、0 跳过**，含边界检查、构建、测试类型检查、Docker、受控 egress、脚本、合成凭据及实际离线 Codex 启动/沙箱测试。执行示例另行通过。本地结果不是尚未创建的 Workflow PR 的 CI 结果。

## 本轮问题与修正

首次完整回归为 148 通过、1 失败：离线 Codex 启动测试的 5 秒窗口内没有 turn.started，stderr 仅显示 Reading additional input from stdin；无已知沙箱初始化错误。按用户要求先查 Blackbox 对应 ProviderBootTests 和该文件修复历史，其 Codex 离线启动采用 25 秒窗口。原测试单独运行四种组合通过，支持并行负载下时间窗口不足的判断，但不将其写成已证明的唯一系统根因。

将每次离线调用上限改为 25 秒、四组合总测试上限 180 秒，再运行全套得到上述 149 项通过。仍要求 thread.started、turn.started、无 turn.completed、超时、停止确认、容器删除、输入不变和无沙箱初始化错误；未弱化断言，也未改变产品 Runner 默认配置。

## 限制与后继

合成题目与固定 Agent 候选不能证明 OCR、真实模型评分或真实学生批卷质量。当前报告是机器可读 Gate JSON，未生成完整学生反馈报告或 PDF。Run、文件/转换来源和 Effect 账本只在进程内；真实模型 Workflow、其余 Harness 组合、持久恢复、队列、重试和并行仍按计划推进。

[使用指南](../guides/tutor-grading-fixture.md) · [模拟 Effect 验证](2026-09-09-workflow-effects.md)
