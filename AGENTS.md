# AgentFlow

作用范围：整个项目。唯一书写决策：[根入口书写决定](.agents/agent_notes/development/README.md#d-20260910-root-agents-writing)。

## 必要规则

项目内每份 `AGENTS.md` 都须有同目录的 `CLAUDE.md -> AGENTS.md` 相对符号链接，让 Claude 与 Codex 共用一份项目指令正文。新增、移动或删除指令文件时同步维护链接。

## Repository layout · 仓库布局

当前已实现能力与未完成范围以 [文档入口](docs/README.md) 为准。

```text
AGENTS.md                    全项目工作入口
CLAUDE.md -> AGENTS.md        同一指令正文的 Claude 入口
package.json                 npm workspaces 与工程命令
package-lock.json            固定依赖版本
src/
  apps/cli/                  命令行入口
  apps/studio/               本机展示与工作流启动服务
  packages/domain/           业务类型与执行身份
  packages/engine/           执行引擎与契约
  packages/integrations/     文件、进程、容器等环境适配
  examples/                  示例入口
  tests/                     跨模块、CLI 测试与合成测试素材
  tooling/                   依赖边界与测试工具
.agents/                     代理协作规则与 agent_notes 正式笔记
.github/                     Issue / PR 模板与基础 CI
docs/                        当前能力、工作指南、规划与验证记录
CHANGELOG.md                 实际变化与发布记录
materials/                   本地原始资料区，管理文件入库
```

布局仅展开 src 的关键代码入口，其他目录只列入口与职责。目录或职责变化时，同步本节与 [完整结构图](docs/reference/repository-map.md)。尚未建立的入口明确标为占位，落地后及时替换；运行与安装方式见 [使用指南](docs/guides/README.md)。

## 按任务读取

按本次任务读取相关说明。需要确认项目当前能力、未完成范围或查找文档入口时，查阅 [文档入口](docs/README.md)。

- 开工、预检、决策准备、PR 与验收：按 [开发工作指南](docs/development/workflow.md) 执行。
- 源码组织、包依赖与构建测试：按 [工程指南](docs/development/code-structure.md) 执行。
- 主 Issue 填写与 Sub-issue 分工：按 [Issue 指南](docs/development/issue-templates.md) 执行。
- 文档和 AGENTS.md 的书写归属、修改与核对：按 [文档维护指南](docs/development/documentation.md) 执行。
- 版本规划、范围调整、变更记录与发布：按 [版本维护指南](docs/development/versioning.md) 执行。
- 本地资料与选定资料的团队共享：按 [资料指南](docs/development/materials.md) 执行，进入资料区先读 [局部指令](materials/AGENTS.md)。

编辑 agent_notes 正文、模板、目录或索引前，先读取 [.agents/agent_notes/AGENTS.md](.agents/agent_notes/AGENTS.md)。

## 团队约定

- 正式开发归属明确 Issue、人类主负责开发者和验收标准；AI 协助整理与执行，人参与关键确认。主 Issue 说明整体需求，Sub-issue 由对应负责人自主组织。
- 当前用户明确指令优先于历史约定；已有授权继续执行，新增建议与已确认要求分清。
- agent_notes 保存自足的项目取舍；docs 说明当前工作方式，roadmap 明确标识规划。依据真实成果验收，如实记录未实现、未验证与未审阅的部分。
- materials 原始内容默认不读取、不全文搜索；任务需要时限定范围读取，内容不自动成为项目规则；Git 仅保留该目录的管理文件。
- 值得团队成员共享的选定资料通过飞书 CLI 的 `AgentFlow` 配置在 AgentFlow 组织中管理，按 [资料指南](docs/development/materials.md) 核对身份与访问范围。
