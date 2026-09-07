# 架构

状态：已建立文档管理目录、生命周期分类、短决策模板与共同操作流程；产品架构尚未定案，也尚无运行实现。

文档架构依据 [分层决定](../../.agents/decisions/development/README.md#d-20260907-documentation-layers)；具体位置见 [结构图](../reference/repository-map.md)。

产品层仍需回答：

- 节点、工作区、工作流及嵌套调用的边界。
- 输入输出契约和跨边界数据传递。
- Harness 接口、能力差异与审计信息。
- 容器隔离、插件挂载及资源调度职责。
- 运行记录、轨迹回放与前端关联。

启动会议的 [产品方向候选](../../.agents/decisions/product/README.md#p-20260905-initial-direction)仍待按问题细化。本轮不预设产品技术模块或服务划分。
