# Tutor 合成批卷

这个可执行样例验证串行 Workflow 的业务交接。它使用三道算术题、乱序分布在两页的学生答案、预先写好的模拟 Agent 输出、真实文件契约/快照与独立内存发布服务。预期得分为 5/7。它不验证真实模型、OCR、评分质量、真实学生资料、报告排版或 PDF。

在仓库根目录运行，最后一个参数必须是不存在的输出目录：

```sh
npm run build
node --import tsx src/examples/tutor-grading/demo.ts /tmp/agentflow-tutor-fixture-result
```

输出目录保存最终 candidate.json 和 gate-report.json；终端显示运行状态、实际节点顺序和零服务写入。默认顺序为 intake → marker → gate → fixer → gate → projection → publish，第一次故意给错分，返修一次后通过。文件仅从各节点 outputs 接纳；Agent 修改输入副本不影响原始题目，也不会隐式成为输出。

## 用户定义与业务边界

`src/examples/tutor-grading/flow.ts` 的 gradingDefinition 返回普通 Workflow 定义，节点引用已安装 Component，返修目标、次数与最大步数由调用方选择。示例支持 marker、fixer、repairs 和 maxSteps 选项；revision 只是业务数据，不能控制引擎计数。不同题型的评分规则可替换 gate.ts，核心引擎没有 Tutor 专用分支。fixture-driver.ts 从独立固定答案文件生成候选，只是测试替身。

Gate 核对原始来源摘要、试卷/学生身份、题目覆盖、评分、总分和页码/答案证据。来源改变直接 rejected；评分或证据错误走 revise；候选 JSON 不合约直接执行失败，不进入业务返修路由。正常 rejected 与引擎 failed、最大步数 exhausted 分开记录。

## 文件转换与发布

FileJsonWorkflowCatalog 是独立本机适配：register 注册 transform、resolve 接入编译器、receipt/matches 查询私有接纳记录、cleanup 清理失败尝试。转换函数获得物化后的 inputPath、cancellation、身份和来源副本，返回 `{outcome, output}`；文件与 JSON 契约 ID 在该 catalog 内不能重名。它复核同 Run 文件引用及实际内容摘要，验证 JSON 输出并清理临时目录后才登记结果。函数必须在返回时停止自身工作；它是可信宿主代码，不是隔离沙箱。

示例转换只接受实际 grading-gate 签发的 passed 前序，并把候选、报告和源文件的内容摘要带入发布 JSON。发布策略再核对当前运行中的 publish Attempt、私有转换输出和 Gate 来源；单独提供一份自称 passed 的文件或相同 JSON 都得不到发布能力。授权记录不写入模型文件。

默认 dry-run 不写服务。测试中的 mode=apply、allowApply=true 仅向当前内存服务写入；业务凭据是固定测试值，与 Harness 认证分离。相同幂等键和相同内容在第二个 Run 复用结果，不再次写入；源文件即使语义相同但字节不同，也会因摘要不同而冲突。文件引用和 Run ID 不进入业务幂等输入，以免相同内容每次运行都被误判为不同操作。

宿主用样例返回的 release 释放每个 Run 的文件快照和失败资源，原始输入及复制出的最终结果由调用方持有。当前来源登记、Run、转换收据和模拟幂等账本均在进程内，不能跨重启恢复。

[验证记录](../validation/2026-09-09-tutor-grading-fixture.md) · [文件 Workflow](workflow-files.md) · [模拟 Effect](workflow-effects.md)
