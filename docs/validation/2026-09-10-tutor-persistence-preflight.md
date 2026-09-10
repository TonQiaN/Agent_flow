# Tutor 持久验收链路预检

LoopX 在 20 次持久进度记录后要求周期规划核对。本次基线为 c42d961；核对 #13 明确验收、已登记材料边界及当前实现，目标仍为八项 Issue、真实批卷、报告和 PDF。没有扩大私有材料、凭据或发布权限。

## 新证据

使用仓库合成夹具完成 `intake → marker → gate → fixer → gate → projection → publish`，结果 succeeded，模拟服务写入 1 次。将已接纳 projection 的身份和输出交给另一个真实 Node 进程，重新创建独立应用组合：`bridge.receipt(identity)` 返回 `UNKNOWN_FILE_JSON_RECEIPT`，`matches` 为 false，第二个进程执行 Agent 次数为 0。普通流程成功不证明新进程可恢复发布依据。

逐节点检查实际执行绑定得到：intake/gate 的宿主文件函数没有执行定义；projection 没有执行定义、checkpointValue 或 restoreValue；publish 仍使用动态函数映射和内存服务组合，不能持久启动。合成 marker/fixer 的夹具 Driver 也无执行定义，这是罐装答案驱动的能力边界，不能推导为已经实现的实际 Agent Driver 都不支持持久化。

源码进一步确认：Gate 从 `originals` 内存 Map 取得原始来源清单；发布策略同时依赖当前 Runtime、转换收据 Map 和前序文件收据。CheckpointWriter 的普通 JSON 保存只保存值；当前加载器仅对文件值与 Effect JSON 签发恢复请求。因此，给文件函数登记一个 revision 不能填补来源清单、转换收据和实际停止能力。

参考 Blackbox v0.1.22 / 5610d1b：Runner 为脚本提供独立输入/输出与执行身份，runtime 的持久收据包含前序关联；`test_issues_a_host_receipt_chain_and_materializes_it_downstream` 和回执重绑定拒绝测试证明来源链是独立验收项。当前 TypeScript 使用已有 Runner/CAS，不照搬旧整 Run flock；可写独立输入继续遵守用户当前要求。

## 选定的下一切片

保留 #13，调整接线顺序，直接服务于批卷恢复：

1. 文件 intake/Gate 使用已有 ScriptExecutor、固定 Docker 镜像和共同 Runner；实际评分实现属于应用包。先通过原文件 contract 与结果协议验证正常、返修、来源被改动的场景。
2. 将原始来源清单变为耐久且可核对的运行事实。恢复从已保存来源取得依据，禁止从变化后的宿主原文件重新推导，也不依赖原进程 Map。
3. 接通文件到 JSON 的实际执行绑定及耐久转换收据。已经接纳的 projection 在新进程无需重跑即可验证身份、outcome、输出与前序文件；伪造和重绑定必须拒绝。其 API 细节按现有一次性恢复能力和 Component 边界落实。
4. 持久验收应用使用固定 target/key、SQLite Effect 日志及当前宿主审批；接入可描述的实际 Agent Driver，用合成协议验证进程中断与恢复，再处理订阅占用和 #13 剩余验收。

普通宿主文件函数保留；首版验收不以实现任意宿主文件回调的停止/接管或通用 GC 为前提。不将未知旧执行直接判为结束，不用重跑已接纳节点掩盖收据丢失。

验证入口沿用普通命令 `npm run build`、`npm run typecheck:tests`、文件转换与 Tutor flow 测试；新增接线后必须有实际 Script/Agent Workflow 子进程 SIGKILL、已接纳步骤不重跑、跨进程来源链验证。当前只完成预检和顺序调整，不声称这些接线已实现。

## 本轮结果

13 项现有文件转换/Tutor 流程回归全部通过，约 2.75 秒，0 失败、取消、跳过。上述临时双进程探针使用合成文件和内存模拟服务，未访问真实凭据、模型、学生数据或业务系统。只读能力探针及原始结果保留在本地工作证据中；此文记录可独立理解的步骤和结果。

停止条件保持原范围：需要真实私有材料、未授权凭据或远端发布时沿用已有待办；其余本地实现继续。#13、#14–#16 和真实批卷/报告/PDF 都保持未完成。作者核对，不代表独立审阅或整体验收。

[持久化决定](../../.agents/decisions/product/README.md#p-20260909-run-persistence) · [0.1.2 规划](../roadmap/0.1.2.md)
