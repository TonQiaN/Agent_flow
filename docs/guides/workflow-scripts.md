# 确定性脚本 Workflow

脚本是 gate/transform 的实现方式，使用现有 Runner 执行一次进程，再由文件 Workflow 接纳产物。`ScriptExecutor` 位于 engine，只有 backend、clock、原始记录读取端口依赖；本机原始读取和 Docker 仍在 integrations。当前不提供可信宿主直接 subprocess 执行器或生产 Effect 脚本。

## 登记与协议

在已配置文件契约和 `FileWorkflowCatalog` 的宿主中登记：

```ts
const scripts = new ScriptExecutor(
  new DockerBackend({ workspaceRoot: privateDockerRoot, image: installedImage }),
  systemClock,
  new FileScriptRecordReader(),
);
catalog.registerScript({
  id: 'copy', kind: 'transform', implementation: 'copy-v1',
  inputContract: 'answers', outcomes: { completed: 'answers' },
}, scripts, {
  timeoutMs: 15_000,
  argv: ['/bin/sh', '-c', `set -eu
cp /task/input/answer.json /task/outputs/answer.json
printf 'copy finished' >&2
printf '{"schema":"agentflow-script-result/v1","outcome":"completed"}'`],
});
```

Workflow 的编译、启动和引用生命周期与 [文件 Workflow](workflow-files.md) 相同。镜像由宿主选择且必须已存在；实际镜像 ID 在执行证据中保留。默认 Docker backend 不联网、不配置认证，使用既有资源约束和固定 `/task` 路径。此接口只接受 argv/timeoutMs，不接受任意环境、认证或 Docker 参数；backend 是受信宿主安装的能力。脚本既可以来自镜像内文件，也可以由用户显式提供命令参数，不会从 Workflow 输入拼接命令。

进程必须向 stdout 返回**一份** UTF-8 JSON：

```json
{"schema":"agentflow-script-result/v1","outcome":"completed"}
```

单出口也要返回 outcome。允许 JSON 外围空白；拒绝未知字段、重复字段、未知出口、多个对象、stdout 混入日志、无效 UTF-8 和超过 64 KiB 的结果。日志写 stderr。没有 outcome 路径，也不返回产物清单；完整业务文件仍写 outputs，按所选 outcome 对应 contract 自动发现和验证。

## 执行与接纳

登记/编译时验证实现配置、声明出口和文件契约，不启动进程或捕获输入。每次执行保存请求副本并占用唯一 Attempt；失败和清理后均不能重放同一 Attempt。

脚本协议通过同时要求 Runner 实际退出 0、停止确认、资源已移除、无执行诊断、stdout/stderr 原始采集完整且未截断。读取端口复核原始文件大小、普通文件和单链接身份，拒绝符号/硬链接及读取期间变化；再进行 UTF-8 与结果协议检查。原始路径和任意错误文本不会进入普通结果。

`ScriptExecutor` 的 accepted 只表示进程与结果协议通过，尚不证明业务文件合格。`FileWorkflowCatalog` 继续捕获 outputs 并校验文件 contract，随后释放执行资源，最后才签发 Workflow 文件引用。Workflow receipt 的 script 字段保留身份、实际镜像、退出码和 outcome；前序来源机制与 Agent/函数相同。

退出失败、取消、超时、日志不完整、协议错误、文件违约或释放失败均阻止后继。宿主使用 `catalog.cleanup(identity)` 重试失败资源的停止/移除/释放；未证实停止时保留工作区。清理成功不会升级原失败结果。取消成功后的 Run 可能清空 currentIdentity，需要从失败步骤或已记录的运行身份取得清理目标。

直接使用 ScriptExecutor 时，`ScriptAttempt.executionFacts()` 是宿主检查入口；先验证/复制所需文件，再调用 releaseExecution。该接口没有自动文件契约接纳，不能把它的协议成功当成完整 Component 成功。

当前已经验证真实 Docker 脚本 → 文件 Gate、异常协议/文件、取消与超时。独立 [JSON 模拟 Effect](workflow-effects.md) 已接入；Tutor 合成闭环与所选真实学生分阶段样本已有验证，范围及限制见 [0.1.3 计划](../roadmap/0.1.3.md)。最小控制入口使用库 API，CLI 定义加载尚未提供。

[验证记录](../validation/2026-09-09-workflow-scripts.md) · [执行决定](../../.agents/decisions/product/README.md#p-20260909-component-execution)
