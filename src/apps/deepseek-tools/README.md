# DeepSeek 容器文件服务

这是 Linux 容器内程序，供固定 dsh 0.1.1-rc.2 的原生 FileSystem 服务使用。它不提供宿主库 API，不作为完整 Harness 注册。

fs-service.mjs 将原生文件操作交给受限子进程，fs-worker.mjs 使用原生 LocalFileSystem 保留观察版本及原子写入。tool-isolate.mjs 建立内核文件/进程/网络视图；sdk.mjs 从固定镜像安装根加载并验证 manifest 声明的 SDK 版本。可选 peer 表示宿主无需安装，在实际镜像内则必须具备。

程序作为只读配置文件放在 /task/config/deepseek-policy。调用层的独立临时目录在同一文件服务内持续存在，关闭服务后删除；每个 I/O 子进程必须关闭后才返回。文本/二进制完整读取上限 16 MiB，JSON 传输上限 32 MiB；streamText 当前为有界完整缓冲，超限返回失败。

当前已验证原生 read/edit/write 与独立文件接口；Bash、直接使用进程接口的搜索，以及完整 Harness 认证/终态组合仍未接通同等隔离。不能据此声称所有模型工具已隔离。详见 [验证记录](../../../docs/validation/2026-09-09-deepseek-file-isolation.md)。
