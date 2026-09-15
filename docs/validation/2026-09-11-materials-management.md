# materials 管理与飞书 CLI 核对

日期：2026-09-11。关联 [Issue #34](https://github.com/TonQiaN/Agent_flow/issues/34) 与 [资料管理决定](../../.agents/decisions/development/README.md#d-20260911-materials-management)。

## 对象与范围

基线为 main `b1e94abb3fc895b007049266ece409e6af3e3eb8`，工作分支为 `codex/materials-management`。本轮覆盖目录管理文件、取消原始内容跟踪、指令和当前说明；不修改 src、产品配置或 CI。由 Codex 实施与自查，主负责开发者为 TonQiaN，尚无其他开发者审阅。

## 本地资料与指令检查

基线中 materials 有 80 份跟踪文件，其中 2 份根级管理文件、78 份原始文件。修改前已分别为操作工作区的 78 份原始文件、原 checkout 的 86 份原始文件记录 SHA-256；后者包含 8 份原本未跟踪的文件，仅作保留核对，不将原始正文加载为项目上下文。

78 份原始文件已使用 `git rm --cached` 精确移出索引。两处工作区的全部记录文件经 SHA-256 复核均存在且内容不变；原 checkout 的 8 份未跟踪文件仍原样保留。

| 核对项 | 结果 |
| --- | --- |
| materials 的 Git 索引 | 恰好保留 AGENTS.md、CLAUDE.md、README.md、.gitignore、.ignore 五份根级管理文件 |
| Git 忽略行为 | 78 个原始文件路径及 7 个新建、隐藏、嵌套同名文件探针均被忽略；五份管理文件均可正常入库 |
| 默认检索 | `rg --files --hidden materials` 只列四份普通管理文件；默认不跟随 CLAUDE.md 符号链接，不列原始内容 |
| 正式 Markdown 与相对引用 | 89 份 Markdown 的 399 处相对链接与锚点通过，目标在交付文件集合中，未因本地仍有原件而掩盖对已移出 Git 文件的链接 |
| 决策与指令 | 22 个决定 ID 各有唯一正文与索引；三份 AGENTS.md 各有唯一负责决定；三处 CLAUDE.md 均为 Git 模式 120000、相对目标 AGENTS.md，正文一致 |
| 根入口粒度 | 54 行，17 个真实布局路径；src 布局逐字保留，其他目录只列根级入口与职责；materials 局部指令为 18 行 |
| 改动边界 | src、包与编译配置、.github 和决策目录 AGENTS.md 正文相对基线无变化；恰好 78 个原始路径退出跟踪，无其他删除 |
| 差异格式 | 已暂存与未暂存的 `git diff --check` 均通过，无冲突标记 |

以上为当前工作分支的静态自查结果；检查脚本及逐文件摘要保留在本机临时工作记录中，不为原始区新增统一索引要求。

## 飞书 CLI 的实际核对

| 核对项 | 实际结果 |
| --- | --- |
| 本机 CLI | PATH 中存在 `lark-cli`，profile 管理与只读命令可用 |
| `profile list` | 存在 AgentFlow；为当前 active / effective 配置 |
| `whoami --profile AgentFlow --as user` | 用户身份可用，凭据就绪 |
| `auth status --profile AgentFlow --json --verify` | 整体 verified 为 true；用户与应用身份均通过在线验证；应用名为“AgentFlow 飞书 CLI” |
| 企业名称查询 | 按官方接口使用 AgentFlow profile 的应用身份查询，返回缺少 `tenant:tenant:readonly`，错误码 99991672；未取得企业名称 |
| 应用后台归属 | 通过已有 Chrome 登录态只读查看同一 App ID 的页面，显示“AgentFlow 飞书 CLI”“已启用”“正式应用@AgentFlow”；与本机配置和在线验证中的 App ID 一致 |

企业名称查询依据飞书官方 [获取企业信息](https://open.feishu.cn/document/server-docs/tenant-v2/query.md)，本次于上述日期读取接口定义后调用。实际请求为只读 `GET /open-apis/tenant/v2/tenant/query`；没有申请额外权限或变更配置。随后通过已有 Chrome 登录态核对 [应用后台](https://open.feishu.cn/app/cli_aa292721fb795bfb/baseinfo)：App ID 为 `cli_aa292721fb795bfb`，后台明确标注“正式应用@AgentFlow”，证实当前 CLI 配置的组织归属。

本轮还查到同日配置切换任务的相关记录，仅用于定位核对入口；最终组织结论依据本次实际后台页面和在线 CLI 验证，不用任务标题、应用名称或本地 profile 名代替。用户给定的“若已连接则写为团队约定”条件已满足，无需另行确认。企业信息接口的权限缺口仍如实保留，不将其写成 API 验证通过。

记录只保留核对结论，不写入凭据、完整授权范围或个人标识。认证结果是该机器该时点的状态，不代表其他团队成员已配置。

## 验证边界

本轮没有创建飞书目录或知识库、上传资料、调整权限、验证团队成员对具体资料的访问，也没有进行跨工具指令加载实验。Git 历史未改写；只在操作工作区取消跟踪并保留原件，其他 checkout 接收提交前的保留方法见 [资料指南](../development/materials.md)。

产品代码没有变化，本地不重复运行产品或 Docker 测试；本轮静态核对与实际远端 CI 结果分开记录。Issue #20 继续保留其他子目录和整体研究讨论，不能因本轮目录实施而宣告完成。
