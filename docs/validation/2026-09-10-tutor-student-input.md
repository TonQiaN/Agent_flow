# Tutor 多页学生输入接线验证

2026-09-10；基线 271bc63，既有 #9–#16 最终验收范围。主责 @xiaoxuanli-a，Codex 实施及作者自查；无独立代码评审，未远端发布。

用户指定从 Downloads 选择一份 Extension 1 作答，通过当前 Codex/OpenAI 批改、复核、报告。只准备选定材料和匹配的公开官方试卷/评分指南；不查询生产数据库、不改写宿主原件，仓库不保存学生身份、原图、模型原始事件或评分结果。

## 参考与发现

先核对已安装 Tutor 的 prepare_marking_source、normalized_images、prepare_initial_images、OfficialHscReferences.curriculum，以及 Blackbox 的 artifacts.py / runners.py。旧来源准备允许 512 MiB；原尺寸 PNG 规范化和原件留存可能使整卷超过样例限额。Blackbox 的文件树总量由调用方声明，失败执行也在容器收尾后处理认证占用；本次沿用这些职责边界，保持本项目固定路径和可信结果接口。

选定材料含 16 张 HEIC。准备后加初始图片共 167 文件、427,236,115 字节，最大单文件 25,494,605 字节；课纲使用已安装且覆盖该年份的真实 syllabus snapshot。宿主原件准备前后 SHA-256 一致。16 张预览逐一检查过，包含错选、未明确选择、涂改和跨页推导，不是单题夹具。

