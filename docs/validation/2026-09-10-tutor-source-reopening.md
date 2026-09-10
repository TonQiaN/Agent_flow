# 批卷来源归档重开验证

本轮接续 cc1ccf2 文件 Script，先查看 Blackbox v0.1.22 / 5610d1b 中 Run 创建前 stage/store 输入、保存原始引用，以及 materialize_tree 的清单与逐文件核对顺序。选择复用当前 Run 首个输入归档，未新增来源存储或重复业务状态。

## 实现与边界

新增应用级 source.ts。prepareGradingSource 从实际 FileWorkflowCatalog 捕获 source-files，再取得原始摘要；相同 token 交给现有 startPersisted 归档并提交。readGradingSource 从受信 RunRecordStore 读取原始输入元数据，支持 checkpoint v5/execution v2 及现有 recovery v1 封套，核对身份、版本、初始位置、contract、空前序收据、引用与归档清单，返回整理后的原始摘要。

这不是第二个完整检查点加载器。它不恢复 token/收据、不执行历史程序、不确认文件字节完整、不认领和写库；完整加载与恢复接口继续负责其余事实和权限。应用据此安装当前代码，随后必须完整校验。原始摘要不从变化后的宿主源或 Agent 输出重算。

## 已执行验证

新增 4 项普通测试使用真实 FileArtifactStore、FileArtifactArchive、SQLite 和正常 Workflow 写出的检查点。删除原目录与临时快照后仍取得相同来源事实；返回值被修改不影响之后读取，Run 行不变。普通/恢复封套均可读取元数据，外部 Run 身份、旧格式、非初始值、无效引用/清单等拒绝。元数据与归档清单改变会不匹配；归档字节被改动时，元数据读取不冒充完整校验，随后真实完整加载拒绝且不改 Run。

首轮定向 5/6 通过：测试假定 claimRevision=3 必定越界，但正常写出的记录 revision 已超过 3，因此该封套合法地进入归档读取。先复核 Blackbox 清单/物化与本地记录，再将测试改为 revision+1 的实际越界值。产品校验未放宽；修正后 6 项定向通过，约 0.65 秒。

实际 Docker 验收夹具已移除额外 facts.json，所有重开均从 Run 的首个归档输入取得原始摘要。正常、返修、来源篡改和 Gate running 时宿主 SIGKILL 四项继续通过。新增首个 Run 行刚提交后的 SIGKILL：确认 queued 且无 Attempt，删除全部原输入与执行临时目录，新的进程按正常接口执行 intake/marker/gate，均为 Attempt 1，结果 passed，无旧资源需恢复。再次独立加载结果相同且不执行任何节点。

最终 5 项真实 Docker 验收全部通过，约 21.06 秒，0 失败、取消、跳过。marker/fixer 仍为罐装候选 Script；未调用真实模型、凭据或学生数据。最终 340 项普通回归全部通过，约 10.55 秒，0 失败、取消、跳过。定向测试为普通测试子集，不相加。构建、测试类型、包边界、本地文档路径与 diff 校验通过；链接不验证锚点或远端。

## 剩余范围

已提供来源准备/读取接口并接入实际 Script 验收，但原 createGradingApplication 整条流程尚未改造。下一步优先文件到 JSON 的实际绑定和耐久转换收据，再接固定 Effect、当前审批与实际 Agent 的联合恢复，最后继续订阅与 #13 剩余验收。#13、真实批卷、报告和 PDF 不因此完成。作者验证，不代表独立审阅、Node 24 CI 或硬件断电测试。

[来源指南](../guides/tutor-source-reopening.md) · [Script 验证](2026-09-10-tutor-file-scripts.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
