# 批卷文件节点的 Script 绑定

应用示例的 `gradingFileScripts(original)` 提供 intake 和 Gate 的实际 ScriptDefinition，可直接注册到现有 FileWorkflowCatalog；执行、资源持久化、停止和新 Attempt 恢复沿用 ScriptExecutor/Runner。评分规则仍在应用层，原有普通宿主 Gate 继续使用同一份实现。

```ts
const scripts = await gradingFileScripts(originalManifest);
files.registerScript({
  id: 'intake', kind: 'transform', implementation: 'intake-v1',
  inputContract: 'source-files', outcomes: { completed: 'source-files' },
}, scriptExecutor, scripts.intake);
files.registerScript({
  id: 'grading-gate', kind: 'gate', implementation: 'grading-gate-v1',
  inputContract: 'candidate-files',
  outcomes: { passed: 'reviewed-files', revise: 'reviewed-files', rejected: 'reviewed-files' },
}, scriptExecutor, scripts.gate);
```

这里的 originalManifest 来自运行开始时可信的原始输入快照。构造器要求试卷、答案和学生作答三个原始路径各出现一次，摘要为 SHA-256；先复制并按固定顺序整理，再读取当前安装的评分源码。不能从 Agent 修改过的候选包重新选取“原始”摘要。

宿主使用 Node 的 TypeScript 类型移除能力，把同一 `gate.ts` 变成可由容器 Node 执行的模块程序；不使用函数 toString，也不依赖容器安装 AgentFlow 包。完整程序字节进入 argv，来源摘要作为单独的 JSON argv 参数。没有 shell 插值，输入内容不能把参数变成程序。原始对象或返回 source 副本后续被修改，不会改变已经生成的参数。

intake 复制独立输入到 outputs；Gate 读取 `/task/input`、比较原始来源、评分并输出候选包与 gate-report.json 到 `/task/outputs`。标准输出仅写现有 `agentflow-script-result/v1` outcome 包；文件仍须经 contract 校验才接纳。容器使用现有固定 `/task` 布局、可写隔离输入与断网配置。

调用方提供实际 DockerBackend 和具备 Node 的镜像。Script 执行快照包含生成程序、参数、30 秒期限和已解析固定镜像；恢复需以当前安装和同一可信来源事实重新构造，然后完整比较。不能从检查点直接执行历史代码。宿主类型移除工具的输出差异也可能导致一致性拒绝；本轮验证宿主 Node 26、容器 node:22-bookworm-slim，未验证所有 Node 版本组合。

此绑定已接入独立的 [createPersistentGradingApplication](persistent-tutor-grading.md)。原始来源使用[准备与重开接口](tutor-source-reopening.md)；传入 publication.workoutId 时，passed Gate 还生成 publication.json，输出须使用 publishable-files contract，随后由指定 JSON 文件投影和 Effect 完成发布交接。原 createGradingApplication 保留普通运行入口。Script 独立验证中的罐装初批/返修只用于测试，联合持久验证中的 Agent CLI 也是协议替身，均不代表官方模型调用。见[验证](../validation/2026-09-10-tutor-file-scripts.md)。
