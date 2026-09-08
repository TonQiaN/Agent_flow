# 研究 artifact 验证记录

验证日期：2026-09-08（Asia/Singapore）。基线：`main@f3bdd38d2da951de0e1f48646b9e49e7f7154855`。

验证对象是研究文本、候选模板、填写演练和阅读页。首版 30 项静态与内容一致性检查通过，结果及时间见 [static-checks.json](sources/static-checks.json)。随后先完成结构设计，再按用户明确采用的方案写出七份正式决定。下述早期检查保留当时结果；本轮正式模板的线上核对另见新增实施记录，未进行产品实验。

## 实施完成后的 artifact 更新

五表与七份决定、指南和 12 个填写演练已交付，PR #7 / #8 合并且 Issue #6 已关闭。GitHub 的选择器、五类字段、四交付选项、研究多选及验收清单 Preview 已实际核对；正式证据见 [实施验证](../../../docs/validation/2026-09-08-issue-templates.md)，最终提交与关闭事实见 [完成快照](sources/implementation-provenance.json)。

本次更新研究页顶部状态、已落实目录、最终七项验收映射与当前指南链接；基线快照、原候选和八份早期演练保留为历史。重新生成 Markdown/HTML 后检查本地引用与锚点，不据此声称复测了 artifact 的浏览器排版或交互。以下各节是早期阶段的检查记录，不表达最终未完成事项。 本轮重新生成成功，index.html / report.md / README.md / validation.md 的 194 处本地引用、110 处锚点和 177 个 HTML ID 检查通过；无外部运行资源，逐项结果保存于 `sources/implementation-artifact-checks.json`。

## 七份正式决定成稿

用户最新要求采用共通规范＋五类差异并设计七份决定。七份正文现已写入开发流程类 proposed，稳定索引、原流程决定和当前指南已同步；artifact 更新为能定位这些正文的研究入口。此时正式文档已发生实质改动，早期“正式文件未改”的核对仅对应先前研究阶段。

当前正式范围与检查结果见 [七份决定设计验证](../../../docs/validation/2026-09-08-issue-template-decisions.md)，本轮逐项结果与七份正文摘要校验值见 [decision-write-checks.json](sources/decision-write-checks.json)。15 项检查通过；新表单与完整使用页仍未实施，Issue #6 未关闭。

## 本轮设计补充的核对

用户认可五类方向后，更新了确认状态、七项决定的职责与目标 ID、共通/独立维护比较、五类增删改及存放/同步方案。新增内容属于研究设计，正式决定和五类模板部署仍未实施。

- 五类表单共有八个字段 ID，其中七个字段的结构与文字完全相同，`problem` 按类别调整；与正文维护判断一致。
- 设计恰好列出七个拟定决策 ID，目录与同步方式归共通决定，无第八项新增决定。
- 五份 YAML 重新解析后仍与字段规格一致；生成文本无残留占位符。
- 当前阅读页 76 处本地链接及其中 53 处锚点有效，177 个 HTML ID 无重复。
- `git diff --quiet HEAD` 通过，正式规则与模板未被覆盖；源码中的“五类还是合并成四类”已从当前待决问题中移除，历史比较仍保留。

结果见 [maintenance-design-checks.json](sources/maintenance-design-checks.json)。维护成本比较属于有项目结构依据的设计判断，并非长期效果实测。下表的链接计数对应首版，当前页以上述追加记录为准。

## 首版已完成的检查

| 对象 | 方法与实际结果 |
| --- | --- |
| 构建 | 使用 Python 3 + Pandoc 生成完整 Markdown、内联 HTML、五份 YAML、五份 CLI/API 骨架及八份填写样例，命令正常结束。 |
| YAML | 六份文件（五类表单及 config）经 Ruby `YAML.safe_load` 解析；五份表单与 `template-specs.json` 逐值一致，config 保留 `blank_issues_enabled: false`。 |
| 表单结构 | 五份模板分别有 9 / 10 / 10 / 10 / 9 个输入块；每份字段 ID 唯一，使用 input / textarea / dropdown，校验属性类型、名称长度及标题等结构。未预设类别标签、组织 type 或固定 Assignees；验收字段未设置 render。此检查不是 GitHub 官方线上校验器。 |
| 八份填写演练 | 每份示例字段与所属模板一致且非空，交付物来自候选选项，独立 Markdown 与源数据一致。覆盖五类、仅决策交付、否定结论、尚未复现及父子结构；均明确标为演练。 |
| 30 个场景 | 编号唯一、类别引用有效，HTML 中对应 30 张筛选卡片，无遗漏。实际事实、已讨论方向与假设场景分别标注。 |
| 原候选映射 | 25 项编号与标题逐值对照旧 `issues.json`，无缺漏；归类为 14 功能、8 决策、2 研究、1 维护。 |
| 阅读页引用 | HTML ID 无重复；73 处本地链接目标存在，其中 51 处锚点已解析目标 HTML 或 Markdown 核对。外部资料由研究过程核对，未用批量链接检查替代来源阅读。 |
| 页面与脚本 | JavaScript 通过 `node --check`；HTML 内联一份 CSS 和一份脚本，没有外部样式、脚本、图片或字体依赖。静态检查无未展开的构建标记。 |
| 原资料与正式文件 | 26 份已记录来源文件的 SHA-256 与研究开始时一致；`git diff --quiet HEAD` 通过，正式决定、指南、模板均未被研究草案覆盖。 |

静态检查曾发现完整 Markdown 中遗留一个只供 HTML 构建使用的交互插槽注释，已在生成器中移除并复查通过。HTML 的相应选择器保持完整。

## 内容核对

- 保留前端只读、外围时间与输入输出回放、镜像与节点能力分层、三 Harness 独立模块的用户确认；没有把运行工作区指令文件与本仓库 AGENTS.md 治理混为一项。
- 以当前默认分支和真实 Issue / PR 纠正历史快照中的状态差异；没有把旧材料、研究建议、演练内容写成已生效规则或已发生事故。
- 五类是研究建议，和四类、三类及通用模板做了比较；八份演练不构成真实填表效率或产品能力的证据。
- 对照 Issue #6 七项验收，分别列出本阶段输入与尚待落实部分；没有将研究 artifact 当作完整 Issue 交付。

## 尚未验证及后续验收

- 浏览器实际排版、筛选/展开/选择器、移动端、打印和键盘操作未实测。
- 新模板尚未进入 `.github/ISSUE_TEMPLATE` 或默认分支；未核对 GitHub 模板选择、实际表单显示、私有仓库必填行为或 CLI 提交后的真实正文。
- 未运行 Container、DSH/Codex/Claude 能力实验、回放产品测试，也未创建示例 Issue。
- 分类一致性、填写负担、长期交接效果需要真实工作项试用；本研究未测量这些指标。

正式落地仍需对应决定的实质修订、选定模板与指南变更、PR、合并及默认分支核对。上述未验证部分不能据静态通过自动勾选完成。

## 本地复核入口

```sh
python3 materials/artifacts/2026-09-08-issue-6-taxonomy-research/build_artifact.py
node --check materials/artifacts/2026-09-08-issue-6-taxonomy-research/interactions.js
ruby -ryaml -e 'Dir["materials/artifacts/2026-09-08-issue-6-taxonomy-research/draft-templates/*.yml"].sort.each { |path| YAML.safe_load(File.read(path)); puts path }'
```

这些命令可重建内容并复核脚本/YAML 语法；完整本轮静态核对的对象、方法和结果保存在前述 JSON 中。
