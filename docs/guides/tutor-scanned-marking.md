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

## 显式学生材料入口

`src/examples/tutor-marking/student.ts` 接收调用方已准备且已授权的 source 包；不搜索学生、读取数据库或回退到夹具。`prompts.ts` 是消费端示例任务，应用仍接受用户自己的角色绑定。真实与合成入口共用 `acceptance.ts` 的两个正常 Workflow、Gate、实际执行记录和释放流程；验收摘要分别记录 syntheticMaterial、realModels、evidenceComplete 和 cleanupComplete，全部成功才报告 passed。

除 Codex 执行所需的显式镜像、模型、凭据引用和验收输出根配置外，该入口要求：

- `AGENTFLOW_MARKING_SOURCE`：包含 source/ 的独立绝对目录，由 Tutor prepare_marking_source 准备；source/prompt-images 使用原 prepare_initial_images 工具生成。
- `AGENTFLOW_REPORT_CONTEXT`：展示上下文 JSON 的绝对路径，字段同 ReportContext；不从候选生成身份。
- `TUTOR_WORKSPACE`、`TUTOR_PYTHON`：受信安装和解释器绝对路径。
- `AGENTFLOW_AGENT_TIMEOUT_MS`：显式正整数，每节点最多 5,400,000 毫秒。
- `AGENTFLOW_SOURCE_MAX_BYTES`：显式正整数，最多 512 MiB；保留原始照片和完整分辨率的规范页。

运行 `node --import tsx src/examples/tutor-marking/student.ts`。学生数据和角色原始输出可能含私人信息，应使用调用方的私有目录，不能提交仓库。每次创建独立运行目录，不导入旧可信收据；失败也不接纳部分候选。这个入口不默认启用返修，调用应用时仍可提供用户定义的 repair。

批改和报告的 `maxSourceBytes` 默认均为 128 MiB；本机存储与 Docker 输入复制另有独立预算，学生组合按来源加 128 MiB 余量显式配置。通用 FileArtifactStore 和 DockerBackend 默认仍为 256 MiB，各自最高 1 GiB；单文件和 JSON 限额仍有效。原持久归档仍为 256 MiB，不能把本例成功当作大文件持久恢复证据。来源契约有效也不代表评分正确，完整学生结果见后续验收记录。

可选 AGENTFLOW_MARKING_PRIOR_DRAFT 指向调用方明确选择的三份未接纳候选目录。入口在新任务包内保存 source/prior-candidate，只接受新 Marker 的正常完成和全部 Gate，不复用旧收据。入口同时从显式 Tutor 安装复制纯业务 validator 与其两个依赖，供 Agent 运行 source/self-check/check.py；该自检明确不签发宿主收据，宿主仍执行原安装的校验器。所有辅助材料只加入新任务包，原准备包保持不变。

可选 source/reference-images/ 提供调用方渲染的官方 PDF 页面，入口在学生附件之后按文件名顺序追加，并在任务说明中区分来源角色；剩余来源图像可保留在 source/reference-pages/ 供按需查看。数学符号应以原 PDF 视觉证据为准，不能单凭 pdftotext。source/review-notes.md 可记录需核对的作者观察，模型须对照来源独立验证，不是预填分数或通过结论。

可选 `AGENTFLOW_SUBMISSION_CONFIRMATION` 指向明确用户确认的 JSON 绝对路径，包含实际 `confirmedAt` 和 `text`。新批改通过全部 Gate 后，入口对该份候选记录精确 SHA256 和 MISSING item IDs，交给报告消费端原有完整提交投影校验；没有该配置就不补零。文件须由调用方在获得真实用户确认后提供，入口不自行询问或推定用户同意。

已完成一份16张真实学生作答的 Codex 分阶段验收，含独立复核、全部 Gate、18页 PDF 及原件一致性；从失败草稿修正批改、随后单独重跑报告，不能宣称空白冷启动一次通过。详见 [多页学生验收](../validation/2026-09-10-tutor-student-input.md)。
