# 完整批卷持久组合验证

本轮承接 359dcb1，按用户对推进耗时的反馈，将来源、Script、Agent、转换和 Effect 放在同一应用组合中验收。主负责开发者 @xiaoxuanli-a；Codex 作者自查，未作独立审阅或远端发布。

先查看 Blackbox 的执行收据签发、接纳与后继状态提交、Effect 已保存回执复用和未知操作测试。复用其“事实保存后才接纳、可靠结果不重发”的边界；旧项目部分适配器支持 recovery 查询，本项目没有该能力的服务继续阻塞 pending，不直接照搬其重试调用。

## 实现

新增 createPersistentGradingApplication，显式注入存储、ScriptExecutor、Agent Driver、业务发布服务及当前策略。原始来源使用 Run 输入归档重开；用户 marker/fixer/返修路由保持。passed Gate 的 Script 使用当前同一评分源码生成 publication.json，独立 publishable-files contract 接到已实现的 JSON 读取器。普通宿主批卷与持久 Script 共用 publicationInput，评分规则未复制。

固定 Effect 复用持久日志。当前宿主审批核对 Run/Attempt、已接纳转换、恢复收据、passed Gate 和 Agent 前序来源，再要求当前 allowApply；只读加载不获取凭据、执行 Agent、审批或发布。应用没有增加第二个恢复状态机或业务数据库。

## 验收场景

10 项完整组合测试使用真实 Docker 任务与代理、实际 DeepSeek 不可变 API key Driver/Adapter、SQLite 和文件归档。测试镜像中的 dsh 是明确的协议替身，生成合成 candidate；从未调用官方模型。发布目标为当前测试根目录下 fsync 的 JSONL 文件，经真实 EffectExecutor 和 SqliteEffectRecordStore 协调。

- 正确批卷直接发布；错误初批经一次 fixer 返修后发布，内容总分为 5/7；来源篡改被拒绝；用户返修上限 0 时耗尽并拒绝，后二者没有发布写入。
- Agent 执行阶段、Gate 启动确认后、转换已接纳但发布尚未调用、Effect 回执已落盘但 Run 尚未接纳，分别强制 SIGKILL 宿主。删除源与临时副本后新进程恢复；已接纳步骤完全相同，当前任务使用同一 NodeTask 的 Attempt 2。
- Agent 中断时实际旧容器仍运行；恢复后旧资源不存在。发布前后的恢复不重新获取 Agent 凭据或调用 marker/fixer，已接纳转换收据保持原身份。
- Effect 回执已持久保存时复用 already-applied，外部写入总数仍为 1；外部写入已发生但回执未保存时返回 EFFECT_RESULT_UNKNOWN，不改 Run、不调用 Agent/审批/服务、不重复写入。
- 固定业务 key 变化在写库前拒绝；恢复时当前策略改为拒绝，返回 EFFECT_NOT_AUTHORIZED 且外部写入为 0。
- 完成后再次删源重开，load 的结果相同，Agent/凭据/审批/发布调用数均为 0。Agent 在副本中的输入修改不改变宿主原件。

首轮 0/10：新验收子进程未加载 TS 解析器，入口 import .js 无法解析到本地 TypeScript，在业务执行前失败。核对旧执行命令及本地既有夹具后，为子进程显式加载 tsx，同时将预期分数和 Effect 错误码对齐实际 contract。第二轮 8/10：两项调用计数读取了 HarnessTask 上不存在的 componentId，计为 null；实际流程已成功。先复核旧运行身份记录及本地 HarnessTask 边界，改从实际 Workflow 当前节点记录调用，不向 HarnessTask 添加业务字段。产品恢复或审批保护未放宽。

最终完整普通回归 352 项通过，0 失败/取消/跳过，约 13.82 秒；真实 Docker 回归 15 项通过，0 失败/取消/跳过，约 125.07 秒，包含本次 10 项完整组合和原 5 项文件 Script 流程。构建、测试类型、依赖边界和 diff 检查通过，当前正式 Markdown 的本地路径链接无缺失；没有把链接路径检查写成锚点或远端可达验证。

## #13 的剩余边界

本次完成的是合成批卷的持久组合，不是整个 Issue 关闭。存储/历史/提交/文件保留/定义/CAS/终止意图/Effect 的既有分层故障验证继续有效；这次补上它们在同一批卷流程中的来源和审批交接。订阅凭据来源的持久占用与刷新恢复仍须完成，不能把不可变 API key 组合扩称为全部 Harness 组合。机器重启与硬件断电、官方真实模型矩阵、真实学生试卷与报告/PDF、PR 审阅合入仍未完成或未覆盖。
