# DeepSeek 容器工具服务

这是 Linux 容器内程序，供固定 dsh 0.1.1-rc.2 的原生工具使用。它不提供宿主库 API；宿主 DeepSeek Runner 通过 export-assets.mjs 打包只读部署资产，纯 Adapter 不加载应用源码。sdk.mjs / process-sdk.mjs 从固定镜像安装根加载并验证 manifest 声明的 SDK 版本。可选 peer 表示宿主无需安装，实际镜像内必须具备。

fs-service.mjs 把文件操作交给 fs-worker.mjs，使用原生 LocalFileSystem 保留观察版本及原子写入。bash-service.mjs 和 subprocess-service.mjs 将 Bash、grep/glob 等进程操作接入同一隔离策略。tool-isolate.mjs 建立文件、进程、网络视图，ToolSpace 管理整个任务共享的临时目录；全部服务关闭后清理。input/work/outputs 副本可写，工具不能读取私有 state 或父 CLI 环境。

程序放在 /task/config/deepseek-policy。launch.mjs 只接收显式环境密钥并调用固定 CLI，session-capture.mjs 在正常退出后采集私有原生会话，outcome-service.mjs 提供用户定义出口的结构化选择。正常终态和出口仍须由宿主 Adapter、Runner 事实及输出契约共同核验。

文件文本/二进制完整读取上限 16 MiB，JSON 传输上限 32 MiB；streamText 当前为有界完整缓冲，超限失败。每个 I/O 子进程关闭后才结束请求；取消同时停止专属进程组，避免后代持有管道阻塞后续请求。

真实 CLI 已通过断网合成服务驱动的文件、Bash、搜索、图像交接和出口验证。该证据不证明官方模型调用或任意版本兼容，见[进程验证](../../../docs/validation/2026-09-09-deepseek-process-isolation.md)与[执行组合指南](../../../docs/guides/deepseek-adapter.md)。
