# Issue #39：本机工作台整体验证

2026-09-15，macOS、Node 24.18.1、Docker Desktop。主负责人 @TonQiaN；Codex（Astra）实施、真实浏览器操作和作者自查，尚未独立人类审阅。第三层基于 `16fec91`（同步 main `c8e1890` 的版本交接文档），前置 PR #40 → #41；本记录不表示已经合并或发布。

## 真实招聘运行

从浏览器同一个上传弹窗提交一个岗位和三份合成简历，使用用户授权的 DeepSeek 测试凭据、`deepseek-flash` 与真实隔离容器。

- Run：`run-f8f70874-8c69-4717-9b35-895896946f26`。
- 结果：`succeeded / completed`，21 个主流程步骤、23 个子运行、6 项岗位要求、41 个文件条目。
- 陈晨（合成）“推荐通过”；林晓（合成）、周宁（合成）“推荐不通过”。无总分、加权分或排名。
- 独立复核发现周宁的 TypeScript“未写明”被错误写成“不支持”，证据关卡先 `revise`，修正为“未证实”后 `passed`；修正前后步骤和材料均保留。未知/冲突对最终推荐的影响有明确说明。
- 下载并按 SHA256 核对 11 份最终报告文件。`reports/results.json` 与引擎最终输出完全一致；三份 PDF 的姓名、二元结论及全部引用原文与 JSON 相符。Astra 在页面实际查看了中文 PDF，并核对分页后的文字。

PDF 摘要：

| 文件 | 字节 | SHA256 |
| --- | ---: | --- |
| c1.pdf | 82588 | `85a076551b224bdd176c64f1fc93406ab77f008ae2ac82c5032f5ae885c03239` |
| c2.pdf | 62933 | `6c76d8e7045c24955a479f1f5279f3e3a33ccd0c2f55d307506c7fa6d5c4025d` |
| c3.pdf | 75500 | `f8e7b5a37d33ca5b5c436a89482f06146484f0ce4c965a658c4b600d50a9d2c5` |

## 验收对应

| 要求 | 已执行的验证 |
| --- | --- |
| 画布、拖动、节点与连线 | 浏览器拖动并核对位置；点击节点各页签和连线，显示实际输出契约、方向与返工限制；仅显示位置改变 |
| 一次上传与启动 | 真实招聘 4 份材料一次提交；浏览器缺材料反例、材料归属、进度、重复请求幂等测试 |
| 容器与历史设置 | 实际镜像摘要、CPU、内存、网络、挂载与完整绑定；历史只用保存的定义，非容器节点明确说明 |
| 现有入口 | 9 个登记入口可查看；原检查返工从页面完成，原 Map/Fork CLI 运行出现在历史；DeepSeek Agent 批卷及持久化批卷实际完成 |
| 并行、等待、返工、重试 | 实际引擎/队列六场景：正常、候选人返工、岗位返工、重试、失败、取消；不同任务与 Attempt 身份可区分 |
| 结果与文件 | 三人对照、逐项证据、个人 PDF；文本、JSON、图片、PDF 预览及下载；不可用归档保留明确占位 |
| 历史与回放 | 工作流/状态/本机日期筛选；分页、播放/暂停/逐步/滑块；起点无未来子任务和结果；读取前后 revision 不变 |
| 数据继续保留 | 实际服务重启后重新打开真实记录和文件；原 CLI 历史可发现；SQLite 重开及迁移测试 |
| 缺失和连接错误 | 无符合条件记录、服务断线/重连、缺失归档、未知旧时间、损坏数据反例；不补造数据 |
| Codex 过程 | 下述真实容器/原生模型/会话与页面展开核对 |
| 用户体验报告 | Astra 实际点击、跳转、拖动、截图并检查；发现问题已修正和复查。仅本地 `materials/issue39-user-report/USER-REPORT.md` 及截图 |
| 本机使用说明 | [部署指南](../guides/local-studio.md)列出环境、认证、全部入口、材料和使用步骤 |

## 原入口与 Codex

原 DeepSeek Agent 批卷 `run-5a4d2766-f395-445b-bafc-3215db00da83`、持久化批卷 `run-b04f9f40-eb8d-4f1a-b091-c31dec7de125` 均 `succeeded / published`；发布是本机 SimulatedEffectService。页面返工 `run-c3275a65-18d8-4348-9be2-76f27eca2ca6` 完成 5 步。原 CLI Map 与 Fork 分别留下 `cli-6d9ebe53-27cb-4faa-a325-0b0cb1c1da7c`、`cli-b830bc4e-b95d-4657-953b-06f114a66628`，子运行与顺序保留。

