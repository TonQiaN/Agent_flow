# 首个 Harness / 认证组合：接口与本机存储验证

对象：codex/first-harness 相对 codex/docker-runner 396cf0516c1a3f42f60275ae8d1290439cb0e36f 的增量。Refs #9–#12；仍是 PR3 实施中的部分，不关闭任何整项 Issue。

## 已执行

2026-09-09，macOS arm64、Node 26.0.0 与 Docker Desktop 环境：

- `npm ci --offline --ignore-scripts` 成功；沿用锁定依赖，无新增第三方包。
- `AGENTFLOW_DOCKER_TESTS=1 npm run check`：依赖边界、TypeScript 构建、测试类型检查及 46 组测试全部通过，0 跳过。新增 7 组 Harness 测试和 7 组凭据测试；5 组真实 Docker 回归全部执行。普通无 Docker 开关时明确跳过这 5 组。
- Harness：显式注册与重复拒绝、固定路径、prompt 原样传递及参数分隔、不支持配置拒绝、Runner/Harness 双重终态、身份/版本不匹配、损坏/截断/非 UTF-8、重复/冲突终态、非递归 usage 与 unknown、事件脱敏和未知载荷不外泄、结构化多出口。
- 存储：两种明确来源、冲突拒绝、无 ambient fallback、0700/0600、链接/硬链接/身份拒绝、元数据序列化、条件刷新、同租约并发旧 revision 拒绝、外部 generation/revision 变化拒绝、管理与执行共享锁、异常释放、本地删除不复活。测试只使用合成凭据。
- 多进程测试实际 fork Node 子进程：同 credentialRef 占用超时；释放后等待者取得；等待者持锁时另一个存储实例拒绝占用；SIGKILL 持锁者后不自动抢锁。本次未证明运行容器崩溃后的恢复，后者留给 #13 协调。
- Docker 权限回归新增 `/task/config` 写入失败断言，原有 input/work/state 可写、源文件不受影响及容器取消/清理继续通过。

## 真实 Codex 离线参数探测

已查询现有镜像的 `codex --version` 与 `exec --help`。实际容器 CLI 为 0.153.4；本机 CLI/旧声明为 0.146.1，两者不混用。公开协议参照 [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) 与 [认证](https://learn.chatgpt.com/docs/auth)，parser 样本目前是合成协议样本，未伪称真实模型输出。

使用新 Adapter 生成的 argv 在完全断网、无凭据、只读根文件系统、非 root 容器内探测，发现并修正了权限参数问题：Codex 对 `-c` 的 dotted key 路径不按期望移除引号，应使用 filesystem 的 TOML inline table；访问拒绝枚举是 deny。修正后严格配置解析继续进入会话初始化。

随后真实初始化失败于 bwrap 创建 user namespace。这证明现有离线 Runner 的容器安全配置不能直接承载该 Codex 内部沙箱；不是认证失败或模型任务成功。尚未调整或关闭内部沙箱，也未进行联网模型调用。下段需参考旧已验证的专用 seccomp/系统路径设置，并实际验证工具只能修改任务副本、不能读取认证材料；还需接通受控 egress、只读配置注入、秘密绑定和停止后刷新保存。

## 尚缺与评审

没有执行真实登录/续期、模型任务、outputs 文件 contract、可信前序执行证据、Tutor 复现、Claude/DeepSeek 或完整 Workflow；存储原子更新测试不等于 OAuth 真实刷新通过。完整首个组合继续保留在同一 PR3 Todo；不得依据 46 组通过宣称已完成 #10/#11/#12。

作者 Codex 自查并根据真实镜像反馈修正参数；未进行其他开发者独立审阅。提交后的 CI 结果在 PR 记录，不把本地通过写成尚未观察的远端通过。决定仍位于 proposed，正文分别说明本切片落地范围及余项。
