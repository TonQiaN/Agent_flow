# 项目文档

这里说明项目当前是什么、怎样使用、怎样验证；roadmap 是明确标识的当前规划区域。决定及其取舍只在 .agents/decisions 维护；materials 是独立的宽松原始资料区。

**当前状态：可运行确定性 Component、JSON contract、Docker Runner 与受控 CONNECT 联网、独立 Harness 计划/parser、文件契约与快照交接、Agent 接纳与进程内可信收据、私有凭据存储/执行绑定。串行 Workflow 编译/路由/有界返修及 JSON 函数、文件函数、Agent 接纳、确定性脚本、文件到 JSON 转换及模拟 Effect 适配已实现；Tutor 合成批卷已接通 Gate、返修和模拟发布，真实 Codex 也已通过同一合成材料的正常及返修流程。持久化、队列、重试和并行尚未完成；真实刷新、真实学生批卷、完整报告和 PDF 尚未验收。**

| 入口 | 内容 |
| --- | --- |
| [架构](architecture/README.md) | 当前边界与尚待设计的问题 |
| [使用指南](guides/README.md) | 当前仓库用法与未来用户指南入口 |
| [仓库结构图](reference/repository-map.md) | 正式目录职责，原始区只列边界 |
| [文档维护](development/documentation.md) | 决策的查找、记录、转换及校验 |
| [开发工作指南](development/workflow.md) | Issue 整理、预检记录、PR 模板与当前能力边界 |
| [Issue 分类与填写](development/issue-templates.md) | 五类表单、共同信息、仅决策交付与网页 / CLI / API 用法 |
| [Roadmap](roadmap/README.md) | 阶段方向、版本安排与按需版本计划 |
| [Changelog](../CHANGELOG.md) | 已实现的变化与发布记录 |
| [版本维护](development/versioning.md) | 版本规划、PR 变更记录和手工发布步骤 |
| [验证记录](validation/README.md) | 已执行检查、结果与局限 |
| [重大事故复盘](postmortems/README.md) | 永久保留的影响、根因、遗漏与修正 |
| [决策索引](../.agents/decisions/README.md) | 期望与理由的权威入口 |

规划与当前行为明确区分。功能落地后再更新操作示例和验证事实，不因决定已接受就写成已实现。

[Claude Adapter](guides/claude-adapter.md) 已实现 2.1.226 的独立调用计划、协议解析和真实无凭据离线启动验证；其订阅组合已通过合成刷新与文件交接、真实 CLI 断网格式识别；实际工具隔离已有断网合成服务驱动真实 CLI 的回归，真实任务仍未验收，见 [组合入口](guides/claude-execution.md)。DeepSeek 当前进展见下方记录。

[DeepSeek 配置预检](validation/2026-09-09-deepseek-compatibility.md) 已验证工具开关和原生会话；默认文件策略无法满足固定目录，下述自有工具隔离层处理了这一限制。

[DeepSeek 原生文件隔离](validation/2026-09-09-deepseek-file-isolation.md) 已允许固定输入副本/输出写入并保护私有文件；[Bash 与搜索隔离](validation/2026-09-09-deepseek-process-isolation.md) 也已通过真实 CLI 的合成测试。

[DeepSeek 私有会话解析](validation/2026-09-09-deepseek-session.md) 已通过原生日志及反例验证；[固定启动与图像交接](validation/2026-09-09-deepseek-launch.md) 也已通过合成私有密钥的真实 CLI 验证；[纯 Adapter 和结构化出口](guides/deepseek-adapter.md) 已接通并通过原生 CLI 合成验证，[API key 与不可变快照绑定](validation/2026-09-09-deepseek-api-key.md) 已通过宿主存储驱动的原生 CLI 验证，[宿主执行组合](validation/2026-09-09-deepseek-execution.md) 已接通并通过协议替身验收，真实官方模型调用仍未验收。

[凭据环境注入](validation/2026-09-09-credential-environment.md)已消除 DeepSeek 任务密钥文件，恢复与 Issue #11 的环境注入要求一致；[交互录入与本地管理](guides/auth-management.md)已实现；订阅登录及有限备份恢复已有后续实现记录。

[订阅登录协调](guides/subscription-login.md)已具备首次登录管理租约和可恢复的收尾接口；原生登录驱动已在后续切片接入，有限备份恢复已在后续切片实现，真实登录继续验收。

[原生订阅登录驱动](guides/subscription-login.md)已接入私有交互与受控 Docker；已做合成验证，真实官方登录继续验收，CLI 入口已由后续切片接入。

[订阅终端登录](guides/subscription-login.md)已接入显式参数、隐藏授权码、取消与本地检查/删除；有限备份恢复已有后续验证，真实订阅继续验收。

[私有备份恢复](guides/credential-recovery.md)已支持完整身份与版本前缀的尾部截断，拒绝回滚健康文件或复活已删除凭据；真实认证矩阵仍待验收。

