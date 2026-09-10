# 批卷原始来源的准备与重开

应用示例提供 `prepareGradingSource` 和 `readGradingSource`，复用正常 Run 的首个输入归档。无需单独的来源数据库或 `facts.json`，也无需恢复原进程的 originals Map。

新 Run 先通过 `prepareGradingSource(files, runId, sourcePath)` 捕获隔离输入，返回 input token 和来源摘要。使用摘要构造当前的 [文件 Script](tutor-file-scripts.md)，然后将同一个 input 传给 `WorkflowRuntime.startPersisted`。正常检查点写入先耐久归档该输入，再提交 Run 行；准备函数本身尚未提交 Run。调用方沿普通 Catalog 生命周期释放 input 和后续输出。

重开时使用 `readGradingSource(runId, runStore, archive)`，再用返回的来源事实安装当前 Script/流程。该接口核对已知检查点或恢复封套版本、Run 身份、首个输入位置、source-files contract、原始输入无前序收据、文件引用及归档清单一致性。逻辑快照 ID 与归档物理 ID 按原文件恢复规则比较。缺少 Run、错误身份、未知格式、改变的清单或缺少归档会拒绝。

随后必须调用 `loadWorkflowCheckpoint` 或 `claimWorkflowRecovery` 完成校验。来源读取只返回三项 SHA-256 元数据，不创建文件 token、不导入执行收据、不恢复授权、不认领或写入 Run，也不执行保存的代码。它只解决“先取得原始数据参数，才能安装当前执行定义并完整比较”的顺序问题。

归档 read 核对清单；实际文件字节、全部历史、当前定义和资源由完整加载/恢复继续检查。来源读取成功不代表整个 Run 可以执行，失败/取消等状态也不会因此重新启动。即使元数据可读，归档内容缺失或损坏仍会在文件恢复时拒绝。两次读取之间发生变化也不能跳过后续完整校验及 CAS。

当前已接入 [createPersistentGradingApplication](persistent-tutor-grading.md)，与实际 Agent Driver、Script、文件到 JSON 收据及持久 Effect 共同运行。新进程从首个输入归档重开，原始宿主目录删除或变化不改变已保存输入。来源接口的独立验证见[记录](../validation/2026-09-10-tutor-source-reopening.md)；组合验证使用合成答卷和协议替身，不代表官方模型或真实学生持久恢复验收。
