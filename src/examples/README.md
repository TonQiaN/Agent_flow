# 示例

当前可运行示例为 CLI 中的 `agentflow demo`：数字数组通过输入 contract，确定性 Transform 返回总和，输出经对应 outcome contract 校验。根目录运行 `npm run demo`。

Docker 脚本示例位于 docker-script.mjs：构建后执行 `node src/examples/docker-script.mjs`，需要 Docker 与本地 alpine:3 镜像；示例创建合成文件并验证原件未被容器改写。

真实 Workflow 和批卷业务尚未接入。后续在这里增加不含学生资料、凭据和模型原始响应的合成示例；消费者业务定义留在消费者项目。
