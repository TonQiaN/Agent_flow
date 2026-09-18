# Tutor 报告消费端验收

2026-09-10（悉尼）；基线 f747a49，主责 @xiaoxuanli-a，Codex 实现及作者自查。关联 #9 及既有真实批卷/报告/PDF 最终验收任务；本次不关闭任务，没有独立审阅或远端发布。

## 预检与参考

此前数字答案合成样例只输出 candidate、gate-report 和发布 JSON，不能直接接收 Tutor 的扫描页及复杂标注，也没有报告 PDF。先查 Tutor/Blackbox 已有 marking/reporting Workflow、协议层、候选/最终 Gate、指标投影、集成渲染器和报告管线集成测试。选择直接复用业务 validator 和 renderer，保持 TypeScript 引擎不依赖 Tutor 业务库，不搬回旧 result.json/Artifact 清单协议。

使用 Tutor 仓库 HEAD 8ec3571ef767f5d021798d46fba5d4b598008329 的当前工作树。相关渲染器、契约及补充工具存在未提交更新，不能把它们说成该提交已发布的内容；本次未修改 Tutor 文件。选定工具及契约的 126 份源码指纹保留在本地证据，清单 SHA-256 为 `b841a7b3a2b0177fb664e90ffa61c2c62cf588494c587e4eafef979d7a2e8cb1`。该清单不涵盖 Python 依赖或系统字体，不能据此保证任意安装环境输出字节一致。

## 实际链路

输入是由 Tutor builder 生成并显式标注的单题合成扫描页，答案为 dy/dx=2x，固定候选为 2/2。TypeScript 正常文件 Workflow 执行 prepare → Reporter → Gate → render。prepare 使用 Tutor 的标注 validator 核对原始描述符、Reference/Mapping/Candidate，再调用相同指标投影和报告输入准备工具；Reporter 交付经过现有 AgentExecutor 接纳；Gate 复用 Tutor 报告 validator；render 直接使用其集成 A3 实现。

这里 Reporter 是明确的罐装答案 Driver，不是官方 Harness 或模型；没有实际 Marker/Reviewer 调用。输入候选结构正确和报告指标一致，不构成真实评分质量证据。

## 验证结果

Node 26、macOS、已安装 Tutor Python 环境：构建、测试类型检查、依赖边界通过。专用集成测试 4/4 通过，27.60 秒，零失败/取消/跳过：

- 正常链路产生三张横向 A3、包含一张扫描答卷；PDF 文件头、页数、页面尺寸、manifest 模板和原始输入保持不变均核对通过。
- 报告候选伪造 metrics hash，被确定性 Gate 拒绝，不调用渲染节点。
- Reporter 修改已准备指标，来源核对失败，不调用渲染节点。
- 宿主工具超过明确超时，执行失败且不调用 Agent；清理后没有剩余 Agent、Artifact 或节点目录。

单独公开 demo 完整通过，最终 PDF 237 KB 左右，三页逐页渲染为 PNG 并目视检查：成绩概览、合成扫描答案与侧栏、详细分析均可读，没有发现重叠、裁切或缺字。本例满分，侧栏明确没有扣分标注；没有练习题/内部练习链接，因此不能宣称练习导航已验证。PDF SHA-256 为 `e835b1e78707ae1b4be043949bb5d5a49716506f9432cb48d9bb30dbceeb9e3a`。

首次运行发现消费端媒体类型漏掉契约包 README 的 text/markdown；回查旧 source bundle 媒体类型后补齐，没有改变业务 JSON 校验。第二次被 Tutor validator 拒绝：合成扫描页更新后，夹具只更新 Mapping、未同步 Candidate evidence；修正夹具证据后通过，未放宽 validator。两次失败保持为失败，不用最终成功覆盖。首次类型检查另发现错误导入 JsonValue 及未收窄结果类型，已按现有接口修正。Codex 捆绑 Python 缺少 jsonschema，本次使用显式指定的现有 Tutor 环境，没有安装或修改依赖。

## 尚未验收

仍缺真实学生答卷、匹配官方试卷/答案、实际 Marker/Reviewer/Reporter、评分质量及完整真实运行证据。该消费端从已有标注结果开始，不能替代新引擎前半段扫描件批改与复核。报告为 v1，未接课纲检索/练习选择或网页分数估计；没有 Tutor 数据库或生产服务写入。

桥接使用受信任宿主文件函数，不宣称支持这条报告管线的跨进程恢复、Worker 调度或 Docker 隔离。既有 #13–#16 的独立验收不能自动填补消费端接线的这些差距。当前测试依赖指定 Tutor 安装和字体，没有 Node 24 远端 CI 或跨平台证据。后续真实验收必须继续保留原目标，不以这份合成 PDF 作为完成。

[使用指南](../guides/tutor-report-consumer.md) · [Component 决策](../../.agents/agent_notes/product/README.md#p-20260909-component-execution)
