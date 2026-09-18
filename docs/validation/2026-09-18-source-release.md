# 核心 v0.1.3 与完整项目 v0.1.4 源码发布交接

## 对象与范围

[Issue #44](https://github.com/TonQiaN/Agent_flow/issues/44)，人类主责 xiaoxuanli-a，Codex 执行和作者自查。用户先要求核心 0.1.3 与前端 0.1.4 一起合并，随后明确要求完成 #44，继续完成正式源码 tag、发布记录和关闭。原准备过程、首次 CI 失败及容量夹具修正保留于 [发布准备记录](2026-09-16-release-0.1.3.md)。

| 源码 tag | 确切交付提交 | 完整快照范围 |
| --- | --- | --- |
| [v0.1.3](https://github.com/TonQiaN/Agent_flow/tree/v0.1.3) | `461159cd4a680fbb791ad830b8b250f431f28898` | PR #45 原核心准备；根及五个工作区为 0.1.3，没有 Studio，包含原 #9–#16 交付及容量测试夹具修正 |
| [v0.1.4](https://github.com/TonQiaN/Agent_flow/tree/v0.1.4) | `2e44cf2d27f39475e27fe7c44cdcd098ebadbe22` | PR #45 合并后的完整项目；核心包 0.1.3、Studio 0.1.4，包含前端/历史/招聘、同期修复及本地优先的 PR CI 配置 |

v0.1.3 的提交是 v0.1.4 的祖先，已经随 PR #45 进入主干历史；没有创建额外产品实现分支。两个 tag 都固定整个文件树，包元数据不表示两个快照的核心文件完全相同。#47 的 Map/Fork 示例默认租约与错误报告修复实际不在 v0.1.3 中，因此 CHANGELOG 将该条归回 0.1.4，不补写进较早快照。

## 源码与 CI 核对

- 核心快照六份 manifest（根及五个工作区）的 version、private、内部精确依赖及对应锁条目核对通过；文件树中没有 `src/apps/studio`。相对最终核心产品基线 `352f38d9b6e2d94da310525716064ae7ba69a819`，src 只有五份 package.json 和两份已解释的容量测试/夹具修改。
- 历史清理后的精确核心提交重新推送临时验证分支，使用该提交原有工作流，在标准 Ubuntu runner 上执行 Node 24/26、干净安装及开启 Docker 的 `npm run check`。[Check 35315424286](https://github.com/TonQiaN/Agent_flow/actions/runs/35315424286)：首次运行两项均成功（Node 24 为 06:33:55–06:41:20 UTC，Node 26 为 06:33:55–06:40:16 UTC）。旧历史提交的 CI 仅保留历史身份，没有用它代替本次验证。
- 完整快照的文件树为 `8e891ed41e66df3463f330f0117b3b3becbd3965`，与 PR #45 受检 head `5dbb2a38d6a28856e47e478f63254835f5952e90` 一致。[Check 35313675967](https://github.com/TonQiaN/Agent_flow/actions/runs/35313675967) 在该 head/base 上首次通过全部 8 项：Quality、Unit 24、Unit 26、Docker integration、Workflow acceptance、Browser journeys、Screenshot comparison、CI required。这是同一文件树的 PR 验证，不声称在合并 SHA 上另跑了一轮。
- 完整快照的七份 manifest、内部依赖和 125 个 node_modules 锁条目、干净安装、本地检查及 Studio 构建已在 PR #45 核对；本次事实回填仅修改 Markdown，不改变产品源码、依赖、工作流或截图基准。
- 两个 tag 的文件树均只跟踪 materials 的五份管理文件；推送前历史与凭据检查通过。原始资料不进入本次 tag 或文档提交。

## Tag 回执与发布事实

实际发布日为 **2026-09-18**。创建前读取本地及远端，两个同名 tag 均不存在；分别创建 annotated tag，只推送对应 ref，再通过 `git ls-remote` 读取 tag 对象及 `^{}` 所示的 peeled commit。

| tag | 远端 annotated tag 对象 | 远端 peeled commit |
| --- | --- | --- |
| v0.1.3 | `cc74a97a82e134ef2dcccd1c9b20f14f5e4bc965` | `461159cd4a680fbb791ad830b8b250f431f28898` |
| v0.1.4 | `a761c559e9ad84c656f63e1862625aba0414f1e2` | `2e44cf2d27f39475e27fe7c44cdcd098ebadbe22` |

两个远端 tag 对象均与本地 annotated tag 一致，peeled commit 均等于选定的完整 SHA。没有覆盖或移动历史 tag，没有创建从未发布的 v0.1.1/v0.1.2。CHANGELOG 补实际日期与 tag，Roadmap 标为已发布；事实回填的文档提交不成为新的 tag 目标。

## 文档交接与限制

9 份 Markdown 的本地链接、锚点、三组 AGENTS/CLAUDE 符号链接和差异检查通过；原有 60 条 CHANGELOG 条目全部保留，仅改写两条版本元数据说明并调整发布归属。版本管理决定实质补充两个源码快照与包版本的区别、按各自提交验证及后续事实回填不移动 tag 的边界；没有新增用户未讨论的 alternatives。

本次文档 PR 的精确 head/base、完整必需 CI、自查和实际合并结果在 [Issue #44](https://github.com/TonQiaN/Agent_flow/issues/44) 及其关联 PR 中续接；只有默认分支读回和全部验收完成后才关闭 Issue。源码 tag 的回执独立于后续文档 PR 的提交身份。

本次由 Codex 自查，没有其他开发者独立审阅记录。未重新进行付费真实模型调用；沿用 [官方联合验收](2026-09-15-official-harness-acceptance.md)、[学生分阶段样本](2026-09-10-tutor-student-input.md)和 [工作台验收](2026-09-15-issue39-studio.md) 各自明确范围，不扩大为冷启动一次成功、真实模型完整矩阵、生产 Tutor 或公网部署的证明。所有包保持 private，本次是 Git 源码 tag 发布，没有 npm 分发或额外 GitHub Release 正文。
