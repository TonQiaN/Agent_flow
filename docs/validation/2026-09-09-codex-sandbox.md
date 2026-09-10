# Codex 内部沙箱与只读配置验证

对象：Draft PR #19 中，基于 624b85b 的续作。未关闭 #10/#11/#12，也未完成首个真实联网组合。

## 问题与修正

上段真实 Codex 0.153.4 初始化因 bwrap 无法创建 namespace 失败。参考旧已验证的专用策略后发现第二个问题：整个 CODEX_HOME 被 deny 时，里面的 codex-linux-sandbox 启动别名也被拒绝执行。现已改为拒绝声明的认证文件，并在 Docker 环境提供独立的 nested-userns-v1 选择；Adapter 仅声明要求，不操作 Docker。

策略原件来自 Moby profiles 固定提交 61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31，Apache-2.0 许可与来源保留在代码旁。派生策略明确增加 15 个 namespace/mount 调用，移除这些调用原有的条件/errno 条目以避免 clone3 冲突；其他默认拒绝及限制保留。Docker 的系统路径放开仅供内部挂载，外层私有进程/IPC、非 root、cap-drop ALL、no-new-privileges 和只读根目录仍存在。增加内核接口是实质安全配置变化，不称与标准策略完全等价。[Docker seccomp 说明](https://docs.docker.com/engine/security/seccomp/)。

Invocation.configFiles 已落地为只读的逐 Attempt 文本文件；覆盖协议 schema 读取、写入失败、路径越界、父子冲突、重复项和文件数量/大小限制。

## 实际执行与结果

2026-09-09，macOS arm64 / Node 26.0.0 / Docker Desktop，实际 Codex CLI 0.153.4：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_CODEX_IMAGE=<已核对的本机镜像> npm run check
```

50 组全部通过、0 跳过：依赖边界、构建、测试类型检查、既有 Component/Harness/凭据回归、7 组真实 Docker 用例、1 组真实 Codex 沙箱用例。

Codex 用例通过新 Runner 启动实际镜像中的 `codex sandbox`，使用 Adapter 生成的同一权限映射。容器完全断网，认证内容为固定合成标记，未导入真实凭据。实测：

- 内部命令保持非 root；修改/重命名 input，写入 work/outputs 成功，宿主原输入保持 original。
- 只读配置可读，写入/新增失败；输入目录没有混入该协议配置。
- auth.json 读取与改写失败；符号链接、硬链接、移动父目录以及 `/proc/*/root` 路径均未取出合成内容。宿主读取确认原合成标记没有变化。
- Runner 返回真实退出 0、停止确认和清理完成，输出在清理容器后仍可读取并显式释放。

普通 `npm run check` 明确跳过 7 组 Docker 与 1 组 Codex 用例。CI 默认执行 Docker 用例，未配置专用 Codex 镜像，因此 CI 不覆盖 Codex 内部沙箱；不把 Node 24/26 CI 通过推断成 Linux 主机沙箱兼容证明。

## 尚缺

尚未运行真实模型、订阅登录/刷新、受控外连或 Tutor 批卷；本次网络关闭由外层提供，未单独证明有外部网络时内部工具网络禁用的边界。CODEX_HOME 与秘密仍须通过可信执行绑定接入，测试中的合成 bootstrap 不作为生产绑定实现。下一段继续同一 PR3 接通 endpoint/egress 和秘密生命周期，再执行真实模型与独立文件 contract 验收。

作者自查；未进行其他开发者独立评审。前一次初始化失败已由此处的真实沙箱测试解除，后续联合边界仍开放。
