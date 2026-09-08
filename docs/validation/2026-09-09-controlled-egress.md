# 受控 CONNECT 联网验证

对象：Draft PR #19 的 Docker egress 切片，基于 codex/first-harness 7cb91ba 增量；Refs #10/#11/#12。环境为 macOS arm64、宿主 Node 26.0.0、Docker Desktop 4.73.0 / Engine 29.4.3。代理和探测任务使用 Node 22.23.2，实际镜像 ID 为 `sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`。未使用真实凭据或调用模型。

## 执行与结果

启用 AGENTFLOW_DOCKER_TESTS=1、AGENTFLOW_EGRESS_TESTS=1 和既有已核对 Codex 0.153.4 镜像的 AGENTFLOW_CODEX_IMAGE 后执行 `npm run check`：依赖边界、构建、测试类型检查通过；58 项测试全部通过、0 失败、0 跳过。

新增 5 组代理测试使用实际本地 TCP 套接字与替换的 DNS/拨号传输：256 KiB 管道及预读数据完整转发；未授权主机、端口、IP 和普通 HTTP 在解析前拒绝；私有/混合地址、空解析及解析异常不得拨号；不回显异常文本；过大/慢报头、查询期限和未返回 DNS 的准入限制有效。

新增 3 组真实 Docker 测试覆盖：

- 任务经代理连接 example.com:443，验证 TLS 证书并收到 HTTP 响应；同时直连公网 IP、外部 DNS、未知 CONNECT 域名和 IP 字面量被拦截。
- 运行中取消，以及主动终止代理，均确认任务已停止并删除同一归属的任务、代理及网络；代理失效产生 OBSERVE_FAILED。
- 使用缺少 Node 的代理镜像注入启动失败，任务未启动，已部分创建的容器和网络全部清理。

最初真实用例暴露创建代理后、启动前读取 IP 为空的问题。已改为连接网络并启动代理后读取实际地址；原失败用例与完整回归均已通过。测试诊断也不再读取尚未启动时并不存在的 stderr 文件。

## 边界

这些证据证明当前环境的受控网络及资源生命周期，不证明真实订阅、刷新、模型任务或 Tutor 批卷已完成。默认 Node 24/26 CI 只启用普通 Docker 测试；专用 Codex 沙箱 1 项和本次联网 3 项需显式环境配置，跳过不可算 Linux 联网或沙箱验收。外部服务故障应报告实际失败，不改成宽松网络或伪造成功。

Docker 的 internal bridge 本身仍可能提供宿主桥地址，因此使用 internal + isolated gateway，并检查实际网络配置；不支持时失败。[Docker bridge 文档](https://docs.docker.com/engine/network/drivers/bridge/#gateway-mode)、[端口发布与 isolated 模式](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)（2026-09-09 核对）。TLS 内容保持不透明，连接目标策略不等同应用层 URL 策略。IPv6、任意端口和非公开 endpoint 不在本切片范围。

对应取舍见 [Runner 决定](../../.agents/decisions/product/README.md#p-20260909-runner-lifecycle) 与 [认证决定](../../.agents/decisions/product/README.md#p-20260909-auth-lifecycle)，配置见 [使用指南](../guides/controlled-egress.md)。
