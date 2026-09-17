# 本机工作台

面向 #39 的本机服务位于 `src/apps/studio`，固定执行入口位于 `src/examples/studio/entry.ts`。团队成员各自拉取代码、安装并运行。历史和文件保存在自己的电脑；真实模型节点会把本次任务材料交给所配置的模型服务。React + TypeScript 页面提供工作流画布、启动、运行详情、报告、文件、历史和回放。

## 环境与启动

需要 Node.js 24 或 26、npm、Docker。普通检查：`npm ci && npm run check`。

```sh
npm ci
npm run studio:build
docker pull node:22-bookworm-slim
docker build -f src/apps/studio/docker/Dockerfile.documents -t agentflow/studio-documents:issue39 .
docker build -f src/apps/studio/docker/Dockerfile.deepseek -t agentflow/studio-deepseek:0.1.1-rc.2 .
# 使用 Codex 时再构建：
docker build -f src/apps/studio/docker/Dockerfile.codex -t agentflow/studio-codex:0.153.4 .
npm run studio
```

服务仅监听 `127.0.0.1:3587`。`PORT` 可更换端口；`AGENTFLOW_STUDIO_DATA` 可选本机数据目录，默认项目 `.local/studio`。技术设置在该目录的 `config.json`，更改后重启服务。

```json
{
  "harness": "deepseek",
  "credentialStore": "/absolute/private/credentials",
  "credentialRef": "default",
  "model": "deepseek-flash",
  "image": "agentflow/studio-deepseek:0.1.1-rc.2",
  "proxyImage": "node:22-bookworm-slim",
  "documentsImage": "agentflow/studio-documents:issue39"
}
```

不要把 API key 填进 config、前端或 Git。按[认证指南](auth-management.md)导入本机私有凭据。Codex/Claude 按[订阅登录](subscription-login.md)使用各自凭据。镜像版本必须与当前 Adapter 一致；DeepSeek 工具依赖含固定 Cordis 4.0.1。运行开始后固定镜像摘要，重建标签不影响已启动的招聘流程。

## 怎么使用页面

1. 打开 `http://127.0.0.1:3587`，先看“本机设置”。提示缺少镜像、凭据或 Tutor 时，按提示在本机准备好，再点“重新检查环境”。
2. “工作流”默认列出 5 个业务工作流，每张卡片有名称、ID、节点数量和实际步骤预览。Map、Fork、检查返工等 4 个原有示例在“技术示例”页签。同类批卷的不同流程分别列出。打开流程后，画布显示这个流程的全部节点；“运行记录”列出它自己的历次运行，画布上方的“查看完整运行”可直接打开最近完成的一次。
3. 画布从左到右展开，默认保持节点可读，通过拖拽空白处或触控板平移浏览后续步骤。所有连接使用曲线，线上的文字说明传递内容或流转条件；虚线返工同时标明目的和次数上限。点击曲线或文字可看连线详情。拖动节点只调整这台浏览器的布局；“自动布局”恢复横向排列和可读比例，“回到起点”返回开头，“适应画布”按需查看全图。默认不显示空详情栏，点击节点或连线才展开详情。此前折行版的本机布局不会覆盖新的默认布局。
4. 点“发起运行”。在同一个弹窗中准备全部材料，可以点击选文件，也可以拖入对应框。招聘只选一个岗位，每份简历放到对应候选人下面；补充材料也要选好归属。确认后只启动一次。
5. 启动后直接进入本次运行画布。完成节点和已走路线标绿，当前步骤标蓝，未执行节点保持灰色；“定位当前步骤”找到运行或回放当时的位置。点击并行节点可进入那一轮的候选人子任务；上方路径可返回所属节点和原轮次，或回到主流程。返工在节点标记执行次数，并可切换查看；重试保留 attemptNumber。“步骤与并行任务”仍提供总览。
6. “结果与报告”显示最后经过检查的结果。招聘会显示每人的二元推荐、逐项证据、缺失/冲突影响和面试问题；点击个人 PDF 可以翻页、查看本页文字或下载。“文件”还可预览原始材料、JSON、文本和图片。未被节点接纳的输出标为草稿，丢失文件会明确提示。
7. 点击节点默认打开“任务”，可看任务说明、完整 Prompt 或脚本命令、输入输出要求；长 Prompt 可展开、滚动和复制。“设置”显示任务容器与版本检查容器的镜像、CPU、内存、网络，目录可展开。流程定义标注“当前流程定义”，运行详情标注“本次运行已保存”；历史缺少 Prompt 或配置时明确说明，不拿今天的配置补写。没有任务容器的宿主/合成节点，以及上传后才生成的脚本命令，分别说明。查看配置只读取定义，不运行节点。
8. 在“运行历史”按流程、状态和本机日期筛选。进入记录后可播放、暂停、逐步或拖动滑块回放；历史超过一页时加载更后的记录。子任务、结果、日志和文件随所选时间变化；回放不执行任何节点。点击“回到当前”退出回放。

