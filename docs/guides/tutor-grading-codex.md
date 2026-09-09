# 真实 Codex 批卷验收入口

`src/examples/tutor-grading/codex.ts` 在受控 Docker 中调用真实 Codex，使用样例内的合成试题、参考答案和学生作答。它验证真实 Agent 与同一套文件契约、Gate、返修及模拟发布的交接，不代表真实学生试卷或 OCR 已验收。

共享应用由 flow.ts 提供，只依赖 AgentExecutionDriver 工厂、用户提供的 Component/prompt/config 绑定及普通 Workflow 定义。fixture.ts 安装固定答案替身；codex.ts 安装已有 CodexAgentDriver 与 CodexSubscriptionRunner。具体 Harness、认证与镜像选择由 selected-harness.ts 组装，codex.ts 固定调用共用 grading.ts，Gate 和发布策略保持同一实现。

## 配置与执行

先按 [Codex 订阅组合](harness-auth.md) 准备已有 FileCredentialStore、对应 credentialRef、固定版本镜像及代理镜像。该入口不读取桌面 Codex 凭据、不执行登录、不自动导入其他文件。调用方须为所用凭据及模型网络目标提供既有明确授权；私有证据目录不得提交到仓库。

配置下列环境变量；变量值是路径或非秘密标识，不能把 token 放进去：

| 变量 | 用途 |
| --- | --- |
| AGENTFLOW_ACCEPTANCE_ROOT | 私有证据父目录，每次创建独立 tutor-* 子目录 |
| AGENTFLOW_CREDENTIAL_STORE | 已配置的私有凭据存储目录 |
| AGENTFLOW_CREDENTIAL_REF | 当前存储中的非秘密引用 |
| AGENTFLOW_CODEX_IMAGE | 含受支持 Codex 版本的镜像，运行时验证实际版本及 image ID |
| AGENTFLOW_PROXY_IMAGE | 已安装 CONNECT 代理镜像 |
| AGENTFLOW_CODEX_MODEL | 当前获授权的模型 |

```sh
npm run build
node --import tsx src/examples/tutor-grading/codex.ts
```

调用方如需将 store 中的实际刷新同步回某份获授权的外部凭据文件，必须继续使用既有锁定和条件更新流程；这个样例不会自行选择目标文件或扩大写入范围。

## 两条验收路径

第一条正常批卷：从原始 JSON 材料出发，实际模型完成评分，确定性 Gate 校验后转换成发布 JSON，Effect 仅 dry-run。第二条明确注入评分错误：首个 Agent 被测试任务要求给一题错分，Gate 应走 revise；用户定义的真实 Fixer 根据报告修正，再由同一 Gate 检查。每条路线最多返修一次，每个 Agent 调用最多 180 秒；第一条未通过时不会继续第二条。

退出码 0 要求两条流程均发布到 dry-run 终点，最终 5/7、报告 passed 且无 findings；第二条确实经过 revise/Fixer；原始来源摘要保持不变，每次 Agent 输入副本实际被改动，执行句柄及工作目录均清理，内存服务写入数为零。结构或内容不合约不会被“完成”文本覆盖。

每次运行保留 summary.json、各 Run 的 Workflow/来源记录、最后一次 Gate 接纳文件和执行证据。原始日志仅存于私有证据目录。资源清理失败时保留目录和明确失败结果，不用直接删除整个目录冒充清理完成。成功不证明实际 OAuth 刷新发生；真实学生反馈报告及 PDF 仍是后续验收。

[合成替身样例](tutor-grading-fixture.md) · [真实验证记录](../validation/2026-09-09-tutor-grading-codex.md)

[三种 Harness 共用入口](harness-grading-matrix.md)现在复用相同业务流程；Codex 入口继续固定选择 Codex。
