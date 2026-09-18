# 项目代理指令与技能相关内容审查

2026-09-14，关联 [Issue #20](https://github.com/TonQiaN/Agent_flow/issues/20)。TonQiaN 为主负责开发者，Codex 执行审查与后续修复。本文按时间保留问题、证据、建议及处理记录；最新状态见文末 [四项修复实施与验收](#四项修复实施与验收)。

初次审查基线为 main `b1e94abb3fc895b007049266ece409e6af3e3eb8`。另读取 [PR #35](https://github.com/TonQiaN/Agent_flow/pull/35) 的 `5838eaf35cf01c135db116ebf9dcf33a53b26ee3`，只核对其 materials 指令及对应决定、指南与根入口的衔接；该 PR 当时开放且为草稿，未将分支内容当作主线能力。

PR #35 已合并，其基线与当时结论见 [合并后复查](#pr-35-合并后复查)。此前各节保留初次审查的基线与当时状态，后续采纳与修复另行记录。

实施参考为用户指定的 [OpenAI 文章](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)，本次重新读取原文。本文据此检查技能触发与按需展开、指令的任务相关性、过细的步骤约束、授权边界、持续完成任务及跨模型适用性。文章提供审查视角；具体问题由仓库文本及其相互关系支持。

## 审查结论与证据范围

发现四项可以定位的入口或说明问题，另有三项值得讨论或验证的既有流程取舍。优先处理触发条件、规则例外和错误指向；技能数量与文件长度不作为单独的缺陷判断。

本次完成文件清单核对、相关正文与 alternatives 阅读、指令和负责决定的一致性核对、符号链接检查，以及少量已有验证记录的对照。场景影响是对文本的推断，未运行新模型会话或修改前后的行为对照，未测量完成率、耗时、token 或重复确认频率。历史运行记录只支持其当时的事实。

| 对象 | 当前事实与覆盖范围 |
| --- | --- |
| 根 `AGENTS.md` | 52 行、3,264 字节；读取全部正文及根入口负责决定 |
| `.agents/agent_notes/AGENTS.md` | 19 行、2,716 字节；读取全部正文、负责决定及其引用的流程、内容、生命周期规则 |
| `CLAUDE.md` | 主线两处均为相对符号链接，目标为同目录 `AGENTS.md`，读取内容相同；这不证明两个工具加载和执行效果相同 |
| 项目 Skill 与配置 | 排除原始材料、依赖、构建产物后，没有发现项目 `SKILL.md`；`.agents/skills/` 不存在，`.codex/` 与 `.claude/` 为空，Git 中也没有这几个目录的项目技能或配置文件 |
| 指令与技能相关决定 | 根入口、agent_notes 目录、开发流程、决策内容／生命周期／文档分层、Issue 共通及有关类型、版本管理等；开发 Skill 仅在开发流程决定第 9、93 行列为另议事项 |
| 关联说明 | 开发、文档、工程、Issue 与版本指南，PR 模板及有关主 Issue 表单；它们是需求或工作说明，不因含有提示文字就视为独立 Skill |
| PR #35 | 读取 18 行 materials AGENTS.md、其 47 行负责决定、资料指南，以及根入口和负责决定的相关差异 |
| 未纳入 | 产品运行时提示词及源码行为、src 局部指令设计、全局和第三方技能的逐个审查、原始材料正文、实际飞书操作 |

本会话还受宿主和已安装技能影响；项目没有自带 Skill，不等于当前代理没有加载外部技能。后续行为验证需保留这些环境差异，不能将总上下文或所有执行表现归因于仓库。

## 四项可定位的问题

### R1：根入口仍无条件要求先读项目概览

位置：[AGENTS.md 第 37 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/AGENTS.md#L37)。

当前写法要求先从 `docs/README.md` 确认当前能力，再读取任务说明。于是修改一处已定位的文档链接、整理既有 Issue 字段等任务，也被附加了与目标可能无关的产品能力阅读。其后的五个按任务入口已经有具体条件，问题集中在这条无条件前置要求。

负责的根入口决定第 17、37 行要求按实际任务提供入口，第 54 行已解释让每个任务承担无关流程内容的成本。现行前置句与该按需目标存在张力。

建议将项目概览的触发条件明确为需要判断产品当前能力、范围或导航入口的任务，保留其作为能力事实入口的职责。编辑决策区前读取该区 AGENTS.md 仍有明确的作用范围，适合保留。

负责决定：[D-20260910-root-agents-writing](../../.agents/agent_notes/development/README.md#d-20260910-root-agents-writing)。证据类型：文本触发条件已确认；对小任务上下文负担的影响为推断，未量化。

### R2：工作指南省略了原决定已有的适用例外

位置：[工作指南第 31 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/docs/development/workflow.md#L31)、[第 39 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/docs/development/workflow.md#L39)。

指南只保留“先写清本次决定及影响”和每 PR 的决策增量要求，没有带出开发流程决定第 41 行的“已有文档完整覆盖时无需重写”，也没有说明第 49 行对缺少有意义决策增量的轻量工作的现行处理方式：并入同问题下有决策变更的相关 PR。

从根入口被引导到指南的执行者，在恢复既有行为且原决定已经覆盖的任务中，容易误以为开工前必须再次改写决定；到 PR 阶段，指南同时要求实质增量和禁止凑数，却未提供负责决定中已有的处理出口。执行者需再追读长篇决定才能找齐现行规则。

建议在指南中简短保留这两个影响执行的条件，或直接定位相关小节。此处是说明完整性修正，和是否改变“每 PR 都有决策增量”的政策分别处理；不能把补回例外写成轻量 PR 已获豁免。

负责决定：[D-20260907-development-workflow](../../.agents/agent_notes/development/README.md#d-20260907-development-workflow)。证据类型：指南与原决定的内容差异已确认；代理是否实际因此停顿尚未实验。

### R3：Blackbox 优先调查缺少可定位入口和适用边界

位置：[工作指南第 25 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/docs/development/workflow.md#L25)、[开发流程决定第 33 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/.agents/decisions/development/proposed/D-20260907-development-workflow.md#L33)。

指南把“当前问题调查”统一设为先检查 Blackbox Agent Flow，再进行本项目复现和修复。正式区域能找到旧系统名称、短提交号和具体历史测试引用，但本次未找到它的明确仓库地址或 checkout 定位入口，也没有说明不相关问题、不可访问或查无对应内容时如何继续。

新的协作者在处理仅与本项目文档或环境有关的问题时，可能先进行无关搜索，或把缺少参考仓库访问条件当作本地调查的前置阻塞。这是文本可能造成的影响，不是本次已经复现的代理停顿。

该顺序源自用户 2026-09-09 的明确要求，开发流程决定第 104 行保留了依据。历史验证确实记录了 Blackbox 对输出空目录、Codex 启动等问题的帮助，不能据文章就认为参考旧实现没有价值。

建议补足可核查的定位入口，并讨论该顺序应覆盖哪些问题、何时可以依据本项目事实继续调查。定位问题可由指南补足；对既有优先顺序的实质调整回到原负责决定，避免自行增加或取消前提。

负责决定：[D-20260907-development-workflow](../../.agents/agent_notes/development/README.md#d-20260907-development-workflow)。证据类型：参考入口与边界说明缺口已确认；过度搜索或阻塞的行为风险待验证。

### R4：版本管理决定仍把根指令指向旧负责决定

位置：[D-20260908-version-management 第 33 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/.agents/decisions/development/implemented/D-20260908-version-management.md#L33)。

该处仍写根指令的入口书写沿用 `D-20260907-agents-writing`。但根入口已迁移到 `D-20260910-root-agents-writing`，旧决定第 9 行明确不再负责根文件。链接能够打开，语义指向却已过期。

在修改根入口的版本维护提示时，这会把执行者带到错误的负责记录，增加相互矛盾的归属说明。建议把当前负责链接改为根入口独立决定，保留历史确认段落原来的时间语境。

负责决定：[D-20260908-version-management](../../.agents/agent_notes/development/README.md#d-20260908-version-management) 中的现行引用；根入口归属仍由 [D-20260910-root-agents-writing](../../.agents/agent_notes/development/README.md#d-20260910-root-agents-writing) 管理。证据类型：两个现行正文的归属矛盾已确认。

## 三项需要讨论或行为证据的取舍

### D1：每个 PR 都必须产生实质决策增量

位置：[开发流程决定第 47–49 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/.agents/decisions/development/proposed/D-20260907-development-workflow.md#L47)、agent_notes 目录 AGENTS.md 第 13 行、PR 模板第 18、49 行，以及内容决定第 7–9 行。

这是明确采用的团队政策，原决定已承认小修复的独立提交成本，并要求没有真实增量时并入相关 PR。因此不能把它报告成偶然写错的规则。

文章关于减少过度规定和清楚界定完成边界的建议，使这项成本值得重新讨论。例如修复不改变任何取舍的说明错误时，实现可以完成，独立交付却仍依赖另一份合理决策增量。可以比较维持现状与对已有决定完整覆盖、没有新取舍的变更允许引用原决定两种方向，并以实际小任务和交付情况判断。现有决定第 49、93 行已经提供重开依据，当前审查不改选政策。

### D2：“关键方案”与一般实施调整的分界尚未明确

位置：[开发流程决定第 19 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/.agents/decisions/development/proposed/D-20260907-development-workflow.md#L19)、[工作指南第 33 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/docs/development/workflow.md#L33)。

现行要求禁止 AI 自行改变关键方案，并明确统一调整细则尚未制定。根入口和流程已有“既有授权不重复请求”的积极说明，但对于满足同一验收时改变内部实现、修正测试或调整调查路径，何时属于已有授权内的工作，何时构成关键方案改选，仍有解释空间。

建议讨论最小而明确的边界：以用户目标、已确认契约、职责或权限等实际影响判断关键变化，并说明普通实施修正的自主范围。这里需要清楚的决策边界，不必先增加一整套审批状态或固定路线。若代理在已授权任务中暂停，能够定位它所依据的具体规则，会有助于验证是否存在过度保守。

这是一项已知未决边界，不能仅凭本次静态阅读声称 Astra 已经发生重复确认或过早停止。

### D3：验证的选择和结束条件适合通过任务效果验证

位置：[工作指南第 43 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/docs/development/workflow.md#L43)、[工程指南第 32–42 行](https://github.com/TonQiaN/Agent_flow/blob/b1e94abb3fc895b007049266ece409e6af3e3eb8/docs/development/code-structure.md#L32)、开发流程决定第 54、56 行。

项目提供 `npm run check` 基础入口，也要求根据影响复测相关范围；没有查到“一切任务都必须反复跑全部测试”的明确要求。过去根布局修订执行过产品检查，属于已记录的单次行为，不能据此断言当前规则普遍导致无意义测试。

可以在本轮验证中观察：纯说明调整是否选用有意义的文档检查，行为修改是否覆盖受影响路径，证据充分后是否仍重复相同检查，以及代理是否完成必要修正后才交付。默认本地检查、Docker 检查和涉及真实凭据或模型的验收条件不同，不能照搬文章示例，把所有项目测试都声明为同一种无需核对的安全操作。

## 当前值得保留的内容

- 根入口已有按任务分类的工作指南链接，详细理由保留在负责决定中；优先修正具体触发条件，不能由决定较长就推导出应删除其取舍依据。
- 两份 AGENTS.md 均有清楚作用范围和唯一负责决定，CLAUDE.md 的相对符号链接有效。文件内容共享与工具效果差异已被明确区分，适合继续保留。
- 根入口第 50 行、agent_notes 目录第 11 行、开发流程决定第 17、25、43 行已承认既有用户授权、不要求重复批准、不强制启动期多人审批，并允许决定与实现同 PR。文章不是取消真实责任和授权边界的依据。
- 主 Issue 共通决定用目标、范围和成果表达需求，把实施方法留给负责人；这是减少过度步骤约束的已有成果。Sub-issue 自主表达也有用户明确依据。
- materials 原始内容按任务读取，正式决定、当前说明和原始资料分开，有助于控制无关上下文。PR #35 的局部入口较短，具体操作按需指向指南，已有原件保留和共享身份核对有实际风险依据。
- PR #35 的“新增资料不会自动上传”已在资料指南第 11 行明确，后续共享以实际资料任务为界；未发现必须把所有资料上传的要求。该局部规则尚未合入主线。
- 根入口决定第 31 行关于后续非源码目录指令的安排，应结合 #20 当前“有实际任务需要才新增”的范围理解；后续实施时同步这一表述，不能机械把每个目录都配一份指令当作完成标准。

## 建议涉及的负责记录

| 对象 | 唯一负责决定或关联依据 | 本轮建议性质 |
| --- | --- | --- |
| 根 AGENTS.md 的概览读取条件 | [根入口书写决定](../../.agents/agent_notes/development/README.md#d-20260910-root-agents-writing) | R1：明确触发条件；后续新增局部指令按实际任务需要 |
| 工作指南的例外、Blackbox 调查及实施边界 | [开发流程决定](../../.agents/agent_notes/development/README.md#d-20260907-development-workflow) | R2、R3；D1、D2、D3 中实际采用的变化按各自影响记录 |
| agent_notes 目录 AGENTS.md 的相关提示 | [agent_notes 目录书写决定](../../.agents/agent_notes/development/README.md#d-20260907-agents-writing) | 仅在其提示确实需随流程变化时同步；不能让流程决定成为第二个书写负责人 |
| “已有决定覆盖”与轻量改动说明 | [决策内容决定](../../.agents/agent_notes/development/README.md#d-20260907-decision-record-content) | D1 若改选才同步；保留真实取舍、同问题唯一正文 |
| 版本管理中的根入口链接 | [版本管理决定](../../.agents/agent_notes/development/README.md#d-20260908-version-management) | R4：修正现行引用，历史段落保持当时语境 |
| 主 Issue 与 Sub-issue | [共通写作决定](../../.agents/agent_notes/development/README.md#d-20260908-issue-template-common) | 已符合需求与执行分工方向，未建议新增子项模板 |
| materials 指令与共享入口 | [PR #35 中的资料管理决定](https://github.com/TonQiaN/Agent_flow/blob/5838eaf35cf01c135db116ebf9dcf33a53b26ee3/.agents/decisions/development/implemented/D-20260911-materials-management.md) | 继续由 #34／#35 承接，跟随其真实合并状态处理交叉变更 |
| 项目 Skill | 暂无实际 Skill 正文及独立技能实现 | 无可直接评审的描述、路由或脚本；今后按具体可复用任务决定是否需要 |

## 完成与未完成

本次交付是静态审查报告及索引入口，未修改 AGENTS.md、技能或正式决策正文，未发布 GitHub 评论、创建 PR 或改变 Issue 验收勾选。R1–R4 的文本问题已定位；D1–D3 仍是待讨论或验证事项。

未执行产品测试，因为本次没有产品改动，产品测试也不能验证提示词触发、授权判断或持续完成行为。跨工具加载、实际技能选择、任务完成率及改进效果仍需针对后续明确采用的变化取得证据。当前报告不能作为 #20 整体验收完成的依据。

## PR #35 合并后复查

2026-09-14，按用户“有了新 pr 合并，再检查一下 AGENTS”的要求复查。GitHub 显示 PR #35 于当日 16:16:58（UTC+8）合并，当前 main 为 `eaed47c77df250b0bbcb901c95415e9599a26d22`；执行 `git pull --ff-only` 返回 `Already up to date`。

当前三份指令均已读取，并核对对应负责决定及相关指南：

| 指令 | 当前行数 | 唯一书写决定 |
| --- | --- | --- |
| [根 AGENTS.md](../../AGENTS.md) | 54 | D-20260910-root-agents-writing |
| [agent_notes 目录 AGENTS.md](../../.agents/agent_notes/AGENTS.md) | 19 | D-20260907-agents-writing |
| [materials AGENTS.md](../../materials/AGENTS.md) | 18 | D-20260911-materials-management |

三处 `CLAUDE.md` 均为指向同目录 `AGENTS.md` 的相对符号链接，读取内容一致。三份指令中的 22 处本地链接及所用锚点全部通过检查。Git 在 materials 中仅跟踪约定的五个管理文件，本次未读取原始材料正文。

将已审查的 PR #35 提交 `5838eaf35cf01c135db116ebf9dcf33a53b26ee3` 与当前 HEAD 比较，根指令、`.agents/`、`docs/development/` 以及 materials 的 AGENTS、CLAUDE 和忽略规则均无差异。因此，初次审查中针对该 PR 的文本结论仍适用；材料规则已经成为主线现状。新增局部入口、负责决定和指南的职责衔接未发现新的冲突，仍未发现要求自动上传全部资料或无条件读取原始材料的规则。

上轮四项问题均未在本次合并中改变：

| 问题 | 当前定位 | 复查结果 |
| --- | --- | --- |
| R1：无条件先读项目概览 | 根 AGENTS.md 第 37 行 | 仍缺少与任务相关的触发条件 |
| R2：工作指南遗漏已有例外 | workflow.md 第 31、39 行；负责决定第 41、49 行 | 仍未带出已有文档覆盖时无需重写，以及没有实质决策变更的轻量改动如何交付 |
| R3：Blackbox 调查入口与适用边界不足 | workflow.md 第 25 行；负责决定第 33 行 | 仍缺少明确定位，以及无关、不可访问或无对应结果时的后续处理说明 |
| R4：根入口负责决定引用过时 | D-20260908-version-management.md 第 33 行 | 仍指向已不负责根入口的 D-20260907-agents-writing |

D1–D3 涉及的流程取舍与待验证行为也未随本次 PR 改变。本轮仅补充静态复查记录与索引说明，未修改项目指令或正式决定，未执行模型行为对照、产品测试或飞书共享操作；未将结构检查通过写成模型执行效果已验证。

## 四项修复实施与验收

2026-09-14，用户在逐项审阅改进方案后明确要求“请按你的方案实施”。本轮关联 Issue #20，TonQiaN 主责，Codex 实施与自查。开工预检可继续：已读取现行决定、有关 alternatives 与独立拒绝记录，核对 Issue 的范围及负责人；`git fetch origin` 后本地 HEAD 与 origin/main 均为 `eaed47c77df250b0bbcb901c95415e9599a26d22`。修订在 `codex/issue-20-instruction-fixes` 分支进行，具体版本以包含本文的提交及交付 PR 为准。

本轮先在既有负责决定中登记实际采用的取舍，再同步入口与指南。根入口的读取条件由 D-20260910-root-agents-writing 负责；指南例外和 Blackbox 规则由 D-20260907-development-workflow 负责；当前根入口归属引用由 D-20260908-version-management 修正。根入口修订落实并完成静态检查后恢复 implemented；整体开发流程仍未全部验证，继续保留 proposed。未新建决定、项目 Skill 或局部 AGENTS.md，D1–D3 仍待各自讨论或验证。

### Blackbox 入口的实际核实

通过 GitHub API 确认参考仓库为 [xiaoxuanli-a/Agent_workflow](https://github.com/xiaoxuanli-a/Agent_workflow)，该仓库为私有仓库，当前身份可读取；这不代表其他开发者已获得访问权限。身份核对同时使用历史版本的 [README](https://github.com/xiaoxuanli-a/Agent_workflow/blob/5610d1b89a9e4475b428fc7d7344f78bde326a77/README.md) 和本项目原有验证记录中的三个提交：

| 原有引用 | 已核实的完整提交及含义 |
| --- | --- |
| 5610d1b | [5610d1b89a9e4475b428fc7d7344f78bde326a77](https://github.com/xiaoxuanli-a/Agent_workflow/commit/5610d1b89a9e4475b428fc7d7344f78bde326a77)，v0.1.22 合并提交；其 README 标题为 Black-box Agent Workflow |
| 5f58036 | [5f580364778ebfe04a7fa4c085366bb878d70750](https://github.com/xiaoxuanli-a/Agent_workflow/commit/5f580364778ebfe04a7fa4c085366bb878d70750)，按订阅节点隔离 provider-state，与原验证记录中的修复描述吻合 |
| cd0e9f6 | [cd0e9f6fd89c60e15f0890202640f46b14f838fe](https://github.com/xiaoxuanli-a/Agent_workflow/commit/cd0e9f6fd89c60e15f0890202640f46b14f838fe)，补充订阅认证所需的 egress 范围，与原验证记录中的修复描述吻合 |

指南仅保留稳定仓库入口及查阅条件，历史定位证据留在本节。此次只核对仓库身份、README 与提交说明，未运行旧系统，也未把其历史验证当作本项目通过的证据。

### 修复结果与场景核对

以下为依据修订后文本逐项进行的场景核对，结果均符合已确认方案；它们不是新模型会话或实际故障运行记录。

| 场景 | 修订后的要求与核对结果 |
| --- | --- |
| R1：已定位的文档错字或链接修复 | [根入口](../../AGENTS.md) 按任务路由，概览不再是所有工作的前置步骤；适用的文档维护及目录规则仍有效 |
| R1：需要判断当前能力、未完成范围或寻找文档 | 根入口仍明确指向 docs/README.md，能力事实入口得以保留 |
| R2：已有文档完整覆盖本次工作 | [工作指南](../development/workflow.md#开工预检与文档) 明确确认适用范围即可，无需重写；新取舍先修订对应正文 |
| R2：轻量改动不存在有意义的决策变更 | 指南要求并入同一问题下含实质决策变更的相关 PR；只引用 ID、凑空修改或据此豁免独立 PR 门槛均不符合现行规则 |
| R3：旧系统已有相关实现或修复 | [Blackbox 入口](../development/workflow.md#blackbox-参考入口与调查边界) 可定位；优先按症状查阅，记录实际版本及环境差异，借鉴后验证本项目受影响范围 |
| R3：确认无关、无法访问或查无对应结果 | 说明依据或限制后继续本项目调查；无需穷尽旧仓库，不能将查无结果写成旧系统没有问题 |
| R3：缺失资料确实影响兼容性判断或验收 | 记录具体阻塞及所缺依据，并继续不依赖该资料的工作；不会把真实依赖当作已满足 |
| R4：从版本管理说明追溯根指令负责人 | [版本管理决定](../../.agents/agent_notes/development/implemented/D-20260908-version-management.md) 当前引用到 D-20260910-root-agents-writing；agent_notes 目录仍归 D-20260907-agents-writing |

### 检查与交付边界

使用 Python 标准库核对受影响指令、决定、指南、CHANGELOG、审查记录及索引，共 10 份相关 Markdown 的 106 处本地链接与锚点通过，22 个决定 ID 唯一。三处 CLAUDE.md 均为同目录 AGENTS.md 的相对符号链接，Git 模式为 120000，读取正文一致，文件回链与负责决定的受管清单对应。定向核对正式区域中的旧负责决定引用，剩余引用分别用于 agent_notes 目录归属、共有书写分工或历史迁移说明，均应保留。`git diff --check` 通过。

审查记录及索引同步，CHANGELOG 的 Unreleased 增加本次实际变化；本次未调整版本目标或范围，roadmap 不适用。本地未运行产品测试：此次没有源码、依赖或运行配置改动，产品测试不能证明代理的阅读与继续行为。仓库现有 CI 的结果在交付 PR 中按实际提交记录。

R1–R4 的文本与引用修复已在本分支落实。未执行跨工具加载实验、新模型会话或修改前后的行为对照，未测量 token、耗时、完成率或重复确认频率；当前静态结果不能推出所有模型的行为改善。实际审阅为 Codex 自查，未进行其他开发者审阅。交付使用 Refs #20，整体研究继续开放；分支交付、默认分支合并与整个 Issue 验收分别核对。
