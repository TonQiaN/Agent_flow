# 仓库结构图

状态：2026-09-09 执行基础、Docker Runner、受控联网与独立 Harness/认证、Agent 接纳及串行 JSON Workflow、Run 记录存储切片。两类决策各自拥有完整生命周期目录；空生命周期目录使用 .gitkeep 保留。实现源码统一在根 src 内，应用和包按实际能力创建。

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
│   ├── packages/domain/           # 业务类型与执行身份
│   ├── apps/deepseek-tools/        # 容器内文件服务，使用镜像提供的 SDK
│   ├── packages/engine/           # contracts、components、workflow、runner、harness/auth/persistence 接口；无环境依赖
│   ├── packages/integrations/     # Docker、CONNECT 代理、独立 Harness、私有凭据存储/绑定、SQLite 状态存储、系统时钟
│   ├── examples/                  # 合成示例入口
│   ├── tests/                     # e2e 跨模块测试、fixtures 合成子进程
│   └── tooling/                   # 依赖边界与测试发现工具
├── .agents/decisions/
│   ├── README.md
│   ├── AGENTS.md                  # 决策目录的操作约束
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
│   │   ├── documentation.md
│   │   ├── workflow.md           # 当前协作流程、模板及能力边界
│   │   ├── issue-templates.md    # 五类选择、填写、CLI/API 与同步维护
│   │   └── versioning.md         # Roadmap、变更记录及手工发布维护
│   ├── roadmap/README.md         # 当前规划；具体版本文件按需创建
│   ├── reference/repository-map.md
│   ├── validation/               # 实际执行的验证结果与局限
│   └── postmortems/              # 永久保留的重大事故复盘
└── materials/
    ├── README.md                 # 入口；不要求全量文件索引
    ├── .ignore                   # 默认 rg 不读取内部材料
    └── …                         # 自由组织，可含 artifacts、会议、录音等
```

正式开发以 Issue 为工作起点，按对应决定及当前说明执行。原始资料可由研究任务提炼进决定，但正式决定不依赖原始资料路径；原始区内部结构不在本图管理。

[生命周期定义](../../.agents/decisions/development/README.md#d-20260907-decision-lifecycle) · [文档操作](../development/documentation.md) · [开发工作指南](../development/workflow.md)

`src/packages/integrations/workflow` 提供文件函数/Agent 与串行 Workflow 的本机连接、私有文件来源引用及失败资源清理；核心编译器与运行控制留在 `engine/workflow`。

`engine/components/script-executor` 保存一次脚本执行及纯结果协议，`integrations/execution/script-record-reader` 执行停止后原始文件读取；`integrations/workflow` 复用文件契约和来源引用接纳脚本产物。

`engine/components/effect-executor` 与 `engine/workflow/effects` 分开保存操作授权/幂等接纳和 Workflow 适配；`integrations/effects/simulated-service` 只提供内存模拟目标，不接触 Harness 凭据。

耐久文件端口位于 `src/packages/engine/persistence/artifacts.ts`，本地实现位于 `src/packages/integrations/artifacts/file-archive.ts`；与临时 store 共用内部 `snapshot-io.ts`，归档没有临时释放生命周期。见[归档指南](../guides/artifact-archive.md)。
