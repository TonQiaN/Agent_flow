# Docker Runner

当前提供一次确定性脚本执行。Node.js 24+、npm、可访问的 Docker Engine、已拉取的测试镜像，以及非 root 的 macOS/Linux 宿主用户是前置条件。容器 UID/GID 与该宿主用户一致，以访问私有 bind mount；尚不支持任意身份重映射、Windows 或 root 宿主执行。

```sh
npm ci
npm run build
docker pull alpine:3
node src/examples/docker-script.mjs
AGENTFLOW_DOCKER_TESTS=1 npm run check
```

示例只创建合成临时文件：容器修改自己的 answer.txt，再复制到 outputs；宿主 original 仍为 original，output 为 edited。示例读取输出后显式 release。普通 npm run check 不要求 Docker，明确跳过对应环境用例；带环境开关才实际执行。CI 的 Node 24/26 检查启用 Docker，用例失败会阻止检查通过。

Runner 从 `@agentflow/engine` 导出；DockerBackend 与 systemClock 从 `@agentflow/integrations` 导出。示例展示完整调用：后端接收宿主 workspaceRoot/image，RunnerRequest 接收关联身份、inputSource、timeoutMs 和 invocation.argv。timeoutMs 包含准备及启动等待，最大 24 小时；停止/采集/清理另外有界执行，方法返回时间可能晚于超时请求。时钟使用单调经过时间，避免系统校时延长任务时限。

| 容器路径 | 用途 |
| --- | --- |
| /task/input | 独立可写输入副本；修改、删除、重命名不会写回来源 |
| /task/work | 固定 cwd，可写临时工作区 |
| /task/outputs | 待独立 contract 校验的业务交付候选 |
| /task/state | 私有 HOME 与 Harness 原始记录；不是业务 outputs |
| /task/config | 只读非秘密配置边界；Invocation.configFiles 按相对名称注入文本 |

输入来源必须是调用方控制的静止目录快照。复制拒绝符号链接及非普通文件，检查读取期间文件变化；上限为 4096 文件、8192 目录/文件条目、64 层及 256 MiB。它不提供对抗宿主其他进程恶意并发换目录的安全边界。输出树由后续文件 contract 收集器校验，Runner 不代替契约接纳；当前不提供工作区磁盘配额。

非秘密 `configFiles: [{name, content}]` 每次创建新文件，最多 16 个、每个 UTF-8 文本 64 KiB，相对路径最多 256 字符/8 层。拒绝绝对路径、越界、重名、父子文件冲突；配置不能从容器修改。秘密不放在此 JSON 描述中；宿主可通过独立 PrivateStateBinding 接入私有工作副本，见 [执行凭据绑定](harness-auth.md#执行凭据绑定)。

宿主可明确选择 `sandbox: 'nested-userns-v1'` 来支持内部 bwrap；默认 `standard` 不变。该策略保留 seccomp 默认拒绝、非 root、空 capabilities 和只读根目录，允许指定 namespace/mount 系统调用以及 bwrap 所需的系统路径；没有任意 seccomp 文件、privileged 或安全选项透传入口。已验证环境及限制见 [沙箱验证](../validation/2026-09-09-codex-sandbox.md)。network 默认 none，宿主可选择独立 CONNECT 代理，见 [受控联网](controlled-egress.md)；这不证明真实认证 Harness 已完成联合验收。

后端默认 1 CPU、512 MiB 内存（不额外允许 swap）、128 PIDs、64 MiB /tmp；根文件系统只读，丢弃全部 capabilities 并启用 no-new-privileges。容器使用 `--init`，按已解析镜像 ID 创建。镜像由宿主信任并选择，Runner 不自动 pull。普通 Invocation.env 仅允许 LANG、LC_ALL、TZ。PrivateStateBinding 单独声明 /task/state 下的路径环境，不能覆盖 HOME、代理或其他后端环境。真实 provider/Profile 与 Harness 运行组合仍在实施。

结果 phase 表示 exited/failed/cancelled/timed_out；exited 必须结合 exitCode 看进程状态，不能当作业务成功。启用 init 时找不到目标程序可表现为退出 127，镜像解析/创建错误则记录 CREATE_FAILED。业务 outcome 与输出 contract 不由 Runner 决定。

取消参数为 `{ requested: () => boolean }`，可以连接调用者的 AbortController；不传递平台对象到可移植 engine。已观察到自然退出后，不因更晚的取消改写结果。停止返回 confirmed/unknown/not_started，unknown 时不删除执行资源。cleanup 与原始 phase 独立；capture、stop、cleanup 失败不会吞掉原始执行事实。后端只允许操作自己登记且标签匹配的资源。

stdout/stderr 流式写入私有 raw 文件，默认各 1 MiB；超过上限继续排空且 truncated=true、complete=false。原始字节不做强制 UTF-8 转换。Docker 日志存储关闭，避免另存无限日志。早结束的 attach、退出码不一致或捕获 I/O 失败被标为不完整；解析方必须检查 complete/error，而不能把截断事件当作完整记录。

invocation.recordFiles 可声明最多 16 个 state 内相对文件：`{ id: 'events', path: 'events.jsonl', maxBytes: 1048576 }`。每个最大 1 MiB，禁止越界、符号链接和非普通文件；stdout/stderr 是保留 ID。缺失、截断、读取失败单独可见。raw 记录可能包含敏感业务内容，只供私有诊断或 Adapter 解析，不能当作普通 outputs 发布。

执行后先保留 raw 文件，再删除容器；outputs 和整个私有工作区继续存在。接收方完成校验、复制或接纳以后调用 runner.release(result.resource)，才删除工作区；重复 release 幂等。容器删除失败、停止未确认或私有凭据绑定尚未完成收尾时 release 拒绝。需要手工修复时使用结果内 resource.id 定位本次资源；进程崩溃后的认领与恢复由独立的 [Workflow 恢复协调](workflow-recovery.md)调用 Runner 资源端口完成。

完整需求和未覆盖项见 [#12](https://github.com/TonQiaN/Agent_flow/issues/12)；设计边界见 [Runner 决定](../../.agents/decisions/product/README.md#p-20260909-runner-lifecycle)。

## 宿主系统配置映射

DockerOptions.systemConfigMounts 可将本次 configFiles 中的文件只读映射到 /etc 子目录内，例如 `{ name: 'managed.json', target: '/etc/example/managed-settings.json' }`。它是宿主后端选项，不是任务可传入的挂载列表；来源不接受宿主绝对路径，目标不接受根配置文件、路径逃逸或重复/父子冲突。缺失来源在凭据准备前拒绝。适用于只读取固定系统位置的程序；/task/config 仍保留原本只读文件。

[持久资源与恢复](runner-resource-recovery.md)提供显式保存端口及新进程旧资源收尾；Workflow 恢复协调另行接入。

[Runner 输入物化](runner-owned-input.md)支持空输入和宿主安装的快照物化能力，继续保护原始文件与固定容器目录。
