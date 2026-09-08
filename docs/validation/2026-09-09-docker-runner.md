# Docker Runner 脚本切片验证

2026-09-09，#12 第二个功能 PR，base 为基础分支 codex/execution-foundation 的 2f237f0。主责 xiaoxuanli-a，Codex 实现、真实测试和作者自查，未进行独立多人审阅。

本地环境：macOS arm64、Node 26.0.0、Docker Desktop 4.73.0 / Engine 29.4.3，Linux 容器。测试镜像 alpine:3 实际 ID 为 sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b。每次创建都解析并使用实际 ID，不以标签代替身份。

执行 `AGENTFLOW_DOCKER_TESTS=1 npm run check`：严格构建、测试类型检查、依赖边界，以及 32 项测试全部通过，无跳过。其中五个真实 Docker 用例包含多个场景；其余为既有基础测试、Runner 后端替身和文件边界测试。

| 验证范围 | 实际证据 |
| --- | --- |
| 可写独立输入 | 两个并发容器修改/重命名/删除同源输入的各自副本，原件与另一任务读取不变；再次执行不继承 renamed 文件；文件副本 inode 不同 |
| outputs 所有权 | 删除容器后仍可读取输出；显式 release 后路径消失；重复 release 成功 |
| 执行事实 | 退出 0、退出 7、init 下缺失程序退出 127；不可用镜像在 CREATE_FAILED 结束，未自动 pull |
| 真正停止 | 已写 started 文件的长运行容器超时/取消后 stop confirmed，资源列表中已消失；另一并发容器完成未被误停 |
| 原始采集 | 200000 字节 stdout 流只保留 1024 字节并标截断，stderr 独立；state 原始文件保留非法 UTF-8/零字节；缺失记录显式不完整 |
| 资源和权限 | 容器内读取 cgroup 的 CPU/memory/PIDs 限制、CapEff=0、NoNewPrivs=1、非 root 身份、只读根目录、可写任务目录与 /tmp；无 eth0 |
| 故障分支 | 替身覆盖创建时取消、自然退出竞争、各阶段失败、停止 unknown、采集失败与清理失败；原始失败不被后续错误覆盖 |
| 文件边界 | 拒绝源符号链接、复制大小超限、原始记录越界/链接/FIFO；拒绝不支持的网络与普通秘密 env 参数 |

自查修正：严格类型联合；启动取消中的未确认状态；捕获 FIFO 前的非普通文件检查；attach 传输不完整标记；固定宿主 UID/GID 的权限匹配；单调时钟超时。真实测试发现 Docker --init 下“程序无法执行”是退出 127，按真实事实记录，并另测创建失败，没有把测试期望强加给后端状态。

CI Node 24/26 已加入 Docker pull 与真实用例开关。具体 PR head 的远端结果在 PR checks 核对；本地 32 项通过不替代远端结果。

本次只验收离线脚本切片，Refs #12。认证绑定、受限 endpoint 网络、三个真实 Harness、业务文件 contract、Workflow、崩溃恢复和最终 Tutor 批卷尚未由这些测试验证；整项保持开放。工作区没有磁盘配额，宿主输入来源要求是可信静止快照。

关联：[Runner 决定](../../.agents/decisions/product/README.md#p-20260909-runner-lifecycle)、[使用指南](../guides/runner.md)、[0.1.1 计划](../roadmap/0.1.1.md)。
