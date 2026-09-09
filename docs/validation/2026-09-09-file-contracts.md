# 文件契约、快照与交接验证

2026-09-09，Draft PR #19 在 47144cc 后实现 #9 的独立文件切片。macOS arm64 / Node 26.0.0，基线已有真实 Docker/Codex 小任务验收。主责 @xiaoxuanli-a，Codex 实现及作者自查，未进行独立多人评审。

## 结果

完整 `npm run check` 启用 Docker、受控联网及既有 Codex 0.153.4 镜像：**84 通过、0 失败、0 跳过**。后续仅将 FileManifest/ArtifactStore 类型移到 engine 的可替换接口边界，再次通过构建、测试类型检查和依赖检查；没有改变运行行为。随后自查将规则归属改为路径/父目录索引，避免文件与根目录的两两扫描；构建、类型检查及全部 10 组文件契约/存储回归再次通过。默认 CI 未提供专用镜像及外网环境时仍明确跳过原有 5 项环境测试。

新增 5 组纯契约测试：规则与 JSON 引用前置拒绝、定义副本；必需/可选与数量/大小/总量/类型/JSON 规则；目录树及结构性父目录；*、?、** 路径匹配、歧义与未归属内容；非法路径、重复及缺失父目录。

新增 5 组真实本机文件测试：自动收集并独立交付两个可写副本，源修改和返回 manifest 修改不影响快照；非法内容不发布快照；符号链接、硬链接、源目录链接和 FIFO 拒绝；交接时摘要或链接损坏拒绝、清理半成品且保留已有目录；PDF/PNG/JPEG 签名与不符文件类型拒绝。全局资源上限属于显式实现边界，不声称穷尽所有大文件规模和同权限宿主攻击场景。

## 真实模型接入

更新 `src/examples/codex-subscription.mjs`，在 Runner/Harness 成功后调用公共 FileArtifactStore 自动捕获 outputs，以 JSON 文件契约接纳，复制到独立 accepted 目录，再释放私有快照。Agent 仍只写 answer.json，没有文件清单协议。

使用已有明确授权的专用凭据、同两个官方域名和条件刷新同步，运行 Codex 0.153.4 / gpt-5.6-sol。实际 Runner 退出 0，Harness completed，无诊断；收集、sum=6 Schema 验证和独立副本交付通过，原件不变、容器输入副本修改，租约、容器和工作区释放。accepted/answer.json 的 SHA-256 为 bf36dad286f560eec09aa880450f26dc03cc401e35c35299a2805058b5af6c8a。刷新为 unchanged，未覆盖真实 OAuth 续期。原始证据与凭据均只留本机私有区。

## 参考与边界

先查 Blackbox 5610d1b 对应 artifact_contracts.py、artifacts.py、collector.py：参考目录树约束、复制前后文件事实、SHA-256 与交接重验；不迁移旧 result.json/artifacts 清单。新契约纯函数、存储接口及 POSIX 适配分离，未引入 Python 运行依赖。

本次不完成可信前序执行记录、Component Agent 接纳协调、Workflow 路由、持久恢复、其他 Harness、多出口真实任务或 Tutor 批卷。调用方仍必须证明生产者停止并控制目录祖先和并发写者；快照 API 不替代 Runner/Harness 终态。PR 继续 Draft，Issue #9 保持部分交付。

[文件契约指南](../guides/file-contracts.md) · [组件决定](../../.agents/decisions/product/README.md#p-20260909-component-execution)
