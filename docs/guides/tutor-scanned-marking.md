# Tutor 扫描件批改消费端

`src/examples/tutor-marking/application.ts` 把已安装 Tutor 的复杂批卷契约接到正常 TypeScript 文件 Workflow：intake → Marker → Candidate Gate → Reviewer → Final Gate。通过后由显式应用交接进入 [报告消费端](tutor-report-consumer.md)，生成报告/PDF。Tutor 依赖只存在消费侧，不进入引擎。

输入目录只有 `source/`，包含 Tutor 准备的 `input/marking-input.json`、原始及规范化页面、UPLOADED_PDFS 的试卷/答案/课纲和契约包。intake 核对 Schema 和每个来源描述符的路径、大小、哈希。当前不处理 CATALOG 来源、自动下载或生产发布。

## 使用与 Agent 任务

调用 `createTutorMarkingApplication(root, setup)`，明确提供 `source`、`tutorWorkspace`、`python`、`marker`、`reviewer` 以及 `driver(store)`。各 Agent 绑定包含唯一 `id`、用户的 `prompt` 和 `config`；Driver 与既有 AgentExecutor 相接。不同角色是独立调用，不要求使用不同模型，也不由 Adapter 编写任务。

任务正文应说明当前文件交接：

- Agent 使用统一 `/task/input`、`/task/work`、`/task/outputs`。输入是可写副本，修改不影响宿主原件；后续交付只从 outputs 捕获。
- Marker 复制 source 到 outputs，并写 `candidate/assessment-reference.json`、`submission-mapping.json`、`marking-candidate.json`。严格按 Tutor 契约处理身份、逐项覆盖、评分、页码区域和规范 JSON 哈希。
- Reviewer 复制当前输入到 outputs，独立核对原始扫描件、试卷、答案、评分及证据，可以修正三个 candidate 文件，再写 `trusted/marking-reviewer-result.json`。复核结果必须绑定收到的 Review Input、原始候选和修正后的候选文件哈希。
- `trusted/marking-review-input.json` 和 `candidate-gate-report.json` 是可信准备结果，不能改写。Tutor Schema 内 `/input/...` 是逻辑描述符，实际读取映射到 `/task/input/...`；`source/input/marking-input.json` 内的源文件逻辑路径相对于 source。没有新增实际 /input 挂载或旧 /agentflow 目录。
- 不写旧 `result.json`、Artifact 清单或模型自述的成功 Gate。确定性 Gate 检查实际文件和本次引擎收据。

用户可提供 `repair: { agent: { id, prompt, config }, maxRounds }`，次数为 1–100；省略时 Final Gate 拒绝即结束。返修 Agent 接收重新绑定当前候选的 Review Input 和失败原因；Workflow route limit 计数。没有在引擎或 Tutor 的旧两轮字段内固化次数。Candidate Gate 拒绝当前直接结束为 `invalid`，不自动启动复核；文件契约/来源篡改等执行失败也不进入业务返修。

`run(runId)` 返回工作流结果；`exportMarked(runId, freshDirectory)` 只接受本应用记录的实际 Final Gate 通过结果，输出独立副本并保留 trusted 证据。`prepareMarkedReportSource(markedBundle, freshDirectory)` 从已导出包提取 source/candidate 供报告应用。调用方应在完整链路结束后 `release(run)` 清理引擎快照，保留自己导出的验收材料；不要把修改后的公开 snapshot 当成通过依据。

## 合成演示

```sh
TUTOR_WORKSPACE=/absolute/Tutor_app/workspace \
TUTOR_PYTHON=/absolute/Tutor_app/workspace/backend/.venv/bin/python \
node --import tsx src/examples/tutor-marking/demo.ts /absolute/new-output-directory
```

演示使用明确的合成扫描页和独立 canned Marker/Reviewer/Reporter 调用。Reviewer 修改反馈并重新绑定候选，最终交付两条 Workflow 记录、标注 Gate/Review 文件和三页 A3 PDF。输出目录必须不存在。它验证接线与校验行为，不证明真实模型阅卷质量。

目前工具桥接是受信任宿主文件函数，超时/取消等待子进程组停止；不是这条消费管线的 Docker 或持久 Worker 实现。依赖显式 Tutor 安装、Python 库与字体。真实学生材料、实际三个模型角色的完整执行、质量复核仍须独立验收；详见 [本次验证](../validation/2026-09-10-tutor-scanned-marking.md)。
