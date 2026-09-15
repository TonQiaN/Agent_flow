# 持久批卷应用组合

`createPersistentGradingApplication` 位于 src/examples/tutor-grading/persistent.ts。它把现有存储、文件契约、Script、Agent、JSON 转换和 Effect 组装成显式可恢复的批卷应用；业务评分继续使用同一份 Gate 实现。

宿主显式提供 Run ID、RunRecordStore、ScriptExecutor、Agent Driver 工厂、marker/fixer 定义与用户任务说明，以及发布服务 Adapter、EffectRecordStore、固定 target/key 和当前 allowApply 策略。没有默认业务写入凭据，也不会自动读取桌面认证。route 继续由用户指定 marker/fixer、返修次数及 maxSteps。

```ts
// root 保存独立的 archive、temporary、nodes、transforms。
// newSource 的结构是 source/paper.json、source/key.json、source/submission.json。
const app = await createPersistentGradingApplication(root, runId, {
  records, source: newSource, scripts: scriptExecutor, driver: makeDriver,
  agents, route: { id: 'grading', marker: 'marker', fixer: 'fixer', repairs: 1 },
  publication: { target: workoutId, key: publicationKey, adapter, journal,
    allowApply: () => currentPolicyAllowsPublication },
});
const running = await app.start();
const result = await running.completion;
```

新 Run 提供 source，输入经过隔离快照与正常归档后提交首个记录。重开时省略 source，用相同 root、Run ID 和当前实际安装的执行组合调用工厂；原始摘要来自 Run 首个输入归档，完整加载继续验证历史、代码、镜像、契约和所有产物。

```ts
const reopened = await createPersistentGradingApplication(root, runId, reopenSetup);
const loaded = await reopened.load(); // 不执行节点、不读凭据、不审批或发布。
try { inspect(loaded.checkpoint.snapshot); } finally { await loaded.dispose(); }

const resumed = await reopened.resume(); // 共同认领与旧资源清理，然后正常新 Attempt。
try { inspect(await resumed.completion); } finally { await resumed.dispose(); }
```

工厂返回 compiled、runtime、files、bridge、archive 和 catalog，便于现有宿主检查，不另建运行状态机。start/resume 返回原引擎句柄；取消沿其现有异步接口。宿主负责关闭自己提供的数据库及释放本进程新接纳的文件值，加载/恢复句柄负责其拥有的历史副本。新 Run 的 app.input 在执行不再使用后通过 files.release 释放；归档须保留以供重开。

## 交接与审批

流程为 intake → marker Agent → Gate；需要返修时按用户路由进入 fixer Agent 再回 Gate。通过 Gate 时，当前评分 Script 同时生成 publication.json，输出满足独立的 publishable-files contract；revise/rejected 仍使用 reviewed-files。普通批卷的宿主转换与持久批卷 Script 共用 publicationInput，不复制第二套数据整理规则。

固定 JSON 读取节点把 publication.json 转为 publication-json，并持久保存来源证明。发布策略核对当前 Run/Attempt、当前最后接纳的转换、其恢复收据、passed Gate 和可信 Agent 前序；还须当次 allowApply 返回 true，才签发本次 Effect 授权。改变策略为拒绝会阻止恢复后的发布；历史收据不会恢复旧授权。

Effect 已保存可靠回执时，新 Attempt 复用回执，外部服务不重复执行。外部写入已发生但回执未知时，恢复在 Run 认领前拒绝并保留原记录，不能用重试掩盖不确定结果。只读加载成功也不表示允许发布。

## 验证范围

已用真实 Docker、实际不可变 API key Driver/Adapter/Runner、SQLite、文件归档和本地持久发布替身进行合成批卷及中断验收。Agent CLI 是协议替身，不是官方模型；没有向 Tutor 数据库写入。Codex/Claude 订阅 Driver 也已通过同一组合的合成刷新与中断恢复，见[订阅恢复](subscription-resource-recovery.md)；实际学生卷、报告和 PDF 未完成最终验收。

[完整组合验证](../validation/2026-09-10-persistent-tutor-grading.md) · [指定 JSON 转换](json-file-projection.md) · [来源重开](tutor-source-reopening.md)
