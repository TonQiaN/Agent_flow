# Issue #6 分类与模板研究 artifact

2026-09-08。五类完整模板与七份决定已实施，GitHub 默认分支展示验证完成，PR #7 / #8 已合并，Issue #6 已关闭。正式决定位于 implemented；本 artifact 保存研究过程并链接最终交付。

- [交互阅读页](index.html)：当前事实、分类比较、30 场景筛选、五类模板和八份填写演练。
- [七项决定与存放设计](index.html#maintenance-design)：比较独立维护、共通规范与生成方式；给出七项决定边界、五类增删改和项目目录方案。
- [正式决定索引](../../../.agents/decisions/development/README.md#d-20260908-issue-classification)与[实施验证](../../../docs/validation/2026-09-08-issue-templates.md)：正式取舍与当前落实事实；本页保留研究过程。
- [完整文本](report.md)：与阅读页同源的完整研究内容。
- [候选模板](draft-templates/)：五份 YAML 和五份 CLI/API Markdown 正文骨架；不是一键部署包。
- [字段规格](template-specs.json)、[场景数据](scenarios.json)、[原 25 项映射](candidate-mapping.json)、[填写演练数据](examples.json)。
- [来源核对](sources/provenance.json)、[外部研究依据](sources/research-ledger.json)、[验证记录](validation.md)。

正文源为 `research-main.md`，表单字段与生成逻辑在 `build_artifact.py`。重新生成需要 Python 3 和 Pandoc：

```sh
python3 materials/artifacts/2026-09-08-issue-6-taxonomy-research/build_artifact.py
```

HTML 内联 CSS/JavaScript，正文和交互可离线读取；源文档链接按需访问本地文件或网络。此次只重新生成文本并核对本地引用，没有复测 artifact 浏览器排版；GitHub 实际表单的验证另见正式实施记录。正式模板是 `.github/ISSUE_TEMPLATE` 中五份 YAML；本目录的候选与生成器保留为历史材料。

用户已授权开始 [Issue #6](https://github.com/TonQiaN/Agent_flow/issues/6) 并要求设计七份决定。最终已交付模板、完整指南、12 份正式演练、两项 PR 与默认分支核对；实施结果见阅读页第 11 节和正式验证记录。
