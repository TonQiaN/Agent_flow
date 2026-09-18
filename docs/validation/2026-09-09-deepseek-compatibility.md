# DeepSeek 配置与原生能力预检

关联 #10/#11 与 [Harness 决定](../../.agents/agent_notes/product/README.md#p-20260909-harness-adapter)。本次为矩阵的中间切片，尚不提供可执行 DeepSeek Adapter、凭据绑定或完整 Runner 组合，不关闭 Issue。

## 对象与参考

先核对 Blackbox Agent Flow 5610d1b / v0.1.22 的已提交 DeepSeek 定义、WebAccessInBuiltImagesTests、Dockerfile、关闭搜索的 patch，以及 c2c224e 原生缓存修复、982bdd7 代理与输出目录修复。其工作区另有未提交修改，未把这些内容当作已发布能力。

使用已有本地镜像 tutor-agentflow-paper-import:v1-deepseek，锁定 ID sha256:a92f35565532db0e3c9ace1454754a0232a35ff413d31ebe3c7a90e7ae78916b；实际 dsh --version 为 0.1.1-rc.2，镜像 Node 为 22.23.2。核对镜像自带 dsh-headless、sandbox-policy、fs-sandbox、llm-deepseek、session-persistence-jsonl 和启动器的公开程序及说明。

## 实现与验证方法

integrations 内部的 deepseek-configuration.ts 生成严格 model/reasoning 映射、固定官方 provider/URL、搜索关闭、委派工具关闭及独立 state 的原生会话配置；配置不含秘密。未导出成公共可执行 Harness，不允许自定义 URL、任意参数或插件透传。沿用 NARB_DISABLE_NATIVE_CACHE=1 和 NODE_USE_ENV_PROXY=1。

src/tests/fixtures/deepseek-tool-server.cjs 仅用于测试：在 network=none、只读镜像、临时目录 noexec 的 Docker 中运行本地合成响应服务，驱动真实 dsh 工具。虚假 API key 与纯合成内容不涉及实际账号、模型、学生材料或外部服务。测试专用 URL 覆盖只存在于 fixture。默认目录对照证明搜索/子 Agent 原本存在；应用配置后确认模型实际收到的工具目录无搜索、fetch、subagent、fork、workflow、ralph，且 read/write/bash 仍存在。

两层参数解析需要两个连续 --。单个终止符曾被外层消耗，--help 开头的整个任务在内层报 unknown option；修正后，真实 user/message 中的 task 与传入文本逐字一致。配置测试还发现将数组 reasoning 转成字符串会错误接受 ['off']；改为先验证字符串，Blackbox 的原始枚举包含判断未采用这种强制转换。

默认持久层使用 zstd，初次只找普通 JSONL 没有找到日志。核对原生包后，显式配置 compression=none、packChunks=false，保留原生事件而不自行发明完成协议；会话仍在私有 state，不能作为业务 outputs 或普通日志公开。

## 真实观测与未满足条件

| 操作 | 实际结果及含义 |
| --- | --- |
| read 输入 | 成功，证明正常工具有执行 |
| write 工作目录 | 成功，宿主侧独立读取内容一致 |
| write 输入副本 / outputs | 原生 FS_SANDBOX_DENIED；即使 patch 的 workspaceRoot 为 /task，真实 session cwd 仍为 /task/work |
| read state 合成私有文件 | 成功；该默认文件策略没有秘密路径读取限制 |
| read /proc/self/environ | 因二进制格式拒绝，不能当作凭据访问控制的证据 |
| Harness 结束 | CLI 退出 0、原生 turn/end.reason.kind=completed，但 outputs 为空；正常终态不能替代文件 contract |
| 原始输入与收尾 | 原始输入不变；Runner 确认退出、停止、清理与完整采集；测试释放临时文件 |

原生会话头记录 version=0、cwd=/task/work、delegationDepth=0；事件序号连续，结尾 turn/end，用户任务保持原样。本切片没有实现可信会话采集/解释或 usage 聚合，不能把读取日志等同于可信接纳。

Blackbox 的旧 disabled 无效注释在当前 rc.2 已不完全适用：实际配置合成保留 disabled，真实目录验证委派工具已移除；搜索仍使用明确 config.search=false/fetch=false。其把 cwd 改成输出目录的修复不满足本项目已确定的固定目录，因此没有迁入；也没有改用 danger-full-access。

后续必须实现并验证可写 input/work/outputs 与秘密、协议/会话目录保护，再接纯 Adapter、API key 绑定、原生终态和实际模型调用。只有这些通过后才能声称 DeepSeek 组合支持完成。本文中的拒写预检是对 stock 策略的诊断基线，后续接入层的验收应另行断言要求的写入成功。

## 运行与审阅

验证命令为 npm run check，同时启用 AGENTFLOW_DOCKER_TESTS、AGENTFLOW_EGRESS_TESTS、已有 Codex/Claude 镜像及 AGENTFLOW_DEEPSEEK_IMAGE。最终完整回归 171 项通过、0 失败、0 跳过（约 104 秒）；新增 2 组配置/参数测试及 1 组真实 CLI 对照与文件策略测试。作者检查；未进行独立评审、远端 CI、真实 DeepSeek 调用或发布。
