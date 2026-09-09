# Runner 目录内输入物化验证

本轮处理 Issue #13 中版本探针和 Agent Driver 的外部输入临时目录。改为在已登记的 Runner 资源工作目录内物化，继续通过原输入复制器校验并生成独立可写 input。Catalog 和独立临时 ArtifactStore 的其他目录仍未完成崩溃收尾。

先检查 Blackbox artifacts.py 的 materialize_tree：其原子物化暂存位于目标父目录；同时核对当前 Runner 保存资源后才 prepare 的顺序。本实现把目标父目录设为已登记资源目录，复用共同释放能力，没有新增目录扫描 GC、文件名前缀归属推断或调度器。用户要求的可写输入与原文件隔离继续保留。

## 实现

RunnerRequest 允许显式 null 输入。DockerBackend 未安装物化能力时创建空 input；安装 RunnerInputMaterializer 时，先物化到资源内的 input-source，再经原复制校验得到 input，成功后删除暂存。方法在安装时固定，不能与路径输入同时指定；能力不进入请求 JSON、检查点或恢复导入。

CredentialHarnessRunner 的探针不再创建 version-input 目录；Driver 直接提供已捕获 ArtifactStore 快照的物化能力，不再创建独立 input 目录。Driver 配置移除 inputRoot，只保留 timeoutMs，三类 Driver、仓库示例和调用测试已同步。认证运行器在首次异步等待前固定所提供的方法，源路径调用仍保持原 API 行为；null 请求须有明确物化能力。

持久资源记录和 prepare pending 在物化前提交。物化失败阻止创建/启动，部分写入及相邻原子暂存仍位于同一资源目录中，正常或恢复 release 统一清理。未知 prepare pending 仍拒绝自动认领；旧资源恢复不需要原物化能力。

## 已执行检查

本地 Node 26、Docker Alpine 和三类合成 Harness 组合；没有真实凭据、官方模型或学生材料。

- 普通测试 295 项通过，0 失败、取消、跳过，约 8.08 秒。
- 输入与 Agent 组合 16 项通过，0 失败、取消、跳过，约 83.71 秒。包含 5 项新输入测试、8 项强化的实际 Agent Workflow 测试及 3 类 Agent 组合。
- 相关 Docker 回归 42 项通过，0 失败、取消、跳过，约 50.70 秒。覆盖新输入、版本探针、不可变凭据资源、实际 Agent 定义、Runner 资源恢复及 Script Workflow。与上一轮的 5 项输入测试重叠，不应相加。

新输入测试验证：真实 ArtifactStore 物化目标位于已提交资源目录，调用时已记录 prepare pending；替换原对象方法不能改变安装后的能力；容器改写 input 不改变宿主源文件；正常释放移除资源目录。空 input 可写且开始为空。部分物化失败、目标根符号链接及路径/能力冲突都使 prepare 失败，不启动进程；释放后原文件仍保持原内容。

实际 Agent Workflow 的 SIGKILL 验证覆盖版本阶段、B 执行阶段和连续两次中断；断言不存在 Driver 输入根及 version-input 临时目录，恢复后每个已记录旧 Runner 工作目录都不存在。已完成 A、可信收据和最终 sum=6 保留。失败后的显式清理及三类 Agent 正常/失败/刷新组合也通过。

实现与首轮测试没有产品失败。审阅时把空输入测试的 shell 断言改为成功后才继续写入，避免后续命令掩盖前一个断言的状态；42 项回归包含这项强化。

构建、测试类型检查、包边界、648 个本地文档链接与 diff 检查通过。

## 未覆盖范围

Catalog 的 node/checkpoint/restore 目录、独立临时 ArtifactStore 快照、资源分配但尚未登记的窗口仍待处理；旧外部目录不会按前缀扫描删除。测试最终删除自有测试根不作为这些缺口已解决的证据。订阅占用接管、完整 #13、真实模型恢复与真实批卷报告/PDF 仍未验收。上述为作者检查，不代表独立审阅或 Node 24 CI。

[输入指南](../guides/runner-owned-input.md) · [持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence)
