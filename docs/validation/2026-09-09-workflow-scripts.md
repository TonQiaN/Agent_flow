# 确定性脚本 Workflow 验证

2026-09-09，基于本地文件 Workflow 提交 0b13a5e，继续 Issue #9。主责 @xiaoxuanli-a；Codex 实施与作者自查，未进行独立多人评审。未创建分支、第四个远端 PR 或合并前三层。

## 实现与参考

先查看 Blackbox 5610d1b 的 CommandRunner/DockerRunner、OutputCollector 及对应测试入口：执行与结果校验分离，结果严格检查 schema/outcome、大小和未知字段。按用户已确认的直接 outcome 设计，这里改用一份 stdout JSON，不沿用 Blackbox 的 result.json 及 artifacts 清单。文件产物继续由既有 outputs 自动收集。

新增 engine 的 ScriptExecutor/ScriptAttempt 和纯结果协议校验；新增 integrations 的 FileScriptRecordReader；FileWorkflowCatalog 通过 registerScript 接入同一文件来源链、契约和清理路径。脚本定义限 argv/timeoutMs，出口来自 Component。核心不引入 Node 文件系统或 Docker 依赖。

## 实际验证

新增 9 组测试：

- 协议接受声明的正常/拒绝 outcome，拒绝未知字段、重复字段、未知出口、多对象、stdout 日志、BOM 和超限内容。
- 预检无分配/执行副作用；错误配置和未支持环境字段拒绝。运行请求在异步等待期间修改不改变原执行；重复 Attempt 拒绝。
- 非零退出、取消、超时、截断/不完整采集、字节数不一致、无效协议、清理失败不能接纳；停止不明确时拒绝释放，恢复只清理、不升级结果。
- 实际本机原始读取核对大小/上限/UTF-8，拒绝符号链接、硬链接和无效字节。
- 真实 Alpine Docker 脚本在固定工作目录修改独立 input，输出交给文件 Gate，最终文件 revision=1、原文件字节仍为 revision=0。两步前序链连续，记录真实镜像 ID；释放后 Docker 临时工作区、节点目录和快照存储为空。
- 真实脚本的 stdout 日志、未知 outcome、无效 UTF-8、非零退出、缺失契约文件及超大结果均失败，没有发布最后接纳结果。
- 真实执行启动后取消，等待停止后返回 cancelled，后继函数调用数为 0；超时返回失败。失败资源可显式清理，全部已分配 Docker 资源由 fixture 自身核对和回收。

执行完整回归：

```sh
AGENTFLOW_DOCKER_TESTS=1 AGENTFLOW_EGRESS_TESTS=1 AGENTFLOW_CODEX_IMAGE=agentflow/harness-codex-chatgpt:55517b18fd19 npm run check
```

**125 项通过，0 失败，0 跳过**。包括依赖边界、构建、测试类型检查、既有全部 Docker/受控 egress/合成凭据与离线 Codex 探针，以及本次真实脚本 Workflow。没有读取真实凭据、调用真实模型或使用学生资料。该本地验证不能替代尚未创建的 Workflow PR 的 CI。

## 剩余范围

ScriptExecutor 的协议成功与文件契约接纳分开，使用者需要通过文件 Workflow 或自行完成契约校验，才能判定完整业务节点成功。stdout 专用于协议，脚本日志需要写 stderr。记录读取依赖受信 backend 给出的停止后原始路径及宿主控制的祖先目录。

模拟 Effect 的授权/幂等、Tutor 合成闭环、实际 Workflow 消费端验收和 CLI 定义加载仍在同一工作项继续。持久化、队列、重试、并行与其余 Harness 组合仍按后续 Issue 推进。当前代码在独立本地工作区，三个已有远端 PR 保持原 head/base。

[脚本使用指南](../guides/workflow-scripts.md) · [文件交接验证](2026-09-09-workflow-files.md)
