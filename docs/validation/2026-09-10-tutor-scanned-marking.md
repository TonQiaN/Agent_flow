# Tutor 扫描件批改与报告串接验收

2026-09-10（悉尼）；基线 c1328bb，关联 #9 和既有最终验收任务。主责 @xiaoxuanli-a，Codex 实现及作者自查，没有独立评审或远端发布。

## 预检与参考

报告消费端此前从已有候选开始，缺 Marker/Reviewer。先检查 Tutor 的 Candidate Gate、Final Gate、repair_input、Reviewer 任务及 Review Input/Reviewer Result Schema。复用其业务 validator 和 hash/阈值/逐项检查要求，但使用当前 TypeScript catalog 的实际前驱收据，未伪造旧 execution_receipts 或 result.json。旧 Schema 的固定两轮 repair 扩展未采用，返修由用户配置和当前 Workflow 控制。

使用既有 Tutor 安装与前次相同的源码入口；Tutor 工作树含用户未提交更改，不将其描述为干净的已发布版本，也未修改 Tutor 仓库或读取真实学生材料。核对前次登记的 126 份工具/契约源码哈希均未变化。依赖环境及前次代码指纹边界见 [报告消费端验收](2026-09-10-tutor-report-consumer.md)。

## 验证

构建、测试类型检查与包边界通过。首轮扫描件测试和既有报告测试合计 14/14 通过，131.19 秒，零失败、取消、跳过。其后增加 Reviewer 修改反馈的正向断言和更具体的失败反馈，扫描件测试重新执行，10/10 通过，109.04 秒，零失败、取消、跳过。

覆盖以下行为：

- 五节点批改接四节点报告链路，最终生成三页 A3 PDF。独立的 Marker/Reviewer/Reporter 调用经过正常 AgentExecutor，均为明确合成 Driver。
- Reviewer 可以修改 candidate；Final Gate 接纳重新绑定后的候选，报告接收修改后的文件。所有 fixture Agent 故意修改自己的输入副本，宿主原始 manifest 保持不变。
- 复核旧哈希、低于源策略的质量分、必需评分检查 FAIL、明确 REJECT 均拒绝，不能导出到报告。
- 来源文件或可信 Review Input 篡改在 TypeScript 来源核对时失败，即使重新计算 Reviewer 自述哈希也不能放行。
- 不合法候选在 Candidate Gate 被拒绝，不调用 Reviewer。
- 用户指定另一个 Fixer，一轮后通过；连续拒绝在用户指定的三轮后停止；不配置返修时只调用 Marker 和 Reviewer。
- 成功和失败后清理 Agent 临时目录、引擎文件快照及节点目录。既有报告四项回归继续检查错误指标哈希、来源篡改、超时及正常 PDF。

独立 demo 完整执行五个批改和四个报告节点。三张 A3 页面均渲染为 1400px PNG 并逐页目视检查：封面 2/2、合成扫描页与反馈侧栏、分析页可读，无重叠、缺字或裁切。本例满分，没有扣分标注和练习题导航；不能推广为这两项已验收。最终 PDF SHA-256：`e835b1e78707ae1b4be043949bb5d5a49716506f9432cb48d9bb30dbceeb9e3a`。

## 边界

以上证明消费端接线、可信来源、契约、拒绝和有界路由，不证明模型评分正确。仍未读取真实学生答卷，未完成实际 Marker/Reviewer/Reporter 全链路或评分质量验收，也未完成 PR 交付。该宿主工具链暂没有持久恢复/Worker/Docker 验收。原始错误记录保留，不用合成 PDF 关闭最终任务。

[使用指南](../guides/tutor-scanned-marking.md) · [Component 决策](../../.agents/agent_notes/product/README.md#p-20260909-component-execution)
