# 本地认证管理与真实终端验证

2026-09-09，Refs #11；主负责开发者 @xiaoxuanli-a，Codex 作者自查。代码基线 d4a16fd，后续本切片新增本地认证入口；没有独立审阅或远端发布。

## 依据与边界

按用户要求，先查看 Blackbox 的 api_keys.py、credential_env_file.py 和 test_api_keys.py。继承终端不回显、拒绝 argv/环境/管道密钥、显式受控文件来源及来源冲突拒绝。旧实现对终端主要使用 mock，本次额外通过实际 POSIX PTY 检查回显与模式恢复；旧注释中“没有文件来源”不替代其后续代码事实。

新增 CLI 的 `auth configure|inspect|delete deepseek`，要求显式 store 和 credential-ref；configure 可选择唯一 --file，否则必须有终端 stdin/stderr。没有自动路径搜索、远端认证或模型调用。CLI 组合终端 UI 和现有 FileCredentialStore，engine、Adapter、Runner 不增加管理菜单或读取秘密的分支。

终端组件在提示前关闭回显，限制输入长度与字符，支持退格、清空、提交和取消；处理 Ctrl-C/Ctrl-D、SIGTERM、输入异常及超时，最后恢复原模式并清零自己的字节缓冲。JS 字符串和操作系统缓冲不提供可证明的擦除保证；SIGKILL 等无法处理的进程终止不在应用恢复保证内。产品超时五分钟；测试使用同一输入组件的受信超时参数缩短等待。

参数解析拒绝重复选项、多个来源、key 参数及未支持的订阅 login。文件导入复用 0600、当前所有者、普通单链接文件、内容 codec 与跨进程锁。管理命令只输出非秘密元数据或本地删除结果，remoteStatus=unknown、remoteRevoked=false 不因配置成功改变。

## 实际验证

环境：macOS arm64、Node 26、Python 3 标准库 PTY、Docker。临时文件和输入均为固定合成值，没有访问真实账号材料。

- 编译后 CLI 导入显式文件、读取确切已选值、检查本地元数据、运行占用时删除失败、释放后本地删除、原导入文件不变。
- 拒绝管道、key 参数、重复 file/store 参数、检查时指定文件、未支持 provider/login；拒绝过宽文件权限、符号链接和错误格式。终端残留环境密钥不成为备用来源。
- 九个独立真实伪终端场景：正常录入、退格/Ctrl-U 编辑、Ctrl-C、Ctrl-D、SIGTERM、非法字符、超长、过短和超时。每个检查提示时 ECHO 已关闭、退出后的 termios 与原值相同、输入没有出现在可见输出；失败不保存记录，成功保存完整预期值。
- 认证入口与旧 demo 合计 **13 项专项检查通过**；完整 `npm run check` 启用 Docker/egress 与三个所选 Harness 镜像后 **224 项通过、0 失败、0 跳过，约 105 秒**。依赖边界、构建和测试类型检查包含在内。

新增测试依赖 POSIX 和可执行的 python3，仅用标准库；文档注明这一条件。工作区依赖仅增加 CLI 对现有 integrations 包的声明，没有新增外部 npm 包。Linux/Node 24 的远端 CI 未在本切片执行，不把本地成功称为该组合已通过。

## 仍未完成

本次补齐 #11 的实际交互录入与本地管理入口，仍不等于实现订阅登录。订阅登录协调、安全备份恢复、Claude/DeepSeek 官方调用及真实 OAuth 刷新继续保留；真实学生批卷、完整报告和 PDF 也未验收。矩阵和相关 Issue 保持开放。

使用方法见 [本地认证管理](../guides/auth-management.md)，取舍见 [认证决定](../../.agents/decisions/product/README.md#p-20260909-auth-lifecycle)。
