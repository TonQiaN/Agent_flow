# 仓库结构图

当前能力与未完成范围见 [文档入口](../README.md)。两类决策各自拥有完整生命周期目录；空生命周期目录使用 .gitkeep 保留。实现源码统一在根 src 内，应用和包按实际能力创建。

```text
Agent_flow/
├── AGENTS.md                      # 项目范围的执行入口
├── CLAUDE.md -> AGENTS.md
├── README.md
├── CHANGELOG.md                   # 实际变化、Unreleased 与发布记录
├── package.json / package-lock.json # npm workspaces 与固定依赖
├── tsconfig*.json                 # 共享严格构建与独立测试检查
├── src/
│   ├── apps/cli/                  # demo 与显式本地认证管理/登录命令
│   ├── apps/studio/               # 本机 HTTP 展示/启动服务及受信镜像定义
│   ├── packages/domain/           # 业务类型与执行身份
│   ├── apps/deepseek-tools/        # 容器内文件服务，使用镜像提供的 SDK
│   ├── packages/engine/           # contracts、components、workflow、runner、harness/auth/persistence 接口；无环境依赖
│   ├── packages/integrations/     # Docker、CONNECT 代理、三个 Harness 映射/parser、私有凭据存储/绑定、SQLite 状态存储、系统时钟
│   ├── examples/                  # 合成示例入口
│   ├── tests/                     # e2e 跨模块测试、fixtures 合成子进程
│   └── tooling/                   # 依赖边界与测试发现工具
├── .agents/decisions/
│   ├── README.md
│   ├── AGENTS.md                  # 决策目录的操作约束
│   ├── CLAUDE.md -> AGENTS.md      # 共用同目录指令正文
│   ├── TEMPLATE.md
│   ├── product/
│   │   ├── README.md              # 稳定 ID → 正文位置
│   │   ├── proposed/
│   │   ├── implemented/
│   │   ├── archived/
│   │   └── rejected/
│   └── development/              # 与 product 相同的生命周期树
├── .github/
│   ├── ISSUE_TEMPLATE/           # 功能、缺陷、研究、决策、维护五份完整表单与配置
│   ├── workflows/check.yml       # Node 24/26 CI，含真实 Docker 用例
│   └── PULL_REQUEST_TEMPLATE.md  # Issue、决策增量、验收与评审交接
├── docs/
│   ├── README.md
│   ├── architecture/README.md
│   ├── guides/README.md
│   ├── development/
│   │   ├── code-structure.md     # 当前源码组织、依赖边界与工程命令
│   │   ├── documentation.md
│   │   ├── materials.md          # 本地原始资料、Git 边界与飞书 CLI 共享
│   │   ├── workflow.md           # 当前协作流程、模板及能力边界
│   │   ├── issue-templates.md    # 五类选择、填写、CLI/API 与同步维护
│   │   └── versioning.md         # Roadmap、变更记录及手工发布维护
│   ├── roadmap/README.md         # 当前规划；具体版本文件按需创建
│   ├── reference/repository-map.md
│   ├── validation/               # 实际执行的验证结果与局限
│   └── postmortems/              # 永久保留的重大事故复盘
└── materials/
    ├── AGENTS.md                 # 本区的保存、检索与团队共享规则
    ├── CLAUDE.md -> AGENTS.md
    ├── README.md                 # 入口；不要求全量文件索引
    ├── .gitignore                # 原始内容忽略，仅五份根级管理文件入库
    ├── .ignore                   # 默认 rg 可发现管理文件，避开原始正文
    └── …                         # 仅本地、自由组织；选定资料通过飞书 CLI 共享
```

正式开发以 Issue 为工作起点，按对应决定及当前说明执行。原始资料可由研究任务提炼进决定，但正式决定不依赖原始资料路径；原始区内部结构不在本图管理。

目录、职责或开发入口变化时，负责该改动的开发者同步本图、根 AGENTS.md 的简图、[工程指南](../development/code-structure.md) 与相关使用指南。尚未建立的入口须明确标为占位，实际落地后及时替换。

[生命周期定义](../../.agents/decisions/development/README.md#d-20260907-decision-lifecycle) · [文档操作](../development/documentation.md) · [开发工作指南](../development/workflow.md)

`src/packages/integrations/workflow` 提供文件函数/Agent 与串行 Workflow 的本机连接、私有文件来源引用及失败资源清理；核心编译器与运行控制留在 `engine/workflow`。

`engine/components/script-executor` 保存一次脚本执行及纯结果协议，`integrations/execution/script-record-reader` 执行停止后原始文件读取；`integrations/workflow` 复用文件契约和来源引用接纳脚本产物。

`engine/components/effect-executor` 与 `engine/workflow/effects` 分开保存操作授权/幂等接纳和 Workflow 适配；`integrations/effects/simulated-service` 只提供内存模拟目标，不接触 Harness 凭据。

耐久文件端口位于 `src/packages/engine/persistence/artifacts.ts`，本地实现位于 `src/packages/integrations/artifacts/file-archive.ts`；与临时 store 共用内部 `snapshot-io.ts`，归档没有临时释放生命周期。见[归档指南](../guides/artifact-archive.md)。

`src/packages/engine/workflow/structure.ts` 从受信编译计划导出结构与实际契约，供后续持久化核对；不负责 Runner 环境或执行恢复。见[结构指南](../guides/workflow-structure.md)。

`src/packages/engine/workflow/execution.ts` 组合实际执行绑定描述；脚本环境由 `ScriptExecutor` 和具体 backend 提供，engine 不解析 Docker 配置。见[执行绑定指南](../guides/workflow-execution-snapshot.md)。

`src/packages/engine/workflow/checkpoint.ts` 组合实际定义、流程状态和值保存端口；runtime.ts 的普通与持久入口共用执行循环。具体文件归档留在 integrations/workflow/files.ts，见[指南](../guides/workflow-checkpoints.md)。

`src/examples/studio` 登记原有入口；`src/examples/recruitment` 保存招聘应用、离线材料解析和虚构素材。`integrations/observability` 保存查看记录与脱敏日志，不执行回放。