来源配套采用 [NESA 2020 Extension 1 考试资料](https://www.nsw.gov.au/education-and-training/nesa/curriculum/hsc-exam-papers/mathematics-extension-1/2020) 中的官方试卷和评分指南。下载、准备及原件哈希证据仅保留在私有验收目录；此记录只提供脱敏能力证据。

## 实施

真实学生与合成扫描件入口共用正常批改、复核及报告 Workflow；来源分类、模型分类、证据完整性与清理完整性分别记录。学生入口只接收显式准备包、展示上下文及预算，没有自动找学生或回退夹具。

来源树预算默认 128 MiB，调用方最多指定 512 MiB。FileArtifactStore 与 DockerBackend 独立预算默认 256 MiB、最高 1 GiB，同时保留业务 contract、64 MiB 单文件、1 MiB JSON 与目录/链接/摘要校验。学生组合使用 512 MiB 来源预算和 640 MiB 存储/输入复制预算。Agent 每节点显式 30 分钟，合成入口仍为 180 秒；旧 Tutor 阅卷节点为 90 分钟、报告为 30 分钟。

首次整卷启动通过来源 intake，随后 Docker 复制碰到旧固定 256 MiB 上限，Runner PREPARE_FAILED、未启动模型。认证未准备即释放却被 Driver 误报未收尾，消费端又先释放被借用的前驱，触发 WORKFLOW_FILES_IN_USE；该次不能算成功。已修复预算透传、not_prepared 收尾事实和逆序释放；正常 Harness、契约、语义复核和最终 Gate 的要求均保持。

## 验证

- 18 项初始接入测试通过：3 项组合预检、11 项扫描件/共享验收、4 项报告流程。新测试证明显式超限在调用 Agent 前被拒绝，并让共享入口跑完实际 Tutor Gate 和三页 PDF。
- 21 项存储/归档测试通过。270 MiB 的非学生二进制包验证默认拒绝、显式预算复制、跨存储直接物化、contract 更小上限仍拒绝、修改配置对象无效和清理。首次测试错误地尝试物化进同一存储根，被既有重叠路径保护拒绝；改为真实跨存储接收后通过，保护未放宽。
- 2 项最终消费端回归通过：失败下游先清理并归还前驱借用，以及共享批改到报告/PDF 全流程。
- 6 项真实 Docker 测试通过，使用模拟 CLI/凭据且不调用模型：Codex 正常/多出口、准备失败认证释放，以及输入物化隔离、空输入和失败清理。
- 全量普通测试 407 项，初跑 403 通过、4 项仅因沙箱禁止监听 127.0.0.1 失败；授权回环监听后定向重跑对应代理文件，5 项全部通过。该次其他 E2E 17 通过、184 因未开启专用环境跳过；不把跳过算通过。构建、测试类型检查与包边界通过。

第二次真实整卷 Marker 正常完成，355.41 秒、退出 0、Codex 0.153.4 / gpt-5.6-sol low；覆盖全部 35 个最小评分项（中途自述 31，最终文件已纠正）。但模型将候选写入 outputs/source/candidate，正式输出契约缺少三个顶层 candidate 文件，故 OUTPUT_CONTRACT_FAILED、未调用 Reviewer/Reporter，全部执行和输入资源释放。离线复用旧 Tutor validator 又检出重复页区域；模型自己的 schema 自检不能代替业务验收。

消费端明确三份候选的绝对位置，新增显式未接纳草稿输入，并将原 Tutor 纯 validator 及依赖作为沙箱辅助自检工具。其结果明确 host_gate_receipt=false；真正 Gate 仍运行宿主已安装的原代码并核对实际执行收据。辅助工具已对此前有效合成结果验证通过；没有宿主代写学生分数或证据框。第三次从原材料和未接纳草稿发起新 Marker，222.45 秒正常完成，候选 Gate 通过；独立 Reviewer 164.53 秒正常完成，Final Gate 通过，5 个批改节点成功。但报告 prepare 因 MISSING 空分值失败，没有调用 Reporter，未生成学生 PDF；evidenceComplete 和 cleanupComplete 均为 true。这不是端到端成功。

作者语义核对发现 PDF 文本提取丢失数学根号，导致已通过结构 Gate 的 Reviewer 给出错误反馈。这证明 schema 和运行终态不能代替评分质量验收。另有7个小题未找到作答；用户已明确确认16张照片包含全部作答，可按 Tutor 原有完整提交机制仅在报告投影中将这些缺失项计0。

先读 Tutor report_completeness.py、report_runner.py 与其绑定/拒绝测试，再接入原投影函数。新增8项实际 Tutor 报告流程测试全部通过：4项已有正常/拒绝/来源篡改/超时，加上确认完整提交、无确认、错误候选哈希与篡改投影。确认配置在创建时捕获；原候选字节不变，报告视图保留 MISSING 和空证据，不伪造 Agent 的评分。

追加官方页面时，58张有效图片被 Adapter 展开成重复参数，超过 Runner 的128参数限制，AGENT_START_FAILED；该次未返回执行句柄且 cleanupComplete=false，保留失败记录。按 Tutor codex-vision-entrypoint.sh 和实际 Codex 0.153.4 help 的变长 --image 参数修正；11项 Adapter/图片前置验证通过，64图片参数数目已在限制内。没有放宽 Runner 限额。实际 Codex CLI 离线测试通过4种启动场景，其中一项带64张合成小图片，均产生 thread.started/turn.started 后在无网环境按时停止；这不是模型验收。另一轮以16张学生图像加26页相关官方图像发起实际批改，全部42页官方图像仍保留在来源中。Marker 274.23 秒、Reviewer 241.78 秒均正常完成，5节点及全部批改 Gate 通过，修正根号题并复核跨页推导；题干占位已替换为实际内容。缺失确认已绑定新候选，指标准备通过；Reporter 173.45秒正常完成，但将 report-source 移至 trusted/report-source，输出契约拒绝，未执行报告 Gate/渲染。原批改仍然通过，全部实际句柄释放，整轮 passed=false。离线旧 Tutor 报告内容 validator 验证这份草稿通过，但不签发可信 Gate。按原 Analyst 规范明确角色目录，单独运行新的报告 Workflow，保留已通过批改及未接纳报告草稿；不重复阅卷。该模型执行启动于参数修复之前，使用42附件；修复后的64附件由独立真实 CLI 离线测试覆盖。

最终报告单独续跑已完成：新 Reporter 175.12秒正常退出，4节点（准备、报告、Gate、渲染）全部接纳，正式报告 Gate 通过。PDF 为18页 A3 横向，22,556,577字节，SHA256 `018341a6ac555468f50c5e54bf49235368797141976d813825b51fd8ff9ea220`。18页全部渲染并逐页查看，概览、16页学生作答及分析无报告文字裁切或批注重叠。原模板的练习区域保持空白；本次未接练习检索。

FileArtifactArchive 仍保留原 256 MiB；这条宿主工具消费链未声明持久 Worker 恢复。真实 Claude/DeepSeek 矩阵与远端 PR 交付也未由本次测试覆盖。

[扫描件使用指南](../guides/tutor-scanned-marking.md) · [执行模型决定](../../.agents/decisions/product/README.md#p-20260909-component-execution)

本轮最终 `npm run check` 整体通过：407项普通测试全部通过；默认 E2E 17通过、188按环境跳过。另显式开启的8项 Tutor 报告流程、11项 Adapter/附件检查、1项含4次真实 CLI 离线启动的测试全部通过；构建、测试类型、依赖边界及760个本地文档链接通过。

提取共用证据记录器后，显式 Tutor 的共享完整验收回归通过（24秒），保持合成分类、真实 Gate/报告/PDF 及清理行为。

## 最终验收结论

一份真实整卷已通过实际 Codex Marker、独立 Reviewer、Reporter、全部确定性 Gate 和 PDF。逐项核对5节点批改及4节点报告的接纳状态、3次正常 Harness/容器终态与释放记录；原16张照片 SHA256 全部不变，报告中的3份 candidate 文件与通过 Final Gate 的上游字节完全一致，所有既有 source 文件保持一致。确认严格绑定最终候选，7个 MISSING 仍为空分和空证据，只有报告投影视图计0，全部35项得分/满分求和一致；报告指标与报告候选、报告 Gate 哈希均匹配。实际分数及完整执行/质量记录仅存私有验收目录。

作者结合官方页面图像检查了根号、跨页系数比较与三角推导；旧候选评分缺陷由真实 Marker/Reviewer 修正，未由宿主改写学生分数。此验收是从未接纳草稿修正批改后单独续跑报告，并非空白冷启动一次通过；它证实该样本可走通，不构成模型评分准确率基准，也不代表其他真实模型、生产发布、持久 Worker 或全部 PR 交付完成。
