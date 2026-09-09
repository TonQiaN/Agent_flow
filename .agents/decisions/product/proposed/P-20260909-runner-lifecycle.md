# Runner 协调一次执行，Docker 后端管理具体资源

创建于 2026-09-09。

## 结论与边界

按 #12 已确认范围，Runner 只协调一次 Attempt 的准备、创建、启动、观察、停止、采集和清理，不解释 Harness 事件、业务 outcome、contract 或 Workflow 路由。后端接口位于 engine，文件系统、进程、Docker 和时钟实现位于 integrations。确定性脚本直接提供 argv，不经过 Harness Adapter。

固定容器布局为 /task/input、/task/work、/task/outputs、/task/state。cwd 为 /task/work，HOME 为 /task/state。input 为逐文件复制的可写私有副本，禁止把源目录可写直挂或硬链接进容器；拒绝源树中的符号链接和非普通文件。每次调用分配新的资源 ID 与私有工作区，外部 Run/NodeTask/Attempt 标识只作关联，不复用上次可变目录。

Harness 配置另设统一 /task/config，只读挂载，与可写 input/work/outputs/state 分离。它承载宿主生成的非秘密协议配置，避免用户任务修改 outcome schema 等执行约定；不作为业务输入或 artifacts 交付路径。配置内容落地及容器中不可写已验证，认证绑定继续联合实现。

非秘密配置通过 Invocation.configFiles 的相对名称和文本内容注入，逐 Attempt 创建新文件，限制数量/大小并拒绝路径越界、重名与父子文件冲突；不从任务目录寻找配置。认证材料不放入这个 JSON 调用描述，后续独立绑定。

Docker 后端允许宿主单独注入私有 state 初始化能力，与可序列化 DockerOptions / Invocation 分离。初始化只接收当前资源及已分配的 state 目录；路径环境必须指向固定 state 子路径，不得覆盖后端环境或代理配置。后端不读取秘密、不回存凭据，也不负责租约释放；绑定在 Runner 返回真实停止/清理事实后完成这些步骤。

受控联网由独立 Docker egress 模块管理，每 Attempt 建立 internal + isolated gateway 的私有桥；只有代理同时连接独立外连桥，不发布宿主端口。节点只接私有桥，禁用外部 DNS 转发并通过固定 hosts 条目定位代理；不能仅设置 HTTP_PROXY 后保留直连通道。代理接受宿主白名单中的精确域名:443 CONNECT，拒绝普通 HTTP、IP 字面量、通配符、未授权域名及解析到非公网的地址。首版只拨号经校验的 IPv4 解析结果，不再次按域名解析，IPv6-only 目标明确不支持。代理限制报头、连接数、解析/连接与空闲时间，保留管道背压，不记录原始请求或秘密；它约束连接目标而不检查 TLS 内的路径或内容。

代理和两张网络归同一 ExecutionResource，使用随机名称/归属标签核对；代理失效不能自动转为直连。Runner 先确认任务停止和采集，再删除任务、代理与网络；停止未知保留资源，清理错误可见。普通离线路径不分配网络。宿主明确选择代理镜像并固定实际 ID，代理代码来自本包的已编译模块，只读挂载，不挂任务或认证存储。Docker 必须兑现 isolated gateway；不支持时失败，不静默退为普通桥。

真实 Codex 0.153.4 的 bwrap 需要嵌套 user namespace。Docker 环境增加宿主显式选择的 nested-userns-v1 策略，普通脚本仍使用原默认策略；Adapter 仅声明需要，不能直接切换安全选项。内置策略基于固定提交的 Moby allowlist，增加嵌套 namespace/mount 所需调用并取消与 clone3 冲突的 errno 规则；仍默认拒绝其他调用，不允许 seccomp=unconfined、额外 capabilities 或 privileged。允许 systempaths=unconfined 供 bwrap 建立内部 /proc 挂载，但保持外层私有 PID/IPC、非 root、cap-drop ALL、no-new-privileges、只读根文件系统与资源限制。此能力增加内核可调用面，必须绑定实际环境验证；不推断任意 Linux 主机的 AppArmor/userns 设置均兼容。

