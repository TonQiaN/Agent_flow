# Codex 临时元数据权限与启动验证

2026-09-09，基于 PR #19 的 c1bb51a；主责 @xiaoxuanli-a，Codex 实现及作者自查。

## 复现与取舍

此前真实单/多出口任务已可接纳，但额外复跑在模型调用前失败：Codex 0.153.4 的 bwrap 无法 remount readonly task/input/.agents。离线合成凭据测试另在 task/work/.agents 复现。预建空目录和未预建组都有成功样本，不能把预建当可靠修复。

先核对 Blackbox 5610d1b 的 Codex 0.146.1 定义与 5f58036：该修复隔离 provider-state，避免共享程序缓存和数据库互相干扰，本项目已经做到。它没有解释或修复当前版本的元数据挂载故障。随后读取固定版本的 [官方 bwrap 实现](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/linux-sandbox/src/bwrap.rs) 与 [权限实现/测试](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/permissions.rs)：缺失和已有空元数据目录走合成只读挂载；显式子路径 write 可覆盖默认元数据保护。

实现选择是权限边界适配：仅为固定 /task/input、/task/work、/task/outputs 内的 .git/.agents/.codex 生成显式 write。它们是已获准可改的一次任务副本，不是宿主 Git 仓库或引擎配置；真实秘密仍在 state 中 deny，协议目录仍只读。没有占位文件、目录名产物豁免、任意权限透传、自动重试或关闭沙箱。此变化确实取消了这些临时元数据目录的默认只读限制；不把它描述成原规则完全不变，也不声称修复了 Codex 上游的竞争实现。

## 验证

实际 Codex 0.153.4 的离线对照中，显式映射连续 5 次进入 thread.started 和 turn.started。网络关闭，合成凭据无实际服务权限；最终超时符合预期，不算模型成功。

新增自动启动测试组合了空目录/已有 .agents 内容、单/多出口四种情形。实际 CLI 均进入正常 turn，随后离线请求超时，容器停止与清理完成、原输入不变。已有真实沙箱测试同时增加九个元数据路径写入、读取，以及经 .agents 符号链接读取认证的拒绝。两组定向测试通过；认证直接读写、链接、移动父目录和 proc 旁路，协议写入继续拒绝。

完整 `npm run check` 启用 Docker、受控联网、实际 Codex 镜像后 **92 项通过、0 失败、0 跳过**，依赖边界、构建和测试类型检查通过。

最终配置的真实单出口和多出口分别复跑通过：Codex 0.153.4 / gpt-5.6-sol，退出 0，正常 Harness 终态、收尾成功、completed / rejected 收据、sum=6 JSON 契约和摘要交接成立，输入副本有变化但 JSON 等价、宿主原件未变，工作区/产物与租约释放。使用原授权专用凭据及两官方域名，revision 保持 1，未发生真实刷新。真实 OAuth 刷新、其他 Harness、Workflow 及 Tutor 端到端仍单独验收。

[Harness 决定](../../.agents/decisions/product/README.md#p-20260909-harness-adapter) · [接纳验证](2026-09-09-agent-acceptance.md)

2026-09-10 合并前复验：PR #17/#18 已合并，本层同步 main eddeb41 并保留最新主 Issue / Sub-issue 规范与 Blackbox 优先调查要求。生产源码与 961e77a 相同；启用 Docker、受控联网和同一实际 Codex 镜像的 `npm run check` 再次通过 92 项，零失败、零跳过。此次没有调用真实账号或模型，真实单/多出口仍引用上文相同实现的验收事实，真实刷新仍未触发。