Codex 0.153.4 + `gpt-6-astra` 在真实容器执行原批卷工作流：`run-9528ce7e-8b0f-476e-b171-fcd20d380fbb`，5 步，`succeeded / published`。实际网页展开 `command_execution` 事件；保存了 15 条 stdout、1 条 stderr、session 和 capture。会话 envelope：`complete=true`、`truncated=false`、`error=null`、1 份 records、`memory=disabled`。另一个最小工具探针完成两次文件工具操作，保存的会话记录包含消息、工具调用及返回。未出现的思考摘要不补造，隐藏完整 CoT 不承诺可得。

本机 VPN/DNS 把 Codex 目的域名返回保留网段，原 CONNECT 代理按规则拒绝。上述 Codex 真模型验证使用本地测试代理镜像：仅对已允许的 `chatgpt.com`/`auth.openai.com` 通过 DNS-over-HTTPS 取得公网地址，继续执行既有目标和公网校验。未更改宿主 VPN 或放宽隔离规则，该测试镜像未随代码提交。团队遇到相同环境问题应先修复 DNS。DeepSeek 真实招聘使用默认受控代理成功。

## 检查与修正

- `npm run check`：426 个普通测试、17 个 E2E 通过，195 个需要显式环境开关的用例默认跳过；共 443 通过、0 失败。
- 招聘实际 Docker 矩阵 6/6，通过时间 174.4 秒。只替换模型响应，队列、子进程、文件、解析、关卡和 PDF 均真实执行。
- 离线格式测试 1/1：MD、TXT、DOCX、双页文本 PDF、PNG/JPG/JPEG 和扫描 PDF，核对文字、分页与 OCR 来源。
- Chromium 完整旅程、四个故障场景和断线重新查询历史共 6/6，通过时间 2.4 分钟；远端结果以 PR 当前检查为准。
- 新增直接修订/时间查询测试，验证相同时间的保存顺序、未知时间排除、边界与摘要损坏拒绝。相同真实运行第 50 条回放查询从约 1.84 秒降至约 0.17 秒；单次本机测量，不作为固定性能承诺。
- Node 24/26 Docker 矩阵和 Chromium 检查的远端结果以该层 PR 当前 Checks 为准；凭据和真模型任务不进入 CI。

实际体验中修复：模型省略调度身份时错误拒绝、PDF 插件空白与 worker MIME、回放混入未来信息、历史分页被重置、播放时切换任务的记录竞态、失败草稿释放前漏存、缺失归档无提示、长理由挤满对照表、窄屏导航名称、跳转保留旧滚动位置、日期边界使用 UTC、重连未刷新历史、构建产物被边界检查当成源码。修正后执行对应浏览器、存储或 Docker 回归。

## 限制与参考

Tutor 扫描件/报告入口已绑定原应用、上传契约和明确的环境要求；本机未安装外部 Tutor，本轮未重复执行真实 Tutor 学生材料。既有 Tutor 专项记录保留其原范围，不能用招聘验证替代。文档最多 60 页；DOCX/TXT/MD 的第 1 页为逻辑全文，OCR 需对照原图。首版只支持本机、启动和查看，没有设置编辑、取消/恢复页面或共享服务。

参考 Blackbox `xiaoxuanli-a/Agent_workflow` 提交 `4dc0f4ac630d6e54036dcbfafa1a4ae7ce2fa345` 的镜像/代理对应实现，已区分其 Python 代理与当前 Node 代理。前端使用 [React Flow 官方 API](https://reactflow.dev/api-reference/react-flow) 与 [PDF.js canvas 示例](https://mozilla.github.io/pdf.js/examples/)，未复制 ComfyUI/Dify 应用代码。原始截图、下载报告和私有凭据不进入 Git。

远端首次干净安装发现 `studio:typecheck` 先于工作区声明构建，导致找不到 integrations 类型。已将依赖构建放入该命令的前置步骤，使用不含 node_modules/dist 的独立源码副本复查安装与完整检查；不靠放宽 TypeScript 规则消除错误。

最终补查还复现了日志归档回调失败后临时输出仍残留的问题。修复前 cleanup 后有两个文件快照，修复后只保留调用者持有的输入；Agent、脚本和无效脚本输出三种路径均返回明确记录失败，回调只调用一次，重复清理安全。对应文件 Workflow 测试 15/15 通过。Blackbox 同版本的 collector/artifacts 未提供当前 TypeScript 观察回调对应方案，本轮按当前资源所有权规则修复。

Linux CI 暴露两项环境问题：夹具容器生成 root 所有的目录导致测试清理 EACCES，已用宿主 UID/GID 生成；招聘宿主自设 3 秒租约在浏览器并发读取下报 QUEUE_CLAIM_LOST，已恢复引擎默认 30 秒租约，仍按原心跳与过期规则执行。浏览器测试同时检查进程完成错误并保留合成运行的 worker.log/completion.json，避免把进程错误拖成轮询超时。
