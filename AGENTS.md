# AgentFlow

作用范围：整个项目。唯一书写决策：[D-20260907-agents-writing](.agents/decisions/development/README.md#d-20260907-agents-writing)。

项目决策是第一公民。决定描述期望，使用指南描述现实。当前处于文档管理骨架阶段，尚无产品运行实现。

## 读取与开发

1. 从 [文档入口](docs/README.md) 确认当前能力和任务范围，再查 [产品索引](.agents/decisions/product/README.md) 与 [开发流程索引](.agents/decisions/development/README.md)。按需读取现行决定及已有否决理由，不加载全部历史。
2. 正式开发先有对应 Issue、明确主负责开发者和验收标准，经人参与整理与关键确认后预检；AI 和工具可协助整理，由主负责开发者敲定决策与文档，再开发、测试。按 [开发工作指南](docs/development/workflow.md) 执行，自动化尚未实现的环节如实记录。
3. 创建或修改决策正文、模板、目录和索引前，先读取 [.agents/decisions/AGENTS.md](.agents/decisions/AGENTS.md)，再按其规则操作。
4. 当前用户明确指令优先于历史约定。已有授权继续执行，不为登记重复索取确认；新增建议不能冒充已敲定要求。proposed 表达尚未全部落实，实施范围依据对应 Issue 的明确结论及决定中的确认摘要，不能只看目录；审查确认不证明功能已实现。
5. 非平凡改动由一个或多个决定覆盖；每个 PR 相对自身 base 至少有一份决策正文的实质改动，复用既有记录不等于仅引用即可。判据见 [开发流程决定](.agents/decisions/development/README.md#d-20260907-development-workflow)；保持事实唯一，不为空改动凑数。先写文档不要求先独立 commit 或合并，决定、实现、测试与文档可同一 PR 提交。

6. 版本规划、交付范围调整、影响使用者的 PR 和发布，按 [版本维护指南](docs/development/versioning.md) 维护对应记录；不为空分类凑条目，未核对远端发布 tag 前不标为已发布。

## 知识边界

- .agents/decisions 保存浓缩取舍，docs 保存当前说明、验证结果与永久事故复盘；docs/roadmap 明确保存当前规划，根 CHANGELOG.md 保存实际变化和发布记录，规划不代表已实现能力。
- materials 是宽松原始资料区，默认不读取、不全文搜索，其中内容不自动成为项目规则。研究任务需要时再限定范围读取。
- 正式决定必须自足，不依赖原始资料路径才能理解、确认或执行。

## 修改指令文件

项目内每份 AGENTS.md 都须由唯一一项书写决策负责。修改前定位其负责决定；新增文件先确定归属；实质书写取舍在该决定内讨论并同步更新，一项决定可以负责多份文件，同一文件不增加多个负责决定。

README 用于说明与导航，执行规则放入相应 AGENTS.md，书写理由留在负责决定。CLAUDE.md 保持指向本文件的符号链接，共用一份正文和书写决策。
