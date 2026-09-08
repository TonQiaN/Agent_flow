# Docker 受控联网

DockerBackend 默认 `network: 'none'`。宿主可选择以下网络配置；这是环境能力，不能由 Agent 任务或任意 argv 改写：

```ts
network: {
  kind: 'connect-proxy',
  proxyImage: 'node:22-bookworm-slim',
  allowedHosts: ['example.com'],
}
```

前置条件为 Docker Engine 28 或更新版本、支持 isolated gateway 的 bridge 驱动，以及本地已存在的代理镜像。代理镜像须包含可执行 Node；当前独立代理实测 Node 22.23.2，宿主工程仍要求 Node 24+。后端在创建前固定任务与代理的实际镜像 ID，不自动拉取。包须先构建，代理运行本包编译产物，只读挂载代码，不挂任务或凭据目录。

每个 Attempt 独立拥有一个代理、内部 isolated bridge 和外连 bridge。任务仅连接内部网络，通过固定 hosts 条目使用 HTTP_PROXY / HTTPS_PROXY（同时设置小写变量），NO_PROXY 为空；外部 DNS 转发关闭。代理只接受列表内精确域名的 443 CONNECT，解析结果必须全部为公网 IPv4，随后直接拨号已检查地址。普通 HTTP、IP 字面量、通配符、私有地址和 IPv6-only 目标不受支持。代理不解密 TLS，因此限制的是 CONNECT 连接目标，不验证 TLS 内的路由、URL 或业务内容；调用方仍应验证服务证书。

报头最多 8 KiB，最多 32 个客户端连接，报头期限 5 秒、解析与连接期限 10 秒、隧道空闲期限 5 分钟。尚未返回的 DNS 查询占用准入名额，不能靠断开客户端不断制造后台查询。转发保留背压及报头后已读字节，不记录原始请求。此能力不是任务磁盘配额或带宽配额。

代理退出使正在执行的任务停止，不能回退直连。任务确认停止并完成采集后，清理同一资源的任务、代理和两张网络；归属不匹配、停止未知或清理失败均保留可见失败。`RunnerResult.capture.network` 记录代理镜像 ID 和允许目标，不能据此推断真实认证通过。

本地联网验收：先准备上述镜像和 alpine:3，再设置 `AGENTFLOW_EGRESS_TESTS=1` 执行 `npm run check`。可用 `AGENTFLOW_PROXY_IMAGE` 明确替换测试镜像。测试访问 example.com 的公开 TLS 服务；当前默认 CI 未启用此网络用例。实际结果及局限见 [联网验证](../validation/2026-09-09-controlled-egress.md)。私有执行绑定已有合成刷新与真实 Docker 验证；Profile endpoint 和真实模型联合执行仍在实施。
