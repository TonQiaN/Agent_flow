# 验证记录

- [Tutor 报告消费端](2026-09-10-tutor-report-consumer.md)：真实业务 validator/renderer、合成扫描页及三页 A3 PDF。

- [JSON Map/Fork 作者验收](2026-09-10-json-parallel.md)：有序汇合、共享容量、部分恢复与真实 Docker 隔离。

- [Codex 临时元数据权限与启动](2026-09-09-codex-startup.md)

这里记录实际执行的项目验证：对象和版本/范围、环境与方法、结果、限制及关联决定。大体积输出不必原样复制，但关键证据和结论必须在正式记录中自足。

| 日期 | 记录 |
| --- | --- |
| 2026-09-09 | [订阅登录管理与协调](2026-09-09-subscription-login-coordination.md) |
| 2026-09-09 | [本地认证管理与真实终端验证](2026-09-09-auth-management.md) |
| 2026-09-09 | [凭据环境注入与 DeepSeek 无密钥文件执行](2026-09-09-credential-environment.md) |
| 2026-09-09 | [基础四项验收缺口核对](2026-09-09-foundation-acceptance-audit.md) |
| 2026-09-09 | [DeepSeek 宿主执行与文件交接](2026-09-09-deepseek-execution.md) |
| 2026-09-09 | [DeepSeek API key 与不可变快照交接](2026-09-09-deepseek-api-key.md) |
| 2026-09-09 | [DeepSeek Adapter 与结构化出口](2026-09-09-deepseek-adapter.md) |
| 2026-09-09 | [DeepSeek 固定启动与图像交接](2026-09-09-deepseek-launch.md) |
| 2026-09-09 | [DeepSeek 私有会话采集与原生完成证据](2026-09-09-deepseek-session.md) |
| 2026-09-09 | [DeepSeek 统一工具进程隔离](2026-09-09-deepseek-process-isolation.md) |
| 2026-09-09 | [DeepSeek 原生文件服务隔离](2026-09-09-deepseek-file-isolation.md) |
| 2026-09-09 | [DeepSeek 配置与原生能力预检](2026-09-09-deepseek-compatibility.md) |
| 2026-09-09 | [Claude 调用计划与协议](2026-09-09-claude-adapter.md) |
| 2026-09-09 | [真实 Codex 批卷 Workflow](2026-09-09-tutor-grading-codex.md) |
| 2026-09-09 | [Tutor 合成闭环与文件转换](2026-09-09-tutor-grading-fixture.md) |
| 2026-09-09 | [模拟 Effect](2026-09-09-workflow-effects.md) |
| 2026-09-09 | [确定性脚本 Workflow](2026-09-09-workflow-scripts.md) |
| 2026-09-09 | [Workflow 文件与 Agent 交接](2026-09-09-workflow-files.md) |
| 2026-09-09 | [Agent 接纳与可信收据](2026-09-09-agent-acceptance.md) |
| 2026-09-09 | [文件契约与快照交接](2026-09-09-file-contracts.md) |
| 2026-09-09 | [Codex 订阅组合入口](2026-09-09-codex-composition.md) |
| 2026-09-09 | [私有凭据执行绑定](2026-09-09-credential-binding.md) |
| 2026-09-09 | [受控 CONNECT 联网](2026-09-09-controlled-egress.md) |
| 2026-09-09 | [真实 Codex 内部沙箱与只读配置](2026-09-09-codex-sandbox.md) |
| 2026-09-09 | [Harness / 认证接口与私有存储验证](2026-09-09-harness-auth-primitives.md) |
| 2026-09-09 | [Docker Runner 脚本验证](2026-09-09-docker-runner.md) |
| 2026-09-09 | [执行基础验证](2026-09-09-execution-foundation.md) |
| 2026-09-08 | [Issue 模板实施验证](2026-09-08-issue-templates.md) · [12 个填写与边界演练](2026-09-08-issue-template-examples.md) |
| 2026-09-08 | [七份 Issue 模板决定设计验证](2026-09-08-issue-template-decisions.md) |
| 2026-09-08 | [版本管理骨架验证](2026-09-08-version-management.md) |
| 2026-09-07 | [文档管理骨架验证](2026-09-07-documentation-foundation.md) |
| 2026-09-07 | [开发流程文档与模板验证](2026-09-07-development-workflow.md) |

当前产品验证覆盖确定性 Component、Docker Runner 与受控联网、Harness parser 与凭据存储，包含首个真实 Codex 小任务、文件交接、串行 Workflow、文件到 JSON 转换及 Tutor 合成 Agent/Gate/Fixer/模拟 Effect 闭环；真实 Codex 已完成一份学生样本的分阶段批卷、报告和18页 PDF 验收，具体范围见多页学生记录。正式重大事故复盘见 [复盘入口](../postmortems/README.md)。

- [Workflow 编译与串行控制](2026-09-09-workflow-serial.md)

- [Claude 订阅执行、刷新与真实格式识别](2026-09-09-claude-execution.md)

- [Claude 管理配置修复与实际工具隔离](2026-09-09-claude-tool-isolation.md)

- [原生订阅登录驱动](2026-09-09-native-subscription-login.md)：两个独立驱动、私有交互、合成 Docker 故障恢复与原生离线帮助。

- [订阅终端登录](2026-09-09-subscription-login-cli.md)：真实 PTY、编译 CLI、合成 Docker 登录、取消及持续清理失败。

- [凭据备份恢复](2026-09-09-credential-recovery.md)：尾部截断、删除与版本隔离、旧记录规范化及真实进程崩溃。

