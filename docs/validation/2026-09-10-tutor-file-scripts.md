# 批卷文件 Script 与中断恢复验证

本轮基于 a5de755 的链路预检，落实 intake/Gate 的实际 Script 绑定。先查看 Blackbox v0.1.22 / 5610d1b 的 CommandRunner/DockerRunner、持久前序收据及重绑定拒绝测试；采用本项目现有共同 Runner 和可写隔离输入，不复制旧只读输入约束。

## 实现

`gradingFileScripts` 在读取安装程序前验证并复制三个原始来源摘要；摘要作为独立 argv 数据，程序来自实际 `gate.ts` 经宿主移除 TypeScript 类型后的字节。原宿主 review 与容器使用同一评分实现，只将 review 的类型依赖缩小到实际使用的输入/输出路径和来源摘要。实际程序、参数、期限沿 ScriptDefinition 保存；不增加引擎业务逻辑、恢复状态机、泛化宿主进程管理或历史代码执行入口。

生成器返回 intake 与 Gate 定义。测试在真实 FileWorkflowCatalog 中注册，并通过 SQLite、FileArtifactArchive 与实际 DockerBackend 运行。文件 contract、来源检查、评分、outcome 和用户设置的一次返修上限都沿原边界处理。

## 已执行验证

新增 2 项普通测试：来源摘要完整性/唯一性/格式、构造时复制及固定 argv 参数，当前实际评分源码生成。原有 Tutor 正常、返修、来源篡改和审批回归保留。

新增 4 项 Docker 端到端测试。正常候选通过；错误候选经一次返修后通过；被修改的答案来源拒绝，原宿主文件保持原内容。每步保存真实 Script imageId/身份收据。结束后删除源文件和临时执行空间，新进程只靠保存的 Run、归档与原来源事实重新加载，报告与已接纳步骤一致，未启动任何新节点。

中断场景先接纳 intake 和罐装初批候选，在 Gate 容器确认 running 后 SIGKILL 宿主。改变可信原始摘要参数时一致性检查拒绝，未启动或恢复资源；恢复相同参数后删除原输入与 Catalog 临时目录，通过共同 Runner 确认移除旧 Gate 容器，再以 task-3 的 Attempt 2 执行 Gate、返修和复核。原 intake/marker 步骤保持相同，最终无评分问题，新的进程可再次加载完整结果。

首轮 3/4 项通过。恢复用的测试 Backend 包装器只向父方法转发一个参数，遗漏 identity/resource，导致正常资源校验拒绝；查阅 Blackbox 回执/收尾测试及本项目实际恢复接口后，修正为完整转发参数。产品恢复规则未放宽。最终 4/4 通过，约 18.56 秒，0 失败、取消、跳过。测试 marker/fixer 是确定的候选文件 Script，不是真实 Agent 或模型。

最终 336 项普通回归全部通过，约 10.21 秒，0 失败、取消、跳过。此前 10 项定向测试通过，属于普通测试子集，不相加。构建、测试类型、包边界、文档本地路径与 diff 检查通过；路径检查不含锚点和远端。没有真实凭据或业务服务调用。本轮为作者验证，未执行独立审阅、Node 24 CI 或硬件断电测试。

## 未完成

当前构造器要求调用方提供可信原始来源事实；测试在自己的临时根中预先保存这些事实，尚未交付应用级 Run 创建/重开协议。createGradingApplication 仍是原普通流程；文件到 JSON 收据、固定 Effect/当前审批、实际 Agent 和订阅的完整持久组合继续接线。#13 以及真实学生批卷、报告、PDF 不因此完成。

[使用指南](../guides/tutor-file-scripts.md) · [前序预检](2026-09-10-tutor-persistence-preflight.md) · [持久化决定](../../.agents/agent_notes/product/README.md#p-20260909-run-persistence)
