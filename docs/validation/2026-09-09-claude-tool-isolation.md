# Claude 实际工具隔离验证

2026-09-09，基于本地80e02d8，主责 @xiaoxuanli-a，Codex 实施与作者自查；尚未独立多人评审。本次属于 #10/#11/#12 的实际组合验收，不新增产品范围。未使用真实凭据、远端模型或学生材料；没有项目分支、远端发布或生产写入。

## 发现与修正

先查 Blackbox HEAD5610d1b/v0.1.22 的 provider policy 检查、preflight_command、doctor 探针和测试/修复历史。其 Claude 探针自行运行 bwrap，能检查该包装下的访问结果；它没有证明 Claude 内置 Read/Edit/Write/Glob/Grep 和自己的 Bash 包装实际采用了管理策略。未找到对应修复；未修改旧工作区或将其他未提交内容当作已发布行为。

随后在完全断网的容器中启动本地 Anthropic 协议替身，由它按固定顺序返回工具请求，让真实 Claude2.1.226 执行工具。CLI 的标题请求和任务请求分开处理；这不是合成可执行程序假装执行工具。只有测试进程把请求地址指向本容器 loopback；产品 Profile/Runner 不提供自定义服务地址。全部 token、输入和工具参数均为明确合成材料。

负对照复现：仅把策略放在 /task/config 并设置 CLAUDE_CODE_MANAGED_SETTINGS_PATH 时，真实 Read 将合成凭据内容回传给本地替身。检查固定镜像程序的管理目录解析逻辑后确认：Linux 路径固定为 /etc/claude-code，发布程序没有采用该环境变量。改成“目录值”也未生效。此前的启动、格式识别和合成组合测试没有覆盖这条真实权限链，因此不能发现问题；此前记录明确将工具隔离列为未验收。

修复增加宿主 `systemConfigMounts`：来源只能是本次 configFiles 的相对文件，目标只能是规范的 /etc 子目录文件，始终只读；配置数量/路径/重复/父子冲突/缺失来源均拒绝。Claude 的独立配方把 claude-managed.json 挂到实际系统位置。通用 Docker 不识别 Claude，Workflow/Invocation 不获得任意挂载或宿主文件读取能力；移除无效管理路径环境声明，保留两项固定非秘密开关。

## 实际工具结果

固定镜像 agentflow/agent-claude:21e8235ace16，ID sha256:d1efc5c58eaef1c80176cf3f881b9d872d7a49f7638bc5e523a8a2a573d5bb74，CLI init 确认2.1.226。同一测试先运行缺失挂载的负对照，再运行修复后的16个真实工具请求：

- Read 读取正常 input 成功；凭据绝对路径、相对路径、工作目录符号链接和 /proc/self/root 路径均被拒绝。
- Grep 不回传凭据内容，Glob 不枚举凭据文件；Edit/Write 无法修改私有 state，Write 的符号链接和 proc 路径绕过也失败，系统管理文件保持只读。
- Edit 可以修改 input 副本，Write 可以创建 outputs。Bash 的 Node 子进程可以写 input/work/outputs，但读凭据、链接和 proc 路径、写实际凭据文件均失败。
- Bash 不能连接同容器本地替身的监听端口，替身未收到工具发起的网络请求。模型协议客户端本身可连接本地替身，证明没有以“整个进程完全无法请求”冒充工具网络隔离。
- 宿主独立核对凭据字节、管理 JSON 字节与原始 input 不变；修改只在任务副本中。Bash 向被遮蔽的 state 根写入一个新文件时，可能在遮蔽层返回成功，但文件没有进入宿主私有 state；测试同时检查工具结果和宿主文件，未把这种行为写成“所有相同路径写入都返回拒绝”。

拒绝错误可以包含请求里已知的路径；不把错误提及路径误判为目录枚举或文件内容泄露。探针保留停止和清理证据；不确定清理时保留工作区，不乐观删除。

新增2组配置映射检查和1组上述真实工具回归。旧 Claude 合成组合及真实启动/格式测试也改为使用实际系统映射。完整命令：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=agentflow/harness-codex-chatgpt:55517b18fd19 AGENTFLOW_CLAUDE_IMAGE=agentflow/agent-claude:21e8235ace16 npm run check
```

**最终完整回归168项通过，0失败、0跳过。** 包含依赖边界、构建、测试类型检查、全部 Docker/egress/既有 Codex 回归及新的真实 Claude 工具检查。

## 覆盖边界

这是固定版本、明确工具/路径场景的实际执行证明，不是对任意漏洞或编码方式的穷尽安全证明。本地替身不验证远端模型、真实订阅、OAuth 刷新、实际服务网络兼容性或最终产物质量。真实 Claude 单/多出口任务、DeepSeek 及其余 Issues、真实学生批卷/完整报告/PDF 继续推进。全部证据为本地验证，不是尚未创建的矩阵 PR 的 CI。

[Claude 组合](../guides/claude-execution.md) · [Docker Runner](../guides/runner.md)
