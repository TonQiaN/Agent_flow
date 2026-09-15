# 源码组织与工程检查

本文说明当前工作区的源码组织和开发约定。目录选择及其理由见 [源码结构决定](../../.agents/decisions/development/README.md#d-20260909-source-layout)，当前能力见 [文档入口](../README.md)，接口使用见 [使用指南](../guides/README.md)。

## 代码放在哪里

实现代码、测试、示例和开发脚本集中在根 `src/`；根目录保留包管理、共享编译与 GitHub 配置。npm workspaces 管理 `src/apps/*` 和 `src/packages/*`，包内不再重复建立一层 src。

| 位置 | 当前职责 |
| --- | --- |
| `src/apps/cli/` | 可启动的命令行入口，组合包的公开接口 |
| `src/apps/studio/` | React/TypeScript 前端与本机 HTTP 服务；通过固定 examples 子进程入口启动 Workflow |
| `src/packages/domain/` | 共同业务类型、执行身份，保持与运行环境无关 |
| `src/packages/engine/` | 执行引擎、契约与所需接口 |
| `src/packages/integrations/` | 文件、进程、容器等具体环境适配 |
| 模块旁的 `*.test.ts` / `*.test.mjs` | 对应模块的单元测试 |
| `src/tests/e2e/` | 跨模块、CLI 与运行环境集成测试 |
| `src/tests/browser/` | Playwright 浏览器用户旅程，连接真实本机服务 |
| `src/tests/fixtures/` | 合成子进程等测试素材 |
| `src/examples/` | 示例入口 |
| `src/tooling/` | 依赖边界检查与测试发现工具 |

## 包与依赖边界

- 内部包使用 ESM、显式依赖和严格 TypeScript 配置，公开导出集中在 `index.ts`。
- 跨包从包导出入口导入，并在 package.json 声明依赖；不使用跨包相对路径或导入内部源文件，应用之间不互相导入。
- 应用可依赖 engine、integrations 和 domain；integrations 可依赖 engine 和 domain；engine 可依赖 domain。domain 不反向依赖这些包或应用。
- domain 不依赖运行环境；engine 不读写文件、访问网络或启动进程，可使用纯校验库；具体环境适配由 integrations 承担。

## 安装、构建与验证

前置条件是 Node.js 24 或更新版本及 npm，在仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按 package-lock.json 安装工作区依赖 |
| `npm run build` | TypeScript 工作区构建 |
| `npm run check:boundaries` | 检查包导入方向、公共入口及环境依赖 |
| `npm run typecheck:tests` | 独立检查测试的 TypeScript 类型 |
| `npm test` | 构建、测试类型检查与 Node 测试 |
| `npm run check` | 当前基础检查入口，包含依赖边界、浏览器源码/测试类型检查及上述测试 |
| `npm run studio:build` | 构建服务和 Vite 前端 |
| `npm run studio:typecheck` | 先构建依赖声明，再检查 DOM 前端和 Playwright 测试类型 |
| `npm run studio:test` | 构建后运行真实本机服务的 Chromium 用户旅程 |
| `npm run demo` | 构建并运行当前 CLI 示例，预期结果见使用指南 |

普通 `npm run check` 会明确跳过需要 Docker 的用例；容器测试的前置条件和 `AGENTFLOW_DOCKER_TESTS=1` 用法见 [Runner 使用指南](../guides/runner.md)。`.github/workflows/check.yml` 在 Linux 的 Node 24/26 上安装依赖、拉取测试镜像，并启用该开关运行检查。配置存在不等于当前提交的远端检查已通过，验证与 PR 交接按 [开发工作指南](workflow.md) 记录。依赖检查是静态工程约束，不能代替执行隔离。

源码目录、包职责、依赖或命令变化时，同步本指南、根 AGENTS.md 的布局、[完整结构图](../reference/repository-map.md) 和相关使用说明。构建输出、运行数据与秘密不进入提交。

#39 增加 `AGENTFLOW_STUDIO_TESTS=1` 的断网材料与招聘矩阵，以及独立 Chromium CI；命令与镜像见[本机工作台指南](../guides/local-studio.md)。依赖扫描覆盖 TSX/JSX，排除明确生成的 studio/public。
