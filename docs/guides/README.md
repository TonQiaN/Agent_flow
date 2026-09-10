# 使用指南

当前支持确定性 Component 与 JSON contract 基础。前置条件为 Node.js 24 或更新版本及 npm；包均为仓库内部包，尚未发布安装包。

在仓库根目录运行：

```sh
npm ci
npm run check
npm run demo
```

demo 输出单条 JSON，status 为 accepted、outcome 为 completed、output.total 为 6。错误命令返回退出码 2；当前只有 demo 子命令，没有 Workflow 启动、查询或取消入口。

[Component 使用指南](components.md) 说明注册与执行接口、错误和副本语义。[验证记录](../validation/2026-09-09-execution-foundation.md) 区分已运行检查和后续能力。

从 [文档入口](../README.md) 了解当前能力，再查对应决定与说明。维护正式知识使用 [文档维护指南](../development/documentation.md)；原始资料区不要求统一整理方式，不作为日常开发默认上下文。

完整 Agent、文件工作区与批卷流程按版本计划继续实施；本例未调用模型或外部业务服务。
