# 仓库结构图

状态：2026-09-07 文档管理骨架。两类决策各自拥有完整生命周期目录；空目录使用 .gitkeep 保留。

```text
Agent_flow/
├── AGENTS.md                      # 项目范围的执行入口
├── CLAUDE.md -> AGENTS.md
├── README.md
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
│   ├── ISSUE_TEMPLATE/           # 功能、缺陷、维护表单与入口配置
│   └── PULL_REQUEST_TEMPLATE.md  # Issue、决策增量、验收与评审交接
├── docs/
│   ├── README.md
│   ├── architecture/README.md
│   ├── guides/README.md
│   ├── development/
│   │   ├── documentation.md
│   │   └── workflow.md           # 当前协作流程、模板及能力边界
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
