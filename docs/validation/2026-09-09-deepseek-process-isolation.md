# DeepSeek 统一工具进程隔离

关联 #10/#11 与 [Harness 决定](../../.agents/decisions/product/README.md#p-20260909-harness-adapter)。这是文件服务之后的本地矩阵切片，不代表完整 DeepSeek Harness 已交付。

## 参考与对象

先查 Blackbox Agent Flow 已提交 5610d1b / v0.1.22 的 DeepSeek 定义、原生缓存/代理/输出目录修复及探针说明；其定义明确标记策略覆盖有限，没有同时覆盖文件、搜索与 Bash 的替换服务。之后查实际安装的 dsh 0.1.1-rc.2 的 subprocess、bash、fs-search、sandbox-policy 与 Cordis 接口。未修改 Blackbox 工作区。

镜像为 sha256:a92f35565532db0e3c9ace1454754a0232a35ff413d31ebe3c7a90e7ae78916b，Node 22.23.2。使用断网 Docker、合成凭据及容器内模型响应服务，实际运行原生 DeepSeek CLI；没有读取真实 DeepSeek 凭据、发起远程模型调用或下载学生材料。

## 实现边界

搜索原生插件直接调用 subprocess，不经过 Bash。现在以统一进程服务替换 native subprocess：默认对任务目录只读；Bash 使用继承的原生执行器处理参数、超时、后台、取消与输出，通过模块内 Symbol 传递有限写入权限。JSON 字段和环境变量不能伪造该内部标记。拒绝 danger-full-access 和 PTY，所有启动都经过同一 bwrap 隔离视图。

文件与命令共享任务级 ToolSpace，临时文件跨工具可见，外层 noexec 属性保留。进程有界溢写保持原生字节偏移与截断标记，返回的路径映射到工具可读的 /tmp/process-output。清理先阻止新请求，等待文件与进程服务停止后删除目录；关闭失败保留失败事实。

子进程默认会合并父环境，因此统一进程层显式删除全部继承变量并忽略调用侧环境注入，bwrap 再清空环境并设置固定 PATH/HOME/NARB。文件边界继续为只读镜像、隐藏 state、只读配置、固定 input/work/outputs 和独立 PID/网络视图。原生任务的权限运行上下文说明这些固定目录，不改写用户任务说明；保留原生会话 read-only 事件折叠，拒绝不同的会话工作根。

## 验证

真实 CLI 执行 15 个工具操作：Bash 修改输入副本/写 outputs、在 input 工作目录执行、文件工具读取 Bash 的临时文件、grep 读取修改后的输入和 glob 找到输出；直接私有路径、工作区符号链接、/proc/self/root 的 Bash/grep 读取失败，glob 不暴露私有文件名，私有状态和配置写入失败。模型工具输出没有父进程合成密钥，包括通用 PASSPHRASE；网络探针无法触达父进程本地 HTTP 服务，其计数为零。宿主独立核对原始输入不变、输入副本已改、输出正确、私有文件与配置未改，并核对模型实际收到固定目录的权限上下文。

真实进程接口额外验证：默认只读和伪造权限字段/环境不能改写输出；会话只读、错误工作根及全权限模式按约定处理；忽略调用侧 PATH/LD_PRELOAD/秘密注入；溢写完整内容可由文件服务读取；Bash 与文件工具双向共享临时文件；后台完成及增量输出、超时分类、调用取消、主进程先退出及服务关闭后均无延迟子进程副作用，临时目录已清理。

本轮实际发现插件加载竞争：文件服务先就绪会让原生工具在 sandboxPolicy 未就绪时启动失败。先查 Blackbox 未找到对应修复，再依原生接口补上显式服务依赖。测试驱动另修正 Bash 必需 description 参数，以及将权限上下文误当作稳定 system prompt 的断言；原生实现把它放在可追溯的运行上下文消息中。

完整 npm run check 启用 Docker、受控联网及三个既有 Harness 镜像，176 项通过、0 失败、0 跳过；包含依赖边界、构建、测试类型检查和全部测试。作者检查；没有独立评审、远端 CI 或发布。

## 剩余范围

服务资产目前由测试显式装配；尚未形成可执行 DeepSeek Adapter/Runner 组合。真实 read_image 的图像交接、可信原生事件采集与终态解释、API key 绑定和实际模型验收仍待完成。本次没有验证所有可能的原生插件入口，也不据此宣称完整凭据矩阵或 Tutor 批卷、报告与 PDF 已完成。
