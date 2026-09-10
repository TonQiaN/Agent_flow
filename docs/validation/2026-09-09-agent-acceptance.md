# Agent 接纳、执行驱动与可信收据验证

2026-09-09，PR #19 在 dea36be 的文件交接基础上增加 portable AgentExecutor / AgentExecutionDriver / AgentAttempt，具体 CodexAgentDriver 位于 integrations。主责 @xiaoxuanli-a；Codex 实现和作者自查，未进行独立多人评审。

## 自动回归

完整 `npm run check` 启用 Docker、受控联网及实际 Codex 0.153.4 镜像：**91 项通过、0 失败、0 跳过**。后续补充取消回调异常仍保留输入释放能力，6 组接纳测试、构建和测试类型检查再次通过；示例语法检查通过。

新增 6 组接纳回归覆盖：宿主身份/快照绑定与返回副本；Runner/Harness/采集/收尾失败不得收集输出或发收据；单出口、结构化多出口与合法业务拒绝；伪造、跨 Run、契约不一致和已释放前序引用拒绝；并发重复 Attempt 与请求事后修改；定义错误、取消和启动失败的资源释放。普通结果不公开 raw 路径或任意异常内容；文件错误保留契约、相对路径及规则。

原 Docker 合成 CLI 测试扩展到新驱动与接纳层：实际从已接纳快照物化输入，再调用订阅组合，分别验证 completed 单出口和 rejected 结构化多出口，校验文件内容、身份、版本和收据，最后确认输入与产物存储目录释放。此 CLI 是明确的协议替身，不冒充真实模型。

## 实测发现及修复

真实单出口调用通过：Codex 0.153.4 / gpt-5.6-sol 实际退出 0，Harness completed、收尾成功，sum=6 文件契约、独立交接、输入副本修改和宿主原件不变通过，并由引擎登记 completed 收据。

随后真实多出口两次被 OUTPUT_CONTRACT_FAILED 拒绝。新增路径级错误和私有候选元数据定位到 outputs 中的 .agents / .codex / .git 空目录；answer.json 本身正确。参考 Blackbox 5610d1b 的 `_inspect_output_tree`，旧系统拒绝未引用文件而不把普通空目录当交付物。因此新收集器改为省略未归属普通空目录，保留声明树内空目录与结构性父目录，不特判 Harness 目录名。扫描限额、危险链接和未声明文件继续严格拒绝；新增真实文件回归覆盖任意空目录、嵌套空目录、隐藏未声明文件及显式空树。

修复后的真实多出口已可接纳 rejected 并产生收据。一次额外输入修改演示因模型追加含空格的空行、不是唯一指定换行字节串而未通过示例检查；副本实际已改，JSON 内容仍相同。验收依据改为副本字节不同、JSON 内容一致、宿主原件不变，避免用一种文本格式替代可写隔离行为。

更改示例检查后的最后一次真实复跑，在模型调用前出现 Codex 内部 bwrap 对 input/.agents 的只读挂载失败；Runner 退出 1，引擎未签发收据，收尾和工作区释放成功。因此最终组合仍未通过这一轮全部检查，不以此前接纳成功掩盖该失败。离线合成凭据启动探测再次复现同类 work/.agents 故障；预建目录的对照可进入 turn.started，但正常未预建组也有成功，尚不能证明预建目录是可靠修复。没有关闭沙箱、自动重试失败 Attempt 或加入猜测性目录补丁。

按用户要求先核对 Blackbox 5610d1b 的 Codex 定义和 5f58036 修复：其 CLI 声明为 0.146.1，修复的是共享 provider-state，而本项目已逐 Attempt 隔离。继续核对 [Codex 0.153.4 官方 bwrap 源码](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/linux-sandbox/src/bwrap.rs)：缺失及已有空元数据目录会被合成只读挂载处理；这提供后续定位方向，不代表已证明根因。

真实测试全程使用已明确授权的专用材料、两个指定官方域名与原锁内条件同步。一次共享锁占用按 Blackbox 的独占规则等待后再试，没有删除或抢锁。私有兼容桥增加启动时源与存储一致性检查，只有本轮 revision 增长且源未变化才允许同步，避免把其他流程更新后的原件覆盖成旧副本。运行未触发真实 OAuth 刷新，不能以合成刷新回归声称完成真实续期验收。

## 交付边界

接纳服务只处理一次文件 Agent Attempt；Component/Workflow 的统一编译、串行路由、有界返修、确定性脚本/Effect 接入，以及持久化、队列、自动重试和并行仍属后续工作。收据由进程内私有表建立可信来源，不能作为数字签名或重启后的证书。真实其他 Harness、Tutor 批卷/报告/PDF 与生产发布尚未完成。

[Agent 接纳指南](../guides/agent-acceptance.md) · [组件决定](../../.agents/decisions/product/README.md#p-20260909-component-execution) · [文件契约验证](2026-09-09-file-contracts.md)

后续在同一 PR 调整临时元数据权限并通过完整 92 项回归和真实单/多出口复跑，最新结果见 [启动验证](2026-09-09-codex-startup.md)；上述失败保留为实际调查记录。
