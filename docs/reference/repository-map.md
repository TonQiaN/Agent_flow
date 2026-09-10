# 仓库结构图

状态：2026-09-10 文档与协作骨架，尚无产品运行实现。两类决策各自拥有完整生命周期目录；空生命周期目录使用 .gitkeep 保留。Roadmap 版本文件按实际规划创建，不预建空目录。

```text
Agent_flow/
├── AGENTS.md                      # 项目范围的执行入口
├── CLAUDE.md -> AGENTS.md
├── README.md
├── CHANGELOG.md                   # 实际变化、Unreleased 与发布记录
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

产品源码、测试目录及运行命令尚未建立；根入口的对应条目使用“待确定、尚未创建”的占位，未选择具体路径。目录、职责或开发入口变化时，负责该改动的开发者同步本图、根 AGENTS.md 的简图与相关使用指南。

[生命周期定义](../../.agents/decisions/development/README.md#d-20260907-decision-lifecycle) · [文档操作](../development/documentation.md) · [开发工作指南](../development/workflow.md)
