# 文档管理设计材料包

- 日期：2026-09-07。
- 类型：当前用户请求、会议证据核对、AI 起草的设计讨论。
- 范围：文档管理骨架；不包含产品架构实现。

| 文件 | 来源与效力 |
| --- | --- |
| [sources/request.md](sources/request.md) | 当前用户原文，是本轮明确要求的依据 |
| [discussion.md](discussion.md) | AI 整理的冲突核对、遗漏与建议；建议不自动生效 |
| [index.html](index.html) | 同一讨论文档的可视化阅读版 |
| [build_artifact.py](build_artifact.py) | 从讨论原稿生成阅读版，依赖 Python 3 与 Pandoc |

相关证据：[9 月 5 日会议材料](../coe-meeting-2026-09-05/README.md)。提炼去向：[已明确的三层分离](../../.agents/decisions/development/D-20260907-documentation-layers.md)、[生命周期提案](../../.agents/decisions/development/D-20260907-decision-lifecycle.md)。

重新生成：在仓库根目录执行 `python3 artifacts/2026-09-07-documentation-management/build_artifact.py`。编辑源为 `discussion.md`，阅读版不单独维护另一份内容。
