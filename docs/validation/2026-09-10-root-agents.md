# 根 AGENTS.md 与同目录指令链接验证

2026-09-10，针对 [Issue #20](https://github.com/TonQiaN/Agent_flow/issues/20) 中本轮明确确认的根入口改动。当日对照基线为 main `b62ce53acdc948786fba1982534076d0d4ca567a`，包含已合并的 PR #17、PR #18、PR #19 与 PR #24；本轮使用独立工作分支 `codex/issue-20-root-agents`。以下保留当日验证，2026-09-11 的布局粒度修订与最新核对见末节。

## 已确认范围与写入顺序

当前用户明确根目录 AGENTS.md 使用独立决定，要求简短、准确、具体，并包含同目录 CLAUDE.md 符号链接规则、随开发更新的仓库布局、docs 工作入口与团队约定。TonQiaN 主责，Codex 起草、实施与自查。

先建立 [根入口独立决定](../../.agents/agent_notes/development/README.md#d-20260910-root-agents-writing)，调整 [原书写决定](../../.agents/agent_notes/development/README.md#d-20260907-agents-writing) 的负责范围与索引；此时核对两份 AGENTS.md 相对基线均无差异。随后修改根入口、补齐 agent_notes 目录符号链接，同步文档维护、结构图与 CHANGELOG。所述范围落实并核对后，两份决定在本工作分支进入 implemented。

初始基线 `eb108cd` 尚为文档骨架；本轮期间 main 先后合入执行基础 PR #17、Docker Runner PR #18 和首个 Harness PR #19，已同步主分支、解决文档冲突，将原产品目录占位替换为实际 src 布局。源码结构决定中的现行开发说明整理进工程指南后，再由根入口引用。本记录的结果对应同步后的范围。

## 核对结果

| 对象 | 方法与结果 |
| --- | --- |
| 独立书写归属 | 核对两份决定的受管文件表和指令回链：新决定只负责根 AGENTS.md，原决定只负责 agent_notes 目录 AGENTS.md；项目 21 份决定 ID 无重复 |
| 第一项必要规则 | 根入口第一节为必要规则，明确每份 AGENTS.md 都有同目录 CLAUDE.md 相对符号链接，新增、移动和删除时同步维护 |
| 符号链接 | 枚举项目 AGENTS.md，使用 Python 的 `is_symlink`、`readlink`、路径解析与逐字节读取比较；根目录和 agent_notes 目录两处 CLAUDE.md 均指向同目录 `AGENTS.md`，目标存在且正文一致；Git 索引中两者的模式均为 `120000` |
| 仓库布局 | 根入口为 63 行、3,761 字节；核对 28 个实际路径全部存在。源码与测试已建立，未保留过期占位；未来未建立入口如何占位及及时更新的要求仍明确 |
| docs 入口与团队约定 | 根入口按任务引用开发、Issue、文档和版本指南；除自身归属回链与局部 AGENTS.md 入口外，其余 Markdown 链接均指向 docs；团队约定单独成节 |
| 当前说明一致性 | 文档维护指南已说明独立归属、同目录链接、布局更新和开发框架操作内容进入 docs；新增工程指南承载源码结构、依赖边界与真实工程命令；结构图补齐 agent_notes 目录 CLAUDE.md；原有 PR 决策增量等开发要求继续由指南承载 |
| 局部指令、代码与原始资料 | 相对最终基线，agent_notes 目录 AGENTS.md 正文、materials、src、包管理和编译配置、基础 CI 均无差异 |
| 链接与格式 | 同步主分支后检查 72 份正式 Markdown 的 315 处相对链接与锚点，均有效；`git diff --check` 和 `git diff --cached --check` 通过 |
| 工程指南中的命令 | macOS、Node.js 24.18.1、npm 11.16.0 下，`npm ci`、`npm run check`、`npm run demo` 均成功；依赖边界、构建和测试类型检查通过，77 项测试通过，15 项 Docker / Codex 环境用例按默认开关跳过；demo 返回 accepted / completed 且 output.total 为 6 |

用户截图用于参考“路径与职责”的呈现形式，实际采用本仓库的目录。未来占位只表示缺少对应入口，不用占位擅自确定新的架构路径。

## 验证边界

本记录证明本工作分支中文件、链接、归属和当前说明一致，并核对了当前工程命令。未启动新的 Claude 或 Codex 会话做加载实验，未验证两种工具的全局配置或执行效果一致，未验证长期协作收益。本地检查仅覆盖 Node 24，Docker daemon 当前不可访问，未运行 15 项 Docker / Codex 环境用例；远端 Node 24/26 已配置启用 Docker，另需 Codex 镜像等前置条件的测试不会因此自动覆盖，具体提交的检查结果以 PR 为准。

本轮未进行其他开发者审阅；根入口的已确认改动与 Issue #20 的其余研究问题分别验收。没有产品版本范围调整，Roadmap 不变；可见的协作入口变化记录在 CHANGELOG 的 Unreleased，不代表已发布。

## 2026-09-11：根布局粒度修订

用户明确除 src 项目代码外，其他目录仅需入口级粒度：非源码目录后续会设计各自的 AGENTS.md，src 不一定。先在唯一根入口书写决定中补充粒度、理由和旧方案取舍，并核对根 AGENTS.md 尚无本轮差异；随后收起 `.agents/`、`.github/` 与 `docs/` 的内部层次，同步文档维护指南。详细结构图继续承担完整参考职责，没有新增目录指令文件。

本轮对照 main `fb635272b49bbb89867fbaf3821c26f07b290e8f`，已同步 PR #26 的 Workflow 实现及说明并解决文档冲突。实际核对如下：

- 根文件由 63 行缩为 52 行、3,264 字节，列出 17 个真实路径；仅 src 有下级条目，其余目录均为根级入口与职责。
- 与修订前 `5bd3f7e` 比较，src 布局逐字一致；根文件的 Markdown 链接、按任务读取和团队约定均保留，两处同目录 CLAUDE.md 符号链接仍有效。
- 检查 84 份正式 Markdown 的 368 处相对链接与锚点、21 个决定 ID 与两份指令的唯一归属；差异格式检查通过。相对本轮 main 基线，源码、包与编译配置、CI、agent_notes 目录 AGENTS.md 正文及原始资料均无差异。
- 本地 `npm run check` 与 `npm run demo` 成功：133 项测试通过，18 项 Docker / Codex 环境用例按默认开关跳过；依赖边界、构建、测试类型检查通过，demo 返回 accepted / completed 且 output.total 为 6。远端 Node 24/26 的具体提交结果以 PR checks 为准。

主责与实际分工沿用 Issue #20，Codex 起草、实施与自查；其他目录的 AGENTS.md 设计留待后续工作，未据此宣称已存在。跨工具加载与长期效果不在本次验证范围。
