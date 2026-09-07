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
│   │   ├── accepted/
│   │   ├── implemented/
│   │   ├── archived/
│   │   └── rejected/
│   └── development/              # 与 product 相同的生命周期树
├── docs/
│   ├── README.md
│   ├── architecture/README.md
│   ├── guides/README.md
│   ├── development/documentation.md
│   ├── reference/repository-map.md
│   ├── validation/               # 实際执行的验证结果与局限
│   └── postmortems/              # 永久保留的重大事故复盘
└── materials/
    ├── README.md                 # 入口；不要求全量文件索引
    ├── .ignore                   # 默认 rg 不读取内部材料
    └── …                         # 自由组织，可含 artifacts、会议、录音等
```

正式开发从决定及当前说明开始。原始资料可由研究任务提炼进决定，但正式决定不依赖原始资料路径；原始区内部结构不在本图管理。

[生命周期定义](../../.agents/decisions/development/README.md#d-20260907-decision-lifecycle) · [文档操作](../development/documentation.md)