首版操作是上传、发起运行和查看。技术设置、流程连接、取消、恢复均没有页面修改入口。浏览器刷新或本机服务重启不会清空历史；启动进程独立保存完成标记。

## 现有入口接入表

| 工作流 | 原有代码 | 页面输入 | 环境 |
| --- | --- | --- | --- |
| 检查与返工 | `workflow.mjs` | 无，使用原合成示例 | Node |
| Map / Fork | `json-parallel.mjs` | 无，使用原合成示例 | Node |
| 合成批卷 | `tutor-grading/fixture.ts` | 无，使用原固定响应 | Node |
| Agent 批卷 | `tutor-grading/flow.ts` | source/paper.json、key.json、submission.json | Agent、Docker |
| 持久化批卷 | `tutor-grading/persistent.ts` | 同上 | Agent、Docker；本次本机模拟发布 |
| 扫描件批改 | `tutor-marking/application.ts` | 完整 source 材料目录 | Agent、Docker、Tutor |
| Tutor 报告 | `tutor-report/application.ts` | source 与已批改的 candidate 目录、报告信息 | Agent、Docker、Tutor |
| 招聘匹配 | `recruitment/flow.ts` | 一个岗位、多份简历及归属明确的补充材料 | Agent、Docker、材料镜像 |

Tutor 在 config 添加绝对路径 `tutorWorkspace` 与 `tutorPython`。缺少外部环境时页面显示条件，不宣称已经验证真实 Tutor 材料。单独 Component/Runner 演示（CLI sum、docker-script、codex-subscription）不属于完整 Workflow；其组合基础由原有测试覆盖。

原 `workflow.mjs`、`json-parallel.mjs`、批卷、扫描件和报告的 CLI 调用也会留下查看历史。`AGENTFLOW_HISTORY_DISABLED=1` 仅用于显式关闭测试/临时示例记录。测试运行器默认关闭，页面启动指定本次目录时强制记录。原有持久化调用使用自行指定的 SQLite/Archive；不能从裸 snapshot JSON 恢复未保存的文件或内部日志。

## 招聘材料与结果

一次提交全部材料：1 份岗位、1–12 位候选人、每位 1 份简历；可追加岗位或候选人的补充材料。支持 PDF、DOCX、TXT、MD、PNG、JPEG。每文件最多 20 MiB，最多 64 文件、合计 128 MiB、每份文档最多 60 页。PDF 保留实际页码，文本不足时 OCR；OCR 结果仍需对照原图。TXT/MD/DOCX 采用逻辑第 1 页保存全文，不声称复原 Word 打印分页。代码中有文本量与结果契约限制，超过时显示失败原因。

