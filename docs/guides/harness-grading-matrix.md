# 三种 Harness 共用的批卷验收入口

`src/examples/tutor-grading/matrix.ts` 选择 Codex、Claude 或 DeepSeek，其余复用同一个 grading.ts、flow.ts、文件契约、Gate、用户定义返修和 dry-run Effect。原 codex.ts 入口继续固定选择 Codex，原有环境变量兼容。宿主组装代码位于 examples，不给 engine 增加 provider 分支。

## 先做离线预检

设置下列非秘密配置；路径必须为绝对路径，凭据引用必须显式给出，不搜索桌面认证或回退到环境中的 API key：

| 配置 | 值 |
| --- | --- |
| AGENTFLOW_ACCEPTANCE_HARNESS | codex / claude / deepseek，必填 |
| AGENTFLOW_ACCEPTANCE_ROOT | 私有证据父目录 |
| AGENTFLOW_CREDENTIAL_STORE | 已配置的 FileCredentialStore 私有目录 |
| AGENTFLOW_CREDENTIAL_REF | 上述 store 内的引用 |
| AGENTFLOW_PROXY_IMAGE | 已安装代理镜像 |
| AGENTFLOW_CODEX_IMAGE / AGENTFLOW_CODEX_MODEL | 选择 Codex 时必填 |
| AGENTFLOW_CLAUDE_IMAGE / AGENTFLOW_CLAUDE_MODEL | 选择 Claude 时必填 |
| AGENTFLOW_DEEPSEEK_IMAGE / AGENTFLOW_DEEPSEEK_MODEL | 选择 DeepSeek 时必填 |

```sh
npm run build
node --import tsx src/examples/tutor-grading/matrix.ts --preflight
```

预检验证所选 Adapter 参数及配置完整性；DeepSeek 从仓库固定部署打包入口读取工具资产。预检不创建输出目录、不读凭据、不检查 Docker 镜像、不登录、不联网，因此 `validated=configuration-only` 不能当成真实验收。

## 运行和证据

只有配置对应来源、远端目标和使用范围已有明确授权时，去掉 `--preflight` 执行。此命令不导入源凭据，也不执行登录。

```sh
node --import tsx src/examples/tutor-grading/matrix.ts
```

各组合仍使用其产品 Runner 的固定版本校验、独立可写输入副本、受控代理和收尾流程：Codex 0.153.4 / OpenAI 订阅；Claude 2.1.226 / Anthropic 订阅；DeepSeek 0.1.1-rc.2 / 官方 API key。实际网络目的地由 Runner 配方决定，调用配置不能覆盖。DeepSeek 推理关闭，另外两种使用 low；所有组合关闭搜索和子 Agent。

两条路线和判定与 [Codex 批卷说明](tutor-grading-codex.md)一致：正常路线和显式错分后的 Gate/返修路线，各最多一次返修、每次 Harness 执行最多 180 秒，最多四个 Agent 节点。CLI 内部可能有多个模型步骤，四个节点不是四次 API 请求或费用上限。

summary.json 保留所选配置与 `modelTransport=configured-harness`，不因运行了入口就宣称真实模型通过。验收人须将实际镜像/版本、Runner 网络及官方调用证据，与通过的终态、文件契约、5/7 评分、Gate、返修、输入隔离和清理一并核对。协议替身也能运行产品 Runner；它的结果仍只算替身证据。执行证据另复制完整 stdout/stderr 和具名原始记录，DeepSeek 原生会话记录不会随着释放工作区丢失；raw-records.json 将记录 ID 映射到本地副本。原始材料只保存在私有证据目录，不提交公开仓库。

本样例不证明新登录或 OAuth 续期发生；真正续期须另留认证生命周期证据，未触发须记为“未触发”。它只使用合成 JSON 材料，也不覆盖真实学生 PDF、图像读取、OCR、完整反馈报告和 PDF 生成。这些验收保持独立开放。

## 最新官方验收

[2026-09-15 记录](../validation/2026-09-15-official-harness-acceptance.md)已完成三家同一 JSON 流程的正常和返修，Claude/DeepSeek 图片、多出口及 Claude 真实续期另有独立探针。Codex 后续图片任务曾遇到凭据撤销，专用重新登录后的图片和取消复验均通过。原 Issue 验收范围未缩减，四项基础 Issue 待最终 PR 合入核对后关闭；预检、真实调用、自然到期与人工提前缓存到期的证据分别核对。
