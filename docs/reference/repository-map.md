# 仓库结构图

状态：2026-09-09 执行基础与离线 Docker Runner 切片。两类决策各自拥有完整生命周期目录；空生命周期目录使用 .gitkeep 保留。实现源码统一在根 src 内，应用和包按实际能力创建。

```text
Agent_flow/
├── AGENTS.md                      # 项目范围的执行入口
├── CLAUDE.md -> AGENTS.md
├── README.md
├── CHANGELOG.md                   # 实际变化、Unreleased 与发布记录
├── package.json / package-lock.json # npm workspaces 与固定依赖
├── tsconfig*.json                 # 共享严格构建与独立测试检查
├── src/
│   ├── apps/cli/                  # 当前仅 demo 命令
│   ├── packages/domain/           # 业务类型与执行身份
│   ├── packages/engine/           # contracts、components、runner；无环境依赖
│   ├── packages/integrations/     # Docker、文件与进程、系统时钟
│   ├── examples/                  # 合成示例入口
│   ├── tests/e2e/                 # 跨模块/CLI 测试
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