[Run 记录存储](guides/run-record-store.md)已提供 SQLite/CAS 基础；已接入下述正常运行检查点，断网脚本恢复见下方。

[耐久文件归档](guides/artifact-archive.md)已支持跨进程文件引用及独立可写物化；检查点文件恢复见下方，断网脚本恢复见下方。

[Workflow 结构快照](guides/workflow-structure.md)已支持实际契约导出和一致性核对；断网脚本绑定见下方，其他执行绑定及节点恢复仍待接入。

[脚本执行绑定快照](guides/workflow-execution-snapshot.md)已接通实际命令与断网 Docker 镜像冻结；正常运行检查点已接入，断网脚本恢复见下方。

[Workflow 检查点](guides/workflow-checkpoints.md)已接入共享正常执行、耐久文件值与异步取消确认；断网脚本恢复见下方。

[检查点加载与文件恢复](guides/workflow-checkpoint-loading.md)：实际定义、历史和收据核对，独立文件副本与失败回滚；断网脚本恢复见下方。

[Runner 资源保存与恢复](guides/runner-resource-recovery.md)：实际资源先落盘、跨进程核对及停止/移除；Workflow 新 Attempt 恢复见下方。

[Workflow Attempt 资源检查点](validation/2026-09-10-workflow-attempt-resources.md)：资源接入正常 Workflow CAS，启动前核对以及真实中断后的共同 Runner 清理；同一 NodeTask 的新 Attempt 已通过一次/连续两次 SIGKILL 恢复，见[验证](validation/2026-09-10-workflow-resume.md)。

[Runner 启动操作记录](validation/2026-09-10-runner-launch-journal.md)：正常 Workflow 的前后 CAS、异步启动观测和真实中断边界，尚未开放自动恢复。

[Workflow 恢复认领与旧资源清理](guides/workflow-recovery.md)：同一 Run CAS、并发与崩溃后接管、只读检查；同一 NodeTask 的新 Attempt 已通过一次/连续两次 SIGKILL 恢复，见[验证](validation/2026-09-10-workflow-resume.md)。

[Agent 执行定义](guides/workflow-execution-snapshot.md)：实际 Harness、用户说明、运行资产及非秘密 Profile，执行/代理镜像固定并用于后续运行；Agent 资源与认证恢复仍待接通。

[联网资源恢复](validation/2026-09-10-network-resource-recovery.md)：无私有认证的 CONNECT Script 经共同 Runner 核对并清理任务容器、代理与网络，再进入正常新 Attempt；Agent 认证恢复仍待完成。

[Agent 版本探针资源](validation/2026-09-10-version-resource-recovery.md)已接通独立记录与共同 Runner 清理；完整 Agent 认证/执行恢复仍待接入。

[不可变 API key 执行资源](validation/2026-09-10-credential-resource-recovery.md)可在不读取或恢复旧密钥的情况下独立清理；完整 Agent Workflow 和订阅占用仍待接通。

[Workflow 通用阶段](guides/workflow-phases.md)已通过真实容器多次中断恢复；Agent Driver/Catalog 与文件收据仍未接入。

[实际 Agent Workflow](validation/2026-09-10-agent-workflow.md)已接通不可变 API key 的阶段记录与文件收据，以 DeepSeek 合成协议验证 A 保留、B 多次中断恢复；订阅和宿主临时目录崩溃收尾仍待完成。

[Runner 输入物化](guides/runner-owned-input.md)已消除版本探针和 Agent Driver 的外部输入临时目录；Catalog 等其他临时目录的崩溃收尾仍待完成。

[Catalog 输入复用](validation/2026-09-10-catalog-snapshot-input.md)已消除同存储 Agent 的 node 输入目录和重复输入快照；其他临时目录及订阅恢复仍待完成。

[直接存储交接](validation/2026-09-10-direct-artifact-capture.md)已省掉内置组合的 Catalog checkpoint/restore 中间目录；目标存储未发布暂存及旧进程临时快照仍待处理。

[Effect 持久操作日志](validation/2026-09-10-effect-journal.md)已通过真实进程中断和竞争验证，已确认回执可复用、未知操作不重发；Workflow 接线仍待完成。

[Effect Workflow 恢复](validation/2026-09-10-effect-workflow.md)已接通固定操作的 apply、实际定义和日志身份比较、严格回执核对及新 Attempt；动态映射、其他绑定和完整 #13 仍待完成。

[确定性 JSON 函数](guides/deterministic-functions.md)已接通版本/配置快照和无资源节点恢复；普通函数、文件函数及完整 #13 仍有验收缺口。

[批卷文件 Script](guides/tutor-file-scripts.md)已接通 intake/Gate 的实际执行及中断恢复验证；整条批卷持久组合仍待接线。

[批卷来源重开](guides/tutor-source-reopening.md)已复用 Run 的首个输入归档；完整批卷持久组合继续接线。

[指定 JSON 文件转换](guides/json-file-projection.md)已支持持久执行与来源收据恢复；已接纳转换不重跑，普通宿主回调仍不支持持久恢复。
