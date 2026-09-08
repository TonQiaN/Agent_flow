# 执行基础验证

日期：2026-09-09。对象：#9 的基础切片，分支 codex/execution-foundation，相对 main f28540c6bc3cda2f422fc10a1bca27b0df9e36ba。主责 xiaoxuanli-a；Codex 实现、测试及自查，未进行独立多人审阅。

环境：macOS，Node 26.0.0、npm 11.12.1、TypeScript 5.9.3；依赖由 package-lock.json 固定。执行 npm install 后 npm run check，依赖边界、源码构建、测试类型检查及 16 项测试全部通过，无跳过。自查补入末尾换行 ID 反例后重新运行同一检查。CLI 测试启动编译后的真实 Node 进程，不以只导入函数替代入口验证。

| 范围 | 证据 |
| --- | --- |
| 身份 | 缺失/非法 ID，0、负数、小数、非安全整数 Attempt 序号；异步调用前身份快照 |
| 契约 | 严格字段与 format、无类型转换/默认值/字段删除；坏 schema、异步/外部引用和未解析片段被拒绝；本地片段有效 |
| 注册边界 | 重复定义/实现/contract、缺失引用、空 outcome；定义与 schema 不受调用方后续修改影响 |
| 完成与失败 | 合法 rejected 接纳；异常、畸形结果、未声明 outcome、对应输出 contract 违约分别失败；输入失败不调用实现 |
| 副本 | 两个并发调用修改独立输入；实现事后改变返回对象不修改已接纳结果；两个结果互不串改 |
| 非 JSON | NaN、undefined、稀疏数组、循环、Date、Map、getter、隐藏/Symbol 属性拒绝；getter 不执行；普通共享子对象可复制 |
| 诊断 | 不回显输入值或任意异常文本；字段位置与校验规则保留 |
| 架构 | 静态 import/export/type/dynamic import 采集；跨包相对路径、内部子路径、反向依赖、未声明包及 Node 环境导入反例 |
| CLI | demo 接纳并输出 total=6；未知命令退出 2 |

CI 已配置 Linux Node 24/26 的 npm ci 与 npm run check；本地结果不代表远端 CI 已通过，具体 PR head 的远端结果在 PR 检查中核对。

限制：这是可信进程内 JSON 函数执行，未实现文件 contract、Docker、Agent、Workflow 路由、Effect、取消/超时、持久化、队列、重试或并行；输入内存复制不证明文件或安全沙箱隔离。没有运行 Tutor 真实学生资料或模型，16 项测试不能替代 #9 全部验收。后续继续合成批卷 fixture、历史候选回放及真实隔离批卷。

关联：[执行决定](../../.agents/decisions/product/README.md#p-20260909-component-execution)、[目录与构建决定](../../.agents/decisions/development/README.md#d-20260909-source-layout)、[0.1.1 计划](../roadmap/0.1.1.md)。
