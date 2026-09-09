# Workflow 编译与串行控制验证

2026-09-09，基于已验证首个 Harness 提交 961e77a，在独立工作区实施 Issue #9 的后续切片。主责 @xiaoxuanli-a；Codex 实现与作者自查，未进行独立多人评审。未新增第四个远端 PR，也未合并前三层。

## 本次实现

engine/workflow 分开保存类型、编译器、串行运行控制和 JSON 函数适配。编译器通过显式 catalog 解析 Component 与单节点执行端口，运行控制不导入环境模块。JSON 与 files 契约类别参与连线比较；当前实际支持端口是既有 JSON gate/transform 函数。

实现用户定义的 from/outcome 路由、命名终点、每条路线的可选次数上限和耗尽目的地、全局 maxSteps，提供 start/query/cancel。每次重入节点分配新 NodeTask 和首个 Attempt，不自动重试。私有编译计划登记及公开副本阻止反序列化对象冒充已编译计划。失败不沿业务路由推进；取消等待执行端口的停止证据，无法证实时保留失败位置。

## 验证结果

新增 12 组测试通过：

- 编译前拒绝引用、路由、起终点、契约、可达性、未知字段和上限错误，并报告定义路径；支持范围前置检查。
- 同名不同类别契约不连线；原定义、公开 definition 和事后替换的 catalog 方法不能改变已编译运行；伪造计划和重复 Run ID 拒绝。
- 多 Run 的返修计数独立、每次重入身份不同；0/1/2 次返修、指定耗尽终点或升级节点、全局步数均保留最后已接纳结果和原 outcome。
- 函数异常、非法 outcome、输入/输出违约、伪造执行身份或仅声称 accepted 不得推进后继。
- 启动前取消无执行；执行中取消保持 cancelling，函数返回后停止后继；stopped=false 或端口未知异常不能标为取消完成，保留节点/Attempt；不公开任意异常文本。
- 输入、查询、完成结果及业务函数保留的对象互不写穿。

`src/examples/workflow.mjs` 的返修上限 0、1、2 三次实际运行通过自检。0/1 以 exhausted/rejected 结束，最后节点仍是 revise；2 经过五步后正常 accepted，宿主原输入保持 revision=0。这是确定性 revision 示例，不是 Tutor 批卷或真实 Agent 端到端。

第一次普通 `npm run check` 在宿主受限环境中，既有代理套接字测试遭到 127.0.0.1 listen EPERM；不是 Workflow 断言失败。确认固定合成数据和网络目标后，在允许环境操作的执行方式下运行：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=<已核对的实际镜像> npm run check
```

**104 项通过、0 失败、0 跳过**。包含边界检查、构建、测试类型检查、全部既有 Docker/代理/凭据合成测试及实际 Codex 离线沙箱和启动验证；未使用真实凭据或调用模型。唯一公网 HTTP 载荷为原有代理测试的无认证固定 HEAD 请求。当前提交还未作为新 PR 推送，不能借用 PR19 的 CI 结果声称本切片已通过 CI。

## 尚缺与后继

真实 Agent/文件/脚本的 Workflow 适配、文件前序收据的统一可信交接、模拟 Effect 授权/幂等与 Tutor 合成闭环继续在同一 Workflow 工作项实施。files 类别只是编译边界，当前没有可用文件执行适配；运行记录与计划只在内存中。没有持久恢复、共享调度、自动重试或并行，也不承诺强制终止同步 TypeScript 函数。

参考 Blackbox 5610d1b 的 compiler、runtime、effects：复用引用/契约/路由检查、取消/步数和 Effect 分离的取舍，不搬迁旧运行时的文件系统/存储/egress 耦合。本次先修订 [组件决定](../../.agents/decisions/product/README.md#p-20260909-component-execution) 再实现，Issue #9 已登记切片预检。

[Workflow 使用指南](../guides/workflow.md) · [首个 Harness 验证](2026-09-09-codex-startup.md)
