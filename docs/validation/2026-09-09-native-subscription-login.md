# 原生订阅登录驱动验证

## 范围与预检

基线为本地 54fcf50，Refs #11/#12，沿用认证生命周期决定及用户已确认的解耦边界。主负责开发者为项目负责人，Codex 实施与作者自查；没有独立评审或远端 CI 结论。本次仅合成凭据、合成登录程序、固定原生镜像的断网帮助，不读取桌面凭据、不进行 OAuth 或模型请求。

按用户要求先核对 Blackbox Agent Flow v0.1.22 / 5610d1b 的 credentials.py、test_credentials.py 与 Harness 定义。参考其独占管理、原生命令、终端输入、CLI 退出后检查凭据、排除环境凭据的做法；Blackbox 登录用 bridge，当前沿用已确认的 CONNECT 限定地址，长期存储不直接挂载。Blackbox 的交互流程不证明本项目的 Docker 客户端或私有采集已正确，因此另外验证。另核对其 credential_is_configured，仅验证文件存在及权限，没有覆盖 Claude 清空 token 的首次登录语义，不能直接沿用。

## 实施及证据

两个独立 provider 驱动复用 Docker 登录组合；通用 Runner 不增加 provider 分支。离线版本探针与登录使用同一镜像 ID；只有版本匹配、原登录退出成功、停止及移除确认、输出采集完整、私有文件检查通过，管理协调器才保存。宿主 interaction 是独立私有能力，不进入普通结果。

固定 Codex 0.153.4 的 `login --help` 包含 device-auth；Claude 2.1.226 的 `auth login --help` 包含 claudeai。这些命令实际在无网络、无凭据挂载的选定镜像内执行。后续合成登录程序检查两家的精确 argv、独立空状态目录、无 ambient provider key、代理环境，并通过真实 Docker stdin 接收合成授权码后写私有凭据。

合成测试覆盖两个成功路径、管理锁排他、退出失败、缺失/无效/权限不安全/链接文件、取消、交互输出错误、错误版本、开始前取消，以及登录容器移除失败后的清理重试。故障注入仅让一次 owned-container rm 失败，核对未保存、锁未释放、私有目录保留；恢复后一次保存且没有再次登录。另有传输测试覆盖默认 EOF、交互输入有界、disposer 一次执行和错误采集标记。

## 结果与限制

首次完整回归 249 项通过，0 失败、0 跳过。随后自查发现 Claude 刷新失效标记可能被首次登录接纳；新增合成 Docker 用例实际复现 configured/failed 差异，再增加独立登录有效性检查，保留原刷新标记存储语义。修正后的最终 `npm run check`（Docker、egress、三个固定原生镜像开关均启用）250 项通过，0 失败、0 跳过，约 105 秒；包含构建、测试类型与依赖边界检查。85 个本地文档链接及 git diff --check 通过。第一轮测试数据缺少既有 ExecutionIdentity.attemptNumber，被类型检查和协调器拒绝；补齐后首轮 12 项通过。这是测试数据修正，没有放宽产品身份校验。

未验证真实 OAuth 授权、浏览器回调、Claude 原生手动代码输入、登录服务完整地址需求、真实账号刷新。未提供宿主 CLI auth login 或进程重启后的登录句柄恢复，安全备份恢复仍待实现。本地 configured 只证明保存及清理，不证明远端订阅有效。没有新远端 PR 或生产发布。
