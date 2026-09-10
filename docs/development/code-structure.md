# 源码组织与工程检查

本文说明当前工作区的源码组织和开发约定。目录选择及其理由见 [源码结构决定](../../.agents/decisions/development/README.md#d-20260909-source-layout)，当前能力见 [文档入口](../README.md)，接口使用见 [使用指南](../guides/README.md)。

## 代码放在哪里

实现代码、测试、示例和开发脚本集中在根 `src/`；根目录保留包管理、共享编译与 GitHub 配置。npm workspaces 管理 `src/apps/*` 和 `src/packages/*`，包内不再重复建立一层 src。

| 位置 | 当前职责 |
| --- | --- |
| `src/apps/cli/` | 可启动的命令行入口，组合包的公开接口 |
| `src/packages/domain/` | 共同业务类型、执行身份，保持与运行环境无关 |
| `src/packages/engine/` | 契约注册、组件定义与执行协调，定义所需接口 |
| 模块旁的 `*.test.ts` / `*.test.mjs` | 对应模块的单元测试 |
| `src/tests/e2e/` | 跨模块及 CLI 测试 |
| `src/examples/` | 示例入口 |
| `src/tooling/` | 依赖边界检查与测试发现工具 |

## 包与依赖边界

- 内部包使用 ESM、显式依赖和严格 TypeScript 配置，公开导出集中在 `index.ts`。
- 跨包从包导出入口导入，并在 package.json 声明依赖；不使用跨包相对路径或导入内部源文件，应用之间不互相导入。
- 当前应用可依赖 engine 和 domain，engine 可依赖 domain；domain 不反向依赖引擎或应用。
- domain 不依赖运行环境；engine 不读写文件、访问网络或启动进程，可使用纯校验库。后续具体环境适配按已确认结构进入 integrations，当前没有该包，实际创建时同步本指南。

## 安装、构建与验证

前置条件是 Node.js 24 或更新版本及 npm，在仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按 package-lock.json 安装工作区依赖 |
| `npm run build` | TypeScript 工作区构建 |
| `npm run check:boundaries` | 检查包导入方向、公共入口及环境依赖 |
| `npm run typecheck:tests` | 独立检查测试的 TypeScript 类型 |
| `npm test` | 构建、测试类型检查与 Node 测试 |
| `npm run check` | 当前基础检查入口，包含依赖边界及上述测试 |
| `npm run demo` | 构建并运行当前 CLI 示例，预期结果见使用指南 |

`.github/workflows/check.yml` 在 Linux 的 Node 24/26 上运行 `npm ci` 和 `npm run check`。配置存在不等于当前提交的远端检查已通过，验证与 PR 交接按 [开发工作指南](workflow.md) 记录。依赖检查是静态工程约束，不能代替执行隔离。

源码目录、包职责、依赖或命令变化时，同步本指南、根 AGENTS.md 的布局、[完整结构图](../reference/repository-map.md) 和相关使用说明。构建输出、运行数据与秘密不进入提交。