当前招聘流程只有 4 个节点：**读取材料 → 匹配与推荐 → 独立复核 → 生成报告**。读取与报告由断网脚本执行；中间两个节点分别执行一次 Harness。匹配节点一次完成岗位拆解、全体候选人的逐项分析与二元推荐，复核节点独立核对全部结果。分配、汇总和格式检查放在节点内部。引用必须找到原文件、页码及原文，复核或宿主校验发现错误时返回匹配节点，最多返工两轮；持续错误则结束且不交付候选人结论。最后逐项说明证据，输出“推荐通过”或“推荐不通过”，没有总分和排名。缺失/冲突说明怎样影响结论；执行失败不自动成为候选人不通过。最终校验后生成候选人对照表、个人 MD/HTML/PDF 和 JSON。

`src/examples/recruitment/fixtures` 是明确标注的一个岗位和三份虚构简历。`AGENTFLOW_STUDIO_FIXTURE=1` 启用合成模型响应与显式故障场景，仍执行真实队列、文件解析和 PDF 渲染；不能把这项验证当成真实模型能力证明。

```sh
AGENTFLOW_STUDIO_TESTS=1 AGENTFLOW_HISTORY_DISABLED=1 node --import tsx --test src/tests/e2e/studio-recruitment.test.ts
```

## 数据和限制

每次运行保存 meta、上传件、SQLite 修订与事件、归档文件。历史与回放接口只读，没有取消、恢复接口；启动仅通过独立上传入口；文件按已登记 ID 读取并验证摘要，HTML 按文本预览，PDF 用本地 PDF.js canvas 查看器渲染，不依赖浏览器 PDF 插件。历史不自动清理。重启后缺失、损坏或中断会明确显示；旧记录没有的时间、内部日志和设置不会补造。旧招聘记录仍显示当时的 14 节点，新的运行显示 4 节点；不会用新定义覆盖旧历史。

日志记录公开可获取的工具调用、消息、事件与 session 记录。隐藏 CoT 不在接口能力内；Codex session memory 在此隔离任务中关闭。截断、失败、无记录分别标注。凭据由已有 Adapter 脱敏，展示层再过滤敏感字段。


## 本机验证与 CI

```sh
npm run check
AGENTFLOW_STUDIO_TESTS=1 AGENTFLOW_HISTORY_DISABLED=1 node --import tsx --test src/tests/e2e/studio-documents.test.ts src/tests/e2e/studio-recruitment.test.ts
npx playwright install chromium
npm run studio:test
```

`studio:test` 在 `127.0.0.1:3597` 启动合成测试服务，需要已构建材料镜像；不使用真实 key。覆盖目录与示例边界、完整运行入口、默认节点可读且不重叠、招聘节点的整批输入/输出与返工轮次、Map 示例的子任务进入/返回和并行等待回放定位，以及完整上传、PDF 实际渲染、历史回放、丢失归档、390px 窄屏、返工、重试、失败和取消。CI 在 Linux Node 24/26 运行原 Docker 矩阵和材料/招聘测试，另有 Node 24 Chromium 用户旅程；成功和失败均保留目录/画布截图与浏览器报告，失败另存 trace 和进程日志。

真实模型与视觉验收见[本轮验收记录](../validation/2026-09-15-issue39-studio.md)。首版原始记录在本地 `materials/issue39-user-report/`；根据用户反馈重新设计的体验报告和截图在 `materials/issue39-redesign-report/`。报告不进入 Git。

## 排查运行问题

- 页面空白或提示未构建：执行 `npm run studio:build`，再刷新。
- 网络断开：页面显示连接错误；服务恢复后重新打开历史，已保存记录仍在。
- Codex 不能联网：检查 VPN/DNS 是否把 `chatgpt.com`、`auth.openai.com` 解析到保留地址。受控代理只放行已允许的公网目的地，应修复 DNS 条件，不关闭隔离校验。
- 本地文件丢失或损坏：从自己的备份恢复整个运行目录。页面不会伪造文件内容、旧时间或没采集的日志。
