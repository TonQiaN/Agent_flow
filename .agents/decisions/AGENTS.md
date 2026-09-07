# 决策系统的操作规则

作用范围：.agents/decisions 及其子目录。唯一书写决策：[D-20260907-agents-writing](development/README.md#d-20260907-agents-writing)。

## 记录与修订

1. 先查对应分类索引、相关现行决定、alternatives 与 rejected，避免重复研究已有否决依据的方案。用 [共同模板](TEMPLATE.md) 提炼，原始讨论不直接成为项目约束。
2. 同一问题保留一个稳定 ID 和一份正文；正文不再写 status，生命周期以目录表达。移动文件保留 ID，同步分类 README 的唯一正文路径；其他正式引用通过索引锚点定位。
3. 依 [生命周期决定](development/README.md#d-20260907-decision-lifecycle) 转换目录；依 [内容决定](development/README.md#d-20260907-decision-record-content) 维护结论、范围、真实比较、影响与验证、重开条件、确认及实际审阅情况。
4. 改选后的旧方案及其理由合并进同一正文的 alternatives，不设 superseded 层；独立拒绝才进入 rejected，不复制相同理由。已有决定正在讨论修订时，现行结论继续有效，待决修改另作明确标注。
5. 确认与审阅必须如实记录。Issue 保存讨论、分工、审查及针对具体方案的确认，决定只保留必要摘要和 Issue 定位；共同审查与启动期取舍按开发流程决定执行。已有明确授权可登记后实施，不重复索取确认；范围落实并验证后可在同一任务中移入 implemented。
6. 同步受影响的当前说明与验证结果。proposed 涵盖尚未全部落实的决定，能否实施按明确确认依据判断，不单凭目录推断；只有实际落实与验证才能支持 implemented，archived 不约束当前工作。原始资料变动不要求修改正式决定。
7. 提交 PR 前按 [开发流程决定](development/README.md#d-20260907-development-workflow) 核对相对本 PR base 的实质决策正文变更；只有引用 ID、索引变更或空改动不满足要求。保持同问题一份正文，不为每个 Issue 或 stack 层重复新建决定；事实与证据的工作日志留在 Issue / PR 或 docs。

## 文件分工与完成检查

- 本目录 AGENTS.md 保存执行规则；README.md 及分类 README 只说明、导航和定位，不维护另一套指令正文。
- 本文件及项目其他 AGENTS.md 的书写沿用各自唯一负责决定；实质修订回到该决定记录理由，不能为同一文件再增加共同管理决定。
- 完成前核对：单一正文、目录效力、索引和正式链接、实际审阅与验证事实，以及受影响 AGENTS.md 的唯一归属。校验当前文档，不把未完成流程写成已经执行。