- [矩阵当前验收核对](2026-09-09-matrix-readiness.md)：认证缺口闭合、共用业务入口和剩余真实证据。

- [DeepSeek 偶发超时诊断](2026-09-09-deepseek-timeout-diagnostics.md)：操作/子进程证据、有界重复检查及失败捕获保留。

- [Run 记录存储验证](2026-09-09-run-record-store.md)：多进程 CAS、提交前后 SIGKILL 和损坏拒绝。

- [耐久文件归档](2026-09-10-artifact-archive.md)：删除原始/临时材料后新进程恢复、并发发布与 SIGKILL。

- [Workflow 结构快照](2026-09-10-workflow-structure.md)：SQLite 重开核对、同名 schema 冲突及嵌套文件契约。

- [断网脚本执行绑定及阶段复盘](2026-09-10-script-execution-binding.md)：实际镜像冻结、标签删除后执行及后续 checkpoint 主线。

- [DeepSeek 文件取消收尾](2026-09-10-deepseek-file-cancellation.md)：launcher 退出而后代持有管道的确定性反例、专属进程组终止与真实文件隔离回归。

[共享 Workflow 检查点](2026-09-10-workflow-checkpoints.md)：提交顺序、取消落盘、写入故障与真实宿主 SIGKILL 后的归档读取。

[严格检查点加载与文件引用恢复验证](2026-09-10-workflow-checkpoint-loading.md)：实际定义、历史和收据核对，独立文件副本与失败回滚；重启执行仍待接通。

[Runner 资源保存与实际中断验证](2026-09-10-runner-resource-recovery.md)：实际资源先落盘、跨进程核对及停止/移除；Workflow 新 Attempt 恢复仍待接通。

[Workflow Attempt 资源检查点](2026-09-10-workflow-attempt-resources.md)：资源接入正常 Workflow CAS，启动前核对以及真实中断后的共同 Runner 清理；新 Attempt 执行仍待完成。

[Runner 启动操作记录](2026-09-10-runner-launch-journal.md)：正常 Workflow 的前后 CAS、异步启动观测和真实中断边界，尚未开放自动恢复。

[Workflow 恢复认领与旧资源清理](2026-09-10-workflow-recovery-claim.md)：同一 Run CAS、并发与崩溃后接管、只读检查；新 Attempt 执行仍待完成。

- [Workflow 新 Attempt 恢复](2026-09-10-workflow-resume.md)：保留中断历史，共享正常执行路径，真实连续 SIGKILL。

- [Agent 实际执行定义](2026-09-10-agent-execution-binding.md)：非秘密 Profile、实际 Harness/资产与固定执行及代理镜像。

- [联网 Runner 资源恢复](2026-09-10-network-resource-recovery.md)：完整资源归属、部分清理重试及 CONNECT Workflow 新 Attempt。

[Agent 版本探针资源](2026-09-10-version-resource-recovery.md)已接通独立记录与共同 Runner 清理；完整 Agent 认证/执行恢复仍待接入。

[不可变 API key 执行资源](2026-09-10-credential-resource-recovery.md)可在不读取或恢复旧密钥的情况下独立清理；完整 Agent Workflow 和订阅占用仍待接通。

[Workflow 通用阶段记录与恢复](2026-09-10-workflow-phases.md)记录本轮验证和未完成边界。

[实际 Agent Workflow 阶段与文件收据](2026-09-10-agent-workflow.md)。

[Runner 目录内输入物化验证](2026-09-10-owned-runner-input.md)。

[Catalog 借用输入快照验证](2026-09-10-catalog-snapshot-input.md)。

[直接物化归档与恢复验证](2026-09-10-direct-artifact-capture.md)。

[Effect 持久日志与进程中断验证](2026-09-10-effect-journal.md)。

[固定操作 Effect Workflow 恢复验证](2026-09-10-effect-workflow.md)。

[确定性 JSON 函数绑定与恢复验证](2026-09-10-function-binding.md)。

[Tutor 持久验收链路预检](2026-09-10-tutor-persistence-preflight.md)。

[批卷文件 Script 与中断恢复](2026-09-10-tutor-file-scripts.md)。

[批卷来源归档重开验证](2026-09-10-tutor-source-reopening.md)。

- [JSON 文件转换与来源恢复](2026-09-10-json-file-projection.md)：子进程中断、收据恢复、定义漂移、并发与回滚验证。

- [完整批卷持久组合](2026-09-10-persistent-tutor-grading.md)：真实容器的 Agent、Gate、转换与发布中断联合验证。

[订阅资源恢复](2026-09-10-subscription-resource-recovery.md)；[Issue #13 验收对照](2026-09-10-issue13-acceptance.md)。

[单机队列与 Worker 验证](2026-09-10-node-queue.md)：多进程容量竞争、实际迟到写入与 Docker 失联恢复；包含认证源预占、实际 Driver 绑定及联合恢复验收。

- [节点有限重试与持久等待](2026-09-10-node-retries.md)

- [2026-09-10 Tutor 扫描件批改与报告串接](2026-09-10-tutor-scanned-marking.md)：合成来源、复核哈希/质量、用户返修和 PDF。

- [Codex 初始图片执行验证](2026-09-10-codex-input-images.md)：参数、manifest、既有 Docker 组合及真实扫描件尝试。

- [多页学生输入接线](2026-09-10-tutor-student-input.md)：显式材料与预算、准备失败收尾、存储/容器及完整消费端回归；已完成真实 Codex 整卷、独立复核、报告单独续跑及18页 PDF 验收。
