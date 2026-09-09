# 本地 API key 管理

当前 CLI 支持 DeepSeek API key 的交互录入、受控文件导入、检查和本地删除。它复用独立凭据存储；不发起模型请求，也不执行 Codex/Claude 订阅登录。仓库内部包尚未发布，先运行 `npm ci` 和 `npm run build`。

## 交互录入

在实际终端执行以下命令，把路径和引用替换为宿主选定的值：

```sh
node src/apps/cli/dist/index.js auth configure deepseek \
  --store /absolute/private/credential-store --credential-ref teaching
```

stdin 和 stderr 均须为终端。提示出现前已关闭回显；输入不显示星号或原文。Enter 提交，Backspace 删除一个字符，Ctrl-U 清空，Ctrl-C/Ctrl-D 取消；五分钟未完成则超时。空白、非 ASCII、非法控制字符或超过 8192 字符的输入拒绝；完整 key 仍须通过存储 codec 的 8–8192 字符检查。

正常、取消、输入失败和超时会恢复原终端模式。不接收 `--key` 参数、管道或终端环境中的 key；不要把真实 key 写入命令历史。终端输入只存在于此次受信进程内，程序不提供内存防取证承诺。

## 无交互来源

明确选择一个受控宿主文件：

```sh
node src/apps/cli/dist/index.js auth configure deepseek \
  --store /absolute/private/credential-store --credential-ref teaching \
  --file /absolute/private/source.json
```

source.json 必须是当前用户拥有、权限为 0600、无链接的普通文件，内容仅含 schema 与 api_key 两字段：schema 必须为 `agentflow-deepseek-key/v1`，api_key 为该 Profile 所选密钥。该文件由宿主提供，不自动搜索项目 .env、桌面登录或其他目录；不修改导入源。重复选项、多个文件来源和不支持的参数直接拒绝，不采用隐含优先级。

目标存储沿用 0700 目录、0600 文件与身份校验。配置可明确替换该 credentialRef 的已有内容，与其他管理操作使用相同的跨进程锁；忙碌时返回 CREDENTIAL_BUSY，不抢占。DeepSeek 正在运行的环境快照不持有源锁，配置变化只影响后续取得的快照。

## 检查与删除

```sh
node src/apps/cli/dist/index.js auth inspect deepseek \
  --store /absolute/private/credential-store --credential-ref teaching
node src/apps/cli/dist/index.js auth delete deepseek \
  --store /absolute/private/credential-store --credential-ref teaching
```

配置和检查只输出 credentialRef、服务、认证方式、generation、revision 与 remoteStatus=unknown；未配置时检查输出 null。已保存不等于 token 有效、订阅有效或尚有额度。delete 只删除本地已识别记录，输出 deleted 和 remoteRevoked=false；不撤销已取得的执行快照，也不宣称远端撤销。

退出码：成功 0，参数不支持/无效 2，输入或存储操作失败 1。错误不回显 key、源文件内容或任意异常文本。Profile 仍由受信宿主通过 [DeepSeek Profile/执行 API](deepseek-adapter.md)配置；CLI 不维护完整 Profile 数据库。

实际证据见 [本地认证入口验证](../validation/2026-09-09-auth-management.md)。订阅登录协调与安全备份恢复仍在 #11 范围内，当前不支持 `auth login`。
