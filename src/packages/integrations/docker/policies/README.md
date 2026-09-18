# Docker 沙箱策略来源

`moby-seccomp.json` 是 Moby profiles 提交 `61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31` 的 `seccomp/default.json` 原件，SHA-256 为 `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`。原许可保留于 LICENSE.moby。[固定源文件](https://github.com/moby/profiles/blob/61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31/seccomp/default.json)。

这是 Apache-2.0 许可下的第三方配置资料。原件未修改；`../sandbox-policy.ts` 在内存中生成 nested-userns-v1 的差异，保留默认拒绝策略，仅调整明确列出的 namespace/mount 调用。旧 Black Box Agent Flow 的文件名 `bwrap-seccomp-v0.2.1.json` 不是 Moby tag，本项目不使用这个名称推断上游版本。

选择理由、增加的内核接口及适用环境见 [Runner 决定](../../../../../.agents/agent_notes/product/README.md#p-20260909-runner-lifecycle)。此目录不提供用户可选的任意 seccomp 文件入口。
