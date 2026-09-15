# DeepSeek 原生文件服务隔离

关联 #10/#11、[Harness 决定](../../.agents/decisions/product/README.md#p-20260909-harness-adapter) 和 [源码布局决定](../../.agents/decisions/development/README.md#d-20260909-source-layout)。本次只完成文件服务切片，尚未提供完整 DeepSeek 执行组合。

## 对象与方法

先查 Blackbox Agent Flow 已提交 5610d1b / v0.1.22 的 DeepSeek 定义、原生缓存与输出目录修复历史及 bwrap 探针，没有找到同时满足固定目录和私有读取保护的现成实现。之后查实际镜像的 FileSystem、LocalFileSystem、sandbox、工具与 Cordis 服务代理源码。未修改 Blackbox 的现有工作区。

镜像与 [前次配置预检](2026-09-09-deepseek-compatibility.md) 相同：dsh 0.1.1-rc.2，镜像 ID sha256:a92f35565532db0e3c9ace1454754a0232a35ff413d31ebe3c7a90e7ae78916b。使用断网 Docker、只读镜像、外层 noexec 临时目录以及合成凭据/本地模型响应，真实 dsh 执行原生工具；没有真实账号、远程模型或学生材料。

## 实现

独立容器程序位于 src/apps/deepseek-tools，不与宿主 integrations 合为一个 SDK 运行环境。精确版本的可选 peer 由镜像提供，启动时验证；npm 锁文件只新增工作区链接/声明，没有给宿主安装原生 Harness SDK。工程依赖检查覆盖此应用，也检查 createRequire 与其 resolve 后的静态依赖名，继续拒绝计算名称、绝对模块导入和未声明依赖。

原生 FileSystem 服务在父进程只代理方法；所有 resolve/stat/read/list/write/edit 的实际 I/O 均由受限子进程的原生 LocalFileSystem 完成。只读根目录、空只读 state、独立 PID/网络视图、清空环境，只有 input/work/outputs 及服务私有临时目录可写；原子写与版本检查仍由原生实现负责。没有父进程文件读取回退，也不依赖先检查路径字符串再打开文件。

每次 I/O 使用一个子进程，按服务串行执行；临时目录在同一服务内复用，保持 /tmp 文件跨请求可见，关闭服务后清除。继承环境在启动与 bwrap 内两次收窄。文本及字节读取完整内容上限 16 MiB，JSON 传输上限 32 MiB；streamText 暂为有界完整缓冲，超限失败。中断杀死进程并等待 close，再返回失败和允许后续请求；服务关闭后拒绝新请求。没有 danger-full-access 回退。

## 结果

真实 CLI 执行 8 个文件工具操作，验证：读取中文输入、修改输入副本、写入 outputs 成功；私有文件的直接路径、工作区符号链接、/proc/self/root 路径读取均失败；私有状态和协议配置改写均失败。宿主侧独立核对输出为“批改完成 ✓”、输入副本已改、原始输入仍为“原始答案”，私有合成文件和配置未改。

独立真实服务测试验证：

- 临时文件跨请求可读取；文件版本变更后拒绝旧版本覆盖。
- read-only 拒绝写入；显式 danger-full-access 也拒绝；原内容保持。
- 二进制精确往返、文本格式拒绝、字节上限和超过 16 MiB 的文本均按边界处理。
- 读取子进程 /proc/self/environ 的原始字节，不包含父进程合成密钥或 DEEPSEEK_API_KEY；不是通过文本解码拒绝来假证隔离。
- 子进程 /tmp 挂载实际含 noexec。
- 观察真实子进程启动后触发中断，返回 FS_ABORTED 时 close 已发生，原 PID 已不存在；后续请求可继续。
- 关闭服务后拒绝请求，临时目录清理完成。

实现中发现三个真实集成差异：仅 patch 插件 name 不会替换旧服务，修正为禁用旧条目并 insert 新条目；Node22 在原生插件并发装载期间同步 require ESM 会报内部错误，改为固定依赖解析后的异步 import；Cordis 以调用上下文代理服务，未绑定的方法会破坏 JavaScript 私有字段接收者，改为绑定持有显式 policy 的服务方法。独立服务与真实 CLI 两条测试都通过后才认定修复。

## 限制与后续

原生文件 read/edit/write 已验证；readBytes 接口经过二进制测试，但尚未用真实 read_image 工具完成图像模型交接。Bash 及直接走原生 subprocess 的搜索路径仍须接入同等权限策略，不能声称全部模型工具或完整凭据隔离已完成。纯 Adapter、可信原生事件采集/解释、API key 绑定、真实 DeepSeek 调用与完整矩阵仍未完成；当前没有将本服务装配为可执行 Harness。

固定目录保持 /task/work 和 /task/outputs；旧 stock 策略预检仍保留，作为缺口对照。本次作者检查，未做独立评审、远端 CI 或发布。完整 npm run check 回归 174 项通过、0 失败、0 跳过（约 104 秒）。最终补充“只读模式也拒绝临时文件写入”后，2 组受影响的真实文件测试再次通过；最终 manifest 与锁文件更新也通过依赖检查。

后续进程切片将临时目录所有权提升为任务级 ToolSpace，供文件与进程服务共享，全部服务退出后才删除；Bash 和直接走 subprocess 的搜索也已接入，见 [后续验证](2026-09-09-deepseek-process-isolation.md)。上述 174 项记录保留当时范围。
