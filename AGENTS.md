# AgentFlow

作用范围：整个项目。唯一书写决策：[D-20260907-agents-writing](.agents/decisions/development/README.md#d-20260907-agents-writing)。

项目决策是第一公民。决定描述期望，使用指南描述现实。当前处于文档管理骨架阶段，尚无产品运行实现。

## 读取与开发

1. 从 [文档入口](docs/README.md) 确认当前能力和任务范围，再查 [产品索引](.agents/decisions/product/README.md) 与 [开发流程索引](.agents/decisions/development/README.md)。按需读取现行决定及已有否决理由，不加载全部历史。
2. 非平凡改动必须有对应决策记录；已有决定覆盖时引用，有新取舍时更新或新建。具体判据见 [维护指南](docs/development/documentation.md)。
3. 创建或修改决策正文、模板、目录和索引前，先读取 [.agents/decisions/AGENTS.md](.agents/decisions/AGENTS.md)，再按其规则操作。
4. 当前用户明确指令优先于历史约定。已有授权继续执行，不为登记重复索取确认；新增建议不能冒充人类已接受，proposed 不能作为既定要求，accepted 不能作为功能已实现的证明。

## 知识边界

- .agents/decisions 保存浓缩取舍，docs 保存当前说明、验证结果与永久事故复盘。
- materials 是宽松原始资料区，默认不读取、不全文搜索，其中内容不自动成为项目规则。研究任务需要时再限定范围读取。
- 正式决定必须自足，不依赖原始资料路径才能理解、确认或执行。

## 修改指令文件

项目内每份 AGENTS.md 都须由唯一一项书写决策负责。修改前定位其负责决定；新增文件先确定归属；实质书写取舍在该决定内讨论并同步更新，一项决定可以负责多份文件，同一文件不增加多个负责决定。

README 用于说明与导航，执行规则放入相应 AGENTS.md，书写理由留在负责决定。CLAUDE.md 保持指向本文件的符号链接，共用一份正文和书写决策。
