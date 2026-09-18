# Agent 版本探针资源验证

## 范围与依据

Issue #13，基线 56fc5e6，主负责开发者 @xiaoxuanli-a。按既有授权补齐认证获取前的版本探针资源端口，复用[持久化决定](../../.agents/agent_notes/product/README.md#p-20260909-run-persistence)。作者检查不代表独立审阅或完整 Agent 恢复验收。

先查 Blackbox v0.1.22 / 5610d1b 的 runners.py 中 credential-lease、preflight、容器执行与 finally 刷新收尾，credential_leases.py 的槽位锁及 f508c78 的撕裂写入修复。借鉴认证前检查和资源结束后的凭据收尾顺序；旧版 flock 释放不能作为新项目 Docker 停止证明，不复制 PID 解锁逻辑。新版独立版本 Runner 需要单独保存资源，不能只记录后续模型执行的容器。

## 实现与边界

三个认证 Runner 共享 versionProbeDefinition、restoreVersionResource 及 run 的独立第三参数 CredentialVersionResourceSink。探针定义包含实际固定镜像、断网 Docker 配置、实际命令、预期版本及 10 秒期限；Agent 执行定义升级为 agentflow-credential-execution/v2 并纳入该描述，旧试验 Agent 描述不会自动视为匹配。

探针通过共同 Runner 保存不可复用资源身份，再逐项提交准备、创建和启动日志。记录失败阻止后续操作；只有实际版本匹配、容器停止/移除、目录释放成功，才调用 complete，等待调用者提交阶段完成。该回调拒绝时返回 version 阶段失败，不能获取凭据。模型执行仍沿原认证组合运行，不另造调度器。

恢复端口先严格比较当前实际探针定义，再委托 Runner 核对私有归属标记及容器身份；只能查询、停止/移除、释放，不能重跑探针、读取凭据或继续 Agent。调用者仍须先取得恢复所有权，独立资源端口不是 Workflow 的认领接口。正常 Workflow 尚未接入该阶段记录，认证占用、后续执行资源及文件收据仍未接通；中断前临时 version-input 目录的跨进程释放仍需由后续完整生命周期处理，本测试在结束时显式清理自己的临时根目录。

## 验证

新增实际 Docker/SQLite/新进程测试：allocated、create_completed、start_completed、complete 暂停并 SIGKILL；工作目录丢失仍可清理旧探针；资源保存、启动记录或阶段完成拒绝均不获取凭据；探针预期版本、命令或身份改写拒绝；Docker 查询故障不能当作清理成功，重试可完成。测试凭据存储的全部方法均为禁止调用的替身，恢复和拒绝场景调用数为零。模拟 codex 只输出固定版本，没有真实模型调用。

既有 Codex 合成组合增加正常阶段日志顺序、完成时容器已缺失、与 Agent 定义中的探针描述一致的断言，再继续原有认证刷新和输出交接。三种 Agent 的定义测试检查探针与执行镜像相同、探针断网且命令来自同一配方。

初轮 12 项全部通过。最终 285 项普通测试通过（7.89 秒），63 项相关集成测试通过（116.86 秒），共 348 项，无失败、取消或跳过。相关回归包括三种合成 Agent 组合与定义、共同 Runner 资源、执行定义、Workflow 检查点与恢复（含 CONNECT 场景）。构建、测试类型检查、依赖边界、610 个本地文档链接与 git diff --check 通过。

这些是本地 Node 26 作者检查；未重跑完整原生 Harness / 登录矩阵，不代表 Node 24 CI 或独立审阅。没有实际凭据访问、模型服务调用、学生批卷或硬件断电验收。
