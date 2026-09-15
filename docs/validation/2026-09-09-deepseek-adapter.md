# DeepSeek Adapter 与结构化出口

关联 #10/#11 和 [Harness 决定](../../.agents/decisions/product/README.md#p-20260909-harness-adapter)。本切片完成纯 Adapter、具名原始证据接口和原生结构化出口工具；宿主认证/受控联网执行组合、真实 API 调用及学生批卷未完成。

## 参考和实现

先核对 Blackbox Agent Flow 5610d1b / v0.1.22 的 Runner outcome 文件约定、DeepSeek 定义和原生 audit 说明。其通用文件交接没有当前所需的原生结构化选择工具，不能直接搬入本项目。随后核对镜像内 rc.2 的工具注册、输出 schema、presentationMeta、会话 tool/result 与自动标题插件。专用工具沿用原生结果 metadata，无自造会话事件或用户可写的 outcome 路径。

Adapter 复用严格配置、固定启动和任务工具隔离，向宿主声明资产/认证/记录要求；HarnessEvidence 增加可选 records，由宿主提供具名字节，与 capture.files 核对。其他 Adapter 继续使用 stdout。任务描述保持原样，权限、工作路径和配置由实现固定。

自动标题模型插件关闭；主步骤、流式重复数据和辅助调用明确区分。遇到标题模型、压缩或重试记录时，整体用量保持未知。成功选择后有未结工具或后续工具调用，宿主不得接纳该结果；随后仍需原生正常终态及引擎输出契约验收。

## 原生验证与修正

使用既有镜像 sha256:a92f35565532db0e3c9ace1454754a0232a35ff413d31ebe3c7a90e7ae78916b、dsh 0.1.1-rc.2、Node 22.23.2。容器无外网，仅使用合成密钥、图片和本地服务。

初次插件启动失败，诊断表明 defineTool 的输出 schema 是原生 value DSL，required 必须写在属性上。核对原生编译器后改为属性 required=true；没有放宽 schema。

扩展原有隔离用例，22 次工具调用包含无效枚举、额外字段、有效 accepted 选择；真实 CLI 拒绝两个无效调用后可纠正。调用、成功原生 metadata、23 个模型步骤与正常终态经 Runner 采集进入正式 Adapter，得到 completed/accepted；输入 230、输出 46，原始记录字节保持一致，既有输入副本/输出/私有目录/环境/网络断言继续执行。

最初把认证 HTTP 请求数当成推理步数，断言失败。按用户要求先查 Blackbox 的图像和用量路径，再给合成服务增加请求分类：23 个 /chat/completions 请求，另有 21 个 /files 图像上传尝试。当前服务拒绝上传后原生 CLI 回退内联图片；字节与源 PNG 一致。测试确认没有额外辅助模型请求，不再把文件上传计成模型推理。此处没有验证真实上传服务或视觉理解。

两个独立原生用例分别在成功选择后重选、调用 read。重选被原生工具返回 OUTCOME_ALREADY_SELECTED；read 本身可正常执行，但两种记录均被宿主拒绝，outcome=null。完成选择不能绕过宿主接纳边界。

纯测试还覆盖计划/身份/配置/路径注入、出口枚举边界、缺失具名记录及 stdout 字节错配；结构化反例覆盖聊天 JSON、其他工具伪装、schema/值/参数冲突、缺失成功标记、失败纠正、未结工具、取消终态，以及辅助用量未知。

完整 npm run check 启用 Docker、受控联网以及既有 Codex/Claude/DeepSeek 镜像：198 项通过、0 失败、0 跳过，耗时约 104 秒；包括依赖边界、构建、测试类型检查与全部测试。作者验证，无独立评审、远端 CI 或发布。

## 未完成

宿主尚需 API key Codec/Profile、授权网络与执行收尾/脱敏组合。工具、Adapter 与受信测试服务的成功不等于完整 Harness 认证矩阵通过。真实 Tutor 学生卷、答案下载、批改、报告和 PDF 仍是后续验收要求。

后续进展：静态 API key Codec/Profile、脱敏和非独占快照绑定已接通，见 [凭据交接验证](2026-09-09-deepseek-api-key.md)。以上保留本切片当时的范围。
