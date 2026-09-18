# 原始资料与团队共享

`materials/` 保存自由整理的本地原始资料；值得团队成员复用或讨论的选定内容通过飞书 CLI 管理。规则入口是 [materials/AGENTS.md](../../materials/AGENTS.md)，取舍及其唯一书写归属见 [资料管理决定](../../.agents/decisions/development/README.md#d-20260911-materials-management)。

## 本地与 Git 的边界

materials 内仅五份根级管理文件进入 Git：`AGENTS.md`、`CLAUDE.md`、`README.md`、`.gitignore`、`.ignore`。其他文件和目录默认忽略，包括任意原始子目录中的 README.md、AGENTS.md 等同名文件。`.gitignore` 管理 Git 边界，`.ignore` 管理默认 ripgrep 检索；它们都不是访问控制。

原始内容可以包含 artifact、会议、聊天、录音和调研文件，没有统一格式、命名、目录或材料索引。管理文件可正常检索；原始正文仅在任务需要时限定范围读取。`rg --files --hidden materials` 可列出可检索管理文件，默认不跟随 CLAUDE.md 符号链接。

新增资料不会自动上传到飞书，也不会自动成为正式项目规则。采纳的取舍进入 `.agents/decisions/`，当前说明与验证结论进入 `docs/`；正式知识保留必要事实并可独立理解，不要求原始路径或飞书链接稳定存在。

## 已有 checkout 如何保留原件

本轮取消 78 份已有原始文件的 Git 跟踪，操作工作区保留了原件。Git 忽略规则只处理之后的跟踪边界：其他 checkout 拉取这个删除索引的提交时，Git 仍可能移除原先受跟踪的工作区文件。

在已有 checkout 接收该变更前，将需要保留的 materials 原始内容复制到仓库外并核对副本；更新后按需恢复原始文件和原始子目录，保留新版的五份管理文件。检查恢复的文件与副本一致，且 `git ls-files -- materials` 仅列管理文件。不要将旧管理文件覆盖回来，也不要使用 `git clean -fdx` 清除被忽略的本地原件。

新克隆只会取得管理入口，原始内容不再随代码分发。最初取消跟踪没有删除旧历史；2026-09-18 的 [Issue #50](https://github.com/TonQiaN/Agent_flow/issues/50) 已将原始资料从可写分支历史移除。需要原件时使用自己的本地副本或仓库外私有备份，不再依赖旧 GitHub 提交取回。

## 历史清理后的旧 checkout

旧历史不能直接 merge 回清理后的主干，即使最新文件树已经没有原始资料。这样会重新引入旧祖先提交，忽略规则不会拦截它。

1. 在仓库外备份需要保留的 materials、本地改动及必要提交，核对副本；备份不得上传 GitHub。
2. 优先重新克隆当前仓库；仍有未交付工作时，在新分支仅移植已经核对的实际改动，重新检查 diff、历史与凭据，不合并旧分支的历史。
3. 将本地原件按需恢复到忽略的资料区，保留新版管理文件；核对摘要及 `git ls-files -- materials`，当前主干只应跟踪五份管理文件。
4. 核对本机推送检查。此次安装的 pre-push 只作用于本机这个仓库及其 worktree，其他克隆不自动继承；不能依赖他人的钩子保护当前机器。

旧功能分支只有在无开放 PR、其提交已进入 main 且已备份后才清理。主干成果、源码发布 tag、本地原件和历史验收事实继续保留。旧 PR 中原始资料的路径可替换为正式验证入口或“仅本地保留”的说明，不把资料文件上传为修复链接的办法。

GitHub 的 `refs/pull/*` 为只读；历史重写、关闭 PR 和删除普通分支都不会自动清除这些引用与提交缓存。仍可读取原始资料时保持 private，交由 GitHub Support 处理后再核对公开入口。操作与限制见 [GitHub 官方清理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)，当前进展见 [公开前清理验证](../validation/2026-09-18-public-preparation.md)和 #50。

## 飞书 CLI 的身份与目标组织

团队共享资料使用 **AgentFlow 飞书组织**，CLI 操作显式指定 `--profile AgentFlow`。本机该 profile 对应“AgentFlow 飞书 CLI”，App ID 为 `cli_aa292721fb795bfb`；2026-09-11 已通过在线认证，并在同一应用的 [飞书开发者后台](https://open.feishu.cn/app/cli_aa292721fb795bfb/baseinfo) 核对“正式应用@AgentFlow”。

profile 是本机配置名；新增或调整配置时，对照实际 App ID 和后台组织标注核对归属，不只依赖相似名称。核对结果与接口限制见 [验证记录](../validation/2026-09-11-materials-management.md)。

操作前核对当前机器的实际配置和身份；本机验证结果不代表其他成员已经配置或登录：

```sh
lark-cli profile list
lark-cli whoami --profile AgentFlow --as user
lark-cli auth status --profile AgentFlow --json --verify
```

核对命令返回的 App ID、用户身份及在线验证结果；资料操作保留显式 profile 参数，不依赖机器当前的默认组织。若改用新应用或组织，先同步对应团队约定与核对依据。

## 选定资料的共享与交付

确定本次需要团队使用的资料、用途和访问对象后，再使用飞书 CLI 对应资源命令管理。通过 `lark-cli drive --help` 等入口选择合适命令，按其帮助核对参数；操作显式指定 `--profile AgentFlow`，用户资料通常使用 `--as user`。各成员使用自己的授权，凭据留在本机配置中。

已有资料优先沿用其飞书入口；新 artifact 按实际任务上传或创建。交付时给出可访问链接和简短用途说明，按目标成员或已有共享范围核对访问能力；只有上传成功时，不宣称全员可访问。原始资料不必全部迁移，也不要求建立统一目录或全量资料索引。

本次建立约定与管理文件，没有创建云盘文件夹或知识库、上传具体资料、调整成员权限或验证团队访问。实际共享由对应资料任务执行，不以本次登录验证代替。