Docker 镜像由宿主配置选择，创建前解析实际镜像 ID，随后按该 ID 创建。默认 CPU 1、内存 512 MiB、PIDs 128、非 root 的宿主 UID/GID（首期要求相同身份，不支持 root 宿主或任意映射）、cap-drop ALL、no-new-privileges、只读根文件系统及有界 /tmp tmpfs；input/work/outputs/state 可写。默认 network=none；第三层增量增加上述受控代理，仍拒绝无约束 bridge。认证注入及真实 Harness 联合执行尚未完成，不能把独立联网验证当成联合验收。

Runner 接收宿主选定的非秘密 argv；首期普通环境变量只允许 LANG、LC_ALL、TZ，固定目录环境由后端设置。调用参数不进入普通结果。原始 stdout/stderr 与 state 下声明的记录文件是私有原始证据，独立于 outputs。stdout/stderr 在 Docker attach 启动时流式采集，每流默认最多 1 MiB，超限继续排空并标记截断；Docker 自身关闭日志存储，避免重复无限增长。记录文件逐个有界读取，缺失、链接、截断和传输错误均可见，未知编码保留为字节。

停止事实与请求分开：取消/超时触发停止，先尝试宽限停止，再必要时 kill，并检查容器确实非运行态。使用单调经过时间判断截止，避免系统校时延长运行。无法观察时保留 unknown，不把杀死 Docker CLI 当作容器已停止。创建中取消在创建操作返回后先检查请求再启动；后端命令自身有有界超时，部分创建失败仍用预先分配的资源身份清理。已观察到自然退出后不将后到取消改写成已取消。

先停止、再采集、最后删除容器。容器删除失败与原始执行失败分别保留。inputs/work/state/raw/outputs 所在私有工作区保持有效，由调用者在契约验证及交接完成后显式 release；release 只操作后端拥有、容器已删除的资源，不按外部提供路径删除。首期工作区没有磁盘配额，输入复制有总量/文件数上限；输出树边界由后续 contract 收集器落实。进程崩溃后的资源恢复由 #13 实现。

## 方案考量（alternatives）

| 方案 | 收益 | 代价 | 取舍 |
| --- | --- | --- | --- |
| engine 生命周期 + integrations 后端 | 替身可测，替换环境不改业务 | 需明确未知状态与所有权 | 采用 |
| docker run --rm，一次阻塞调用 | 实现短 | 容器过早删除，文件采集和运行中取消难可靠 | 不采用 |
| 可写挂载原输入 | 零复制 | 容器改写上游/宿主资料 | 用户明确排除 |
| 无限缓冲后截断 | 代码简单 | 内存和磁盘使用在截断前已失控 | 流式上限，显式截断 |
| 首期直接开放 bridge 网络 | 易运行模型 | 无法兑现认证 endpoint 约束 | 采用离线默认与单独验证的受限代理 |

## 影响与验证

PR2 部分覆盖 #12，使用 Refs。后端替身覆盖创建期间取消、观察失败、停止未知、采集/清理失败及退出竞争；真实 Docker 脚本验证并发副本、输出保留、正常/非零/启动失败、长输出与原始文件、权限/资源/网络约束，以及超时与取消确实停止且不误伤另一 Attempt。实际环境、镜像和结果写入验证记录。此决定继续 proposed，认证与三 Harness 联合验收未完成。

## 重开条件

实际 Harness 要求其他目录、程序权限或网络能力时，优先在专属配置与后端能力中适配；不能改变用户统一工作目录或独立输入副本边界。若 attach 行为不能可靠保存记录，需调整采集方式并补足故障证据。

## 确认与变更留痕

- 2026-09-09：用户已明确授权八项按顺序实现、验证并提交 PR；#12 的生命周期、输入隔离、真实终止与先采集再清理此前已确认。目录名、首期离线脚本范围和资源默认值是授权内的常规实施选择。基础来自 PR #17；不把脚本切片当成真实 Harness 或完整 #12 验收。

2026-09-09 系统配置挂载细化：Docker 宿主选项可声明有限的配置文件到 /etc 子目录的只读映射。来源只能是本次已声明的 configFiles 内相对文件，不接收宿主任意路径，目标须为规范绝对文件路径；拒绝重复、父子冲突和缺失来源。映射属于宿主后端选项，不加入 Workflow/Runner invocation 的任意挂载能力；provider 组合负责选择固定系统位置，通用后端只实现该映射。此接口解决 CLI 忽略管理路径环境变量的实际问题，并保持 /task/config 只读和版本探针无凭据。
