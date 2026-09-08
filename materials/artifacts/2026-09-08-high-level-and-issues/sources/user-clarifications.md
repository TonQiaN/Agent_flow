# 用户后续补充（U2）

日期：2026-09-08。来源：本 Codex 对话中对 artifact 的修订要求。

以下保留用户原文；不包含自动附带的浏览器环境信息。

1. 回放历史不深入到container里的agent的运行记录，只录外围的时间，输入输出之类的。
2. container镜像环境的能力和（skill，mcp等）设置为分开，节点里设置任务边界，任务描述等以外也要可以设置这个节点具备的skill等harness有接口的功能。
3. 不同的container在设置时逻辑是有所不同的，当前敲定的三种harness，dsh，codex，claude在项目内管理的代码应当模块化分开 （比如claude用claude.md， codex用agents.md，dsh可能会更多的挖掘插件系统的潜力）。

改进到artifact里。
