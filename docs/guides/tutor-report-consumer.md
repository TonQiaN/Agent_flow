# Tutor 报告消费端

`src/examples/tutor-report/application.ts` 把 Tutor 已有的标注结果接到 AgentFlow 文件 Workflow：准备指标 → 用户配置的 Reporter Agent → 确定性 Gate → 集成 A3 PDF。它直接调用已安装 Tutor 的契约、评分结构校验、指标投影和 PDF 渲染器；不在引擎中复制 Tutor 业务规则。

## 输入与配置

调用方显式提供 Tutor 的 workspace 目录、已安装依赖的 Python 解释器、报告展示上下文和现有 Agent Driver。没有默认桌面凭据、模型选择、材料搜索或 Tutor 服务写入。当前宿主工具桥接面向 POSIX，使用 Python、jsonschema、Pillow、reportlab、pypdf，以及 Tutor 渲染器支持的字体。

输入目录应包含已有 Tutor 标注结果：

```text
bundle/
  source/
    input/marking-input.json
    input/submission/original/...
    input/submission/pages/...
    input/source/paper.pdf
    input/source/answer.pdf
    input/source/curriculum.json
    contracts/...
  candidate/
    assessment-reference.json
    submission-mapping.json
    marking-candidate.json
```

原始文件、扫描页和 source 描述符必须匹配；Candidate、Mapping、Reference 的身份、题目覆盖、分数、rubric 和证据引用由 Tutor 的权威 validator 再验。消费端只支持准备好的 UPLOADED_PDFS 包，不会把扫描件自动变成已经评分的 Candidate。结构校验通过也不证明评分质量或独立 Reviewer 已完成；调用方须保留那些上游证据。

```ts
const app = await createTutorReportApplication(runRoot, {
  tutorWorkspace, python, source: markedBundle,
  context: { reportId, title, studentName, courseName, assessmentName,
    examYear, authority, jurisdiction },
  reporter: { id: 'reporter', prompt: userTask, config: userAgentConfig },
  driver: artifacts => makeInstalledAgentDriver(artifacts),
});
const run = await app.run(runId);
try {
  if (run.snapshot.status === 'succeeded' && run.snapshot.outcome === 'completed') {
    const result = run.snapshot.lastAccepted.result;
    if (result.status === 'accepted') await app.files.materialize(result.output, runId, newDestination);
  }
} finally {
  await app.release(run);
}
```

Reporter 输入为 `/task/input` 的独立可写副本，其中 `report-source/input/report-input.json` 和 `report-source/input/metrics/metrics-snapshot.json` 是确定性准备结果。任务说明应要求按 Tutor 的 `exam-report-candidate-v1` 生成 `/task/outputs/report-candidate.json`，引用实际指标并复制其他输入文件到 outputs。不要生成 `report-gate.json`、PDF 或旧 result.json 清单；它们由后续宿主节点负责。具体提示和模型配置仍由调用方定义。

目前报告使用 v1，关闭网页分数估计和针对性练习检索。Gate 校验指标覆盖和来源绑定，不接受伪造指标、超出依据的课纲引用或无依据的成绩估计。源目录、Candidate 和准备结果的任何改动（包括增加文件）会在 Gate 前被拒绝。合法报告经 Gate 后才调用 Tutor 集成渲染器，产物为 `report.pdf` 和 `render-manifest.json`，同时保留报告候选和 Gate 记录。

## 可运行的合成示例

使用显式安装路径，在 AgentFlow 仓库根目录运行：

```sh
TUTOR_WORKSPACE=/path/to/Tutor_app/workspace \
TUTOR_PYTHON=/path/to/python \
node --import tsx src/examples/tutor-report/demo.ts /new/output/directory
```

此命令生成单题合成扫描页，使用明确的 Reporter 替身和真实 Tutor 校验/渲染器。它不调用官方模型，不访问真实学生材料，不代表完成全部真实验收。输出目录必须不存在，失败记录不会被后续成功覆盖。

同样的环境变量可运行 `node --import tsx --test --test-concurrency=1 src/tests/e2e/tutor-report.test.ts`。默认未配置时这些外部依赖测试跳过，不能把跳过计为通过。

## 生命周期边界

文件 contract 管理目录、媒体类型、数量、大小与基础 JSON 形状，Tutor 业务 JSON Schema 和语义检查继续由其确定性 validator 负责。不是将该 validator 换成普通 object 校验。产物交接复用现有 AgentExecutor/FileWorkflowCatalog 的可信接纳机制。

Python 工具作为受信任宿主文件函数执行；解释器及程序位置来自显式安装配置，Agent 不能选择可执行代码。超时或取消向本次子进程组发送终止信号，等待进程关闭后返回，失败输出不会被接纳。输出日志有界，公开失败仅保留稳定错误码。此桥接没有新增持久执行定义或失联恢复端口，当前不能通过 `startPersisted` 将整条报告流程当作可恢复流程；需要该能力时须接入真实 Runner/Script 或独立可恢复宿主工具，而非伪造执行快照。

实际结果及未覆盖项见 [消费端验收](../validation/2026-09-10-tutor-report-consumer.md)，取舍见 [Component 决策](../../.agents/agent_notes/product/README.md#p-20260909-component-execution)。

## 已确认完整提交中的缺失作答

遇到 MISSING 空分值时，默认仍不能生成总分报告。用户明确确认照片完整后，调用方可传入 `submissionCompleteness`，字段沿用 Tutor `report-submission-completeness-v1`：本例以 context.reportId 作为 job_id，绑定原始候选精确字节 SHA256、实际确认时间/文字和精确 missing_item_ids。该配置在应用创建时快照化，不能从 Agent 输出中获得授权。

宿主复用已安装 backend 的 `project_confirmed_submission`，只把符合条件的 MISSING 项投影为0；原候选保留空分值、缺失状态及无证据事实。确认和内部投影保存在 report-source/input，供 Reporter 准确说明。指标和 PDF 使用同一投影；Gate 保护整个准备树，渲染前重新计算并核对投影。其他未解决的空分值仍拒绝；不伪造证据框、评分标准或复核收据。

## 只运行真实报告

`src/examples/tutor-report/real.ts` 使用显式 `AGENTFLOW_REPORT_SOURCE`（仅 source/candidate 的已标注包）、`AGENTFLOW_REPORT_CONTEXT`、`TUTOR_WORKSPACE`、`TUTOR_PYTHON`、来源/节点预算及 Codex 执行配置，单独调用正常的4节点报告 Workflow。上游实际通过的批改/复核证据由调用方保存，不能把本入口结构校验当成已经阅卷。可选 `AGENTFLOW_REPORT_COMPLETENESS` 是已绑定原候选的完整确认对象；可选 `AGENTFLOW_REPORT_PRIOR_DRAFT` 是未接纳报告 JSON，仅加入新 source 副本供模型核对当前指标并重新绑定。入口与整条批改验收共用私有执行证据记录器，不导入旧可信收据或改变宿主原包。
