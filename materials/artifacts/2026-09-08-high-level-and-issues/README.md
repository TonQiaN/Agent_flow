# AgentFlow 功能与 Issue 讨论 artifact

日期：2026-09-08。状态：仅讨论，尚未启动建立 Issue 或正式决策变更流程。

已纳入后续三点补充：历史只录外围时间/状态/输入输出；镜像环境与节点 skill/MCP 等 Harness 配置分开；DSH、Codex、Claude 独立模块维护原生设置。正文与受影响候选 Issue 的范围、产物和验收同步更新，仍保留 8 项原计划 + 17 项额外候选。

- [交互阅读页](index.html)：包含完整正文、25 项候选 Issue、来源跳转，可搜索、筛选额外 Issue、展开验收。CSS/JavaScript 已内联，直接打开即可离线阅读；原始资料链接指向现有本地材料或飞书。
- [完整 Markdown](discussion.md)：同一内容的文本版本。
- [候选 Issue 数据](issues.json)：8 项原计划、17 项额外候选，均有范围、产物、依赖、验收、决策归属和待确认事项；不是批量提交任务。
- [来源核对记录](sources/verification.json)：初版飞书私聊读取与归档对比、历史逐字稿快照及仓库基线；本次只按用户补充修订，未重新获取飞书资料。
- [初始六项要求](sources/user-request.md)与[后续三点补充](sources/user-clarifications.md)：用户要求原文。
- [验证记录](validation.md)：页面与材料静态检查结果及限制。

正文编辑入口是 `discussion-main.md`；Issue 数据维护在 `build_artifact.py` 中，构建同时生成 HTML、Markdown 和 JSON，避免分别编辑三个输出产生不一致。

需要 Python 3 和 Pandoc，重新构建：

```sh
python3 materials/artifacts/2026-09-08-high-level-and-issues/build_artifact.py
```

研究材料不自动成为项目规则。本轮没有创建或提交 Issue/PR、发布版本、修改正式 decisions/模板，也没有开始 Container 研究实验。进入正式工作应根据届时授权和现行流程确认范围与主责。
