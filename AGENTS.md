# AgentFlow

作用范围：整个项目。唯一书写决策：[根入口书写决定](.agents/decisions/development/README.md#d-20260910-root-agents-writing)。

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
  packages/domain/           业务类型与执行身份
  packages/engine/           执行引擎与契约
  examples/                  示例入口
  tests/e2e/                 跨模块与 CLI 测试
  tooling/                   依赖边界与测试工具
.agents/decisions/            产品与开发流程取舍、生命周期及局部指令
.github/                     Issue / PR 模板
  ISSUE_TEMPLATE/            五类主 Issue 表单与空白入口配置
  PULL_REQUEST_TEMPLATE.md   PR 交付与审查说明
  workflows/                 基础 CI
docs/
  README.md                  当前能力与文档入口
  architecture/              当前架构说明与待定问题
  guides/                    安装、运行与接口使用
  development/               开发、Issue、文档及版本维护指南
  reference/                 仓库结构等参考
  roadmap/                   当前规划，不代表已实现
  validation/                实际验证结果与限制
  postmortems/               永久事故复盘
CHANGELOG.md                 实际变化与发布记录
materials/                   宽松原始资料区
```

目录或职责变化时，同步本节与 [完整结构图](docs/reference/repository-map.md)。尚未建立的入口明确标为占位，落地后及时替换；运行与安装方式见 [使用指南](docs/guides/README.md)。

## 按任务读取

先从 [文档入口](docs/README.md) 确认当前能力，再读取本次任务所需说明：

- 开工、预检、决策准备、PR 与验收：按 [开发工作指南](docs/development/workflow.md) 执行。
- 源码组织、包依赖与构建测试：按 [工程指南](docs/development/code-structure.md) 执行。
- 主 Issue 填写与 Sub-issue 分工：按 [Issue 指南](docs/development/issue-templates.md) 执行。
- 文档和 AGENTS.md 的书写归属、修改与核对：按 [文档维护指南](docs/development/documentation.md) 执行。
- 版本规划、范围调整、变更记录与发布：按 [版本维护指南](docs/development/versioning.md) 执行。

编辑决策正文、模板、目录或索引前，先读取 [.agents/decisions/AGENTS.md](.agents/decisions/AGENTS.md)。

## 团队约定

- 正式开发归属明确 Issue、人类主负责开发者和验收标准；AI 协助整理与执行，人参与关键确认。主 Issue 说明整体需求，Sub-issue 由对应负责人自主组织。
- 当前用户明确指令优先于历史约定；已有授权继续执行，新增建议与已确认要求分清。
- 项目决策是第一公民，保存自足的取舍；docs 说明当前工作方式，roadmap 明确标识规划。依据真实成果验收，如实记录未实现、未验证与未审阅的部分。
- materials 默认不读取、不全文搜索；任务需要时限定范围读取，原始内容不自动成为项目规则。
