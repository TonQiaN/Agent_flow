# 本机工作台

面向 #39 的本机服务位于 `src/apps/studio`，固定执行入口位于 `src/examples/studio/entry.ts`。团队成员各自拉取代码、安装并运行；数据和凭据留在自己的电脑。第二层 PR 提供服务与工作流，画布前端由后续层交付。

## 环境与启动

需要 Node.js 24 或 26、npm、Docker。普通检查：`npm ci && npm run check`。

```sh
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

一次提交全部材料：1 份岗位、1–12 位候选人、每位 1 份简历；可追加岗位或候选人的补充材料。支持 PDF、DOCX、TXT、MD、PNG、JPEG。每文件最多 20 MiB，最多 64 文件、合计 128 MiB、每份文档最多 60 页。PDF 文本不足时 OCR；OCR 结果仍需对照原图。代码中有文本量与结果契约限制，超过时显示失败原因。

要求拆解后，每位候选人做四维评审和独立复核。引用必须找到原文件、页码及原文，错误引用按有限路线返工。最后逐项说明证据，输出“推荐通过”或“推荐不通过”，没有总分和排名。缺失/冲突说明怎样影响结论；执行失败不自动成为候选人不通过。最终校验后生成候选人对照表、个人 MD/HTML/PDF 和 JSON。

`src/examples/recruitment/fixtures` 是明确标注的一个岗位和三份虚构简历。`AGENTFLOW_STUDIO_FIXTURE=1` 启用合成模型响应与显式故障场景，仍执行真实队列、文件解析和 PDF 渲染；不能把这项验证当成真实模型能力证明。

```sh
AGENTFLOW_STUDIO_TESTS=1 AGENTFLOW_HISTORY_DISABLED=1 node --import tsx --test src/tests/e2e/studio-recruitment.test.ts
```

## 数据和限制

每次运行保存 meta、上传件、SQLite 修订与事件、归档文件。历史与回放只读，没有执行、取消、恢复接口；文件按已登记 ID 读取并验证摘要，HTML 按文本预览。历史不自动清理。重启后缺失、损坏或中断会明确显示；旧记录没有的时间、内部日志和设置不会补造。

日志记录公开可获取的工具调用、消息、事件与 session 记录。隐藏 CoT 不在接口能力内；Codex session memory 在此隔离任务中关闭。截断、失败、无记录分别标注。凭据由已有 Adapter 脱敏，展示层再过滤敏感字段。
