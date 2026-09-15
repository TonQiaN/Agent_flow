# 实际 Workflow 结构与契约快照验证

2026-09-10（悉尼）；主负责开发者 @xiaoxuanli-a，Codex 实现和作者自查。延续 [Issue #13](https://github.com/TonQiaN/Agent_flow/issues/13) 已确认的定义一致性边界和用户常规实现授权，未新增独立审阅或远端发布。

## 预检

基线 56677ad 已具备 SQLite/CAS 和耐久归档，但 ContractRegistry 只保留验证器，Workflow 连线只比较 contract 类型与 ID。不同 catalog 可以注册同名不同 schema，旧代码没有可持久保存的实际定义证据。先检查 Blackbox v0.1.22 / 5610d1b 的 execution_plans.py：角色配置在执行前统一解析并保存，避免恢复时隐式重新选择。同时核对 78d53c5 修订与 test_execution_profiles.py：修改已冻结 Profile 的 reasoning_effort 后，恢复返回 EXECUTION_PROFILE_CHANGED。参考统一解析、摘要核对及变化拒绝边界；未重新执行旧 Python 测试。

本轮把实际 schema 和结构冻结在已编译计划，增加明确的结构导出与匹配 API。JSON 注册定义留独立副本；既有各类 Catalog 提供实际契约描述。执行绑定与环境是另一个尚未落实的证据面，不把结构快照扩大解释为完整恢复设计。

## 定向检查

19 项通过：7 项新增结构检查和 12 项既有 Workflow 编译/运行检查（约 0.6 秒）。

- 实际 JSON schema、boolean schema 和返回副本独立；失败注册不留下可导出的定义。
- 编译后改变原始 Workflow 或替换 catalog 描述方法，不改变计划快照；伪造计划被拒绝。
- 快照写入 SQLite、关闭后重开，再以重新注册/编译的相同定义核对成功；JSON 对象键顺序不影响结果。
- 相同 ID 的 schema 约束变化、Workflow 步数变化、Component 实现标识变化、未知版本和额外字段均拒绝匹配；getter 不执行。
- 不同 Catalog 使用同名不同 schema 时拒绝导出一致性证据。
- 旧 executor 仍能编译，但缺少定义时快照导出拒绝；错误 ID、外部 schema 引用及额外字段拒绝。
- 实际 FileWorkflowCatalog 与 FileJsonWorkflowCatalog 纳入文件契约及其 JSON schema；未使用注册项不进入快照，嵌套同名定义冲突和额外夹带 schema 拒绝。

首次构建发现 TypeScript 对局部 never 箭头函数的控制流收窄未生效，改为明确的函数声明后类型检查通过。此编译问题不涉及 Blackbox 的 Python 运行逻辑，也不是产品恢复失败。

完整 `npm run check` 已通过：303 项通过、0 失败、0 跳过，163.4 秒；包含构建、测试类型检查、依赖边界、Docker 与受控网络、三种固定原生 CLI 镜像。使用合成端点与材料，没有真实官方模型调用。本地 Node 26；本轮未运行 Node 24 远端 CI。修改文档的 115 个本地链接目标存在，`git diff --check` 通过。

## 尚未验收

当前检查没有真实模型调用、学生材料或凭据。结构匹配只是恢复前置证据之一；函数代码与部署身份、Agent 提示/配置、Runner 镜像与资源、认证引用、Attempt 历史、节点结果接纳与后继创建、取消及 Effect unknown 的恢复仍需继续接入。

普通 Workflow 执行尚未自动调用结构导出，文件接纳仍使用临时 Catalog 引用。#13 的 A 已完成不重跑、旧 B 停止后恢复场景仍未通过，本轮不能宣称完整持久化已完成。此前原生 Harness 的偶发测试问题继续以已有诊断记录为准。
