# DeepSeek 文件取消的进程树收尾

2026-09-10（悉尼）；主负责开发者 @xiaoxuanli-a，Codex 排查与作者自查。关联 Harness / Runner 的已确认隔离与停止边界；没有真实凭据、官方模型调用或远端发布。

## 先查 Blackbox 与本次证据

按用户要求先核对 Blackbox v0.1.22 / 5610d1b 的 runners.py、agent_container.py、provider_adapters.py、test_docker_integration.py 及对应历史。旧容器关闭 stdin、死亡后清理与特定断网启动判据可参考，但没有找到本项目自有文件服务队列的同类修复。没有将旧启动测试的宽限规则搬到必须完成全部工具调用的验收。

承接[之前的诊断](2026-09-09-deepseek-timeout-diagnostics.md)，本次串行端到端回归再次出现文件 seam 的 90 秒超时。日志定位到最后一个 readText：操作序号 101 开始，102 创建 PID 264，103 对它发送 SIGKILL，104 已观察到该进程以 SIGKILL 退出；随后没有 close 或操作结束。30 秒后服务再杀同一个 PID，返回 false；最后由 Runner 总期限终止容器并确认移除。完整检查中普通组 225/225 通过，端到端组 81/82 通过，保留此次失败，不能按其余通过宣称整体成功。

这里确认的是“launcher exit 后 stdio 未关闭，而服务只杀 launcher”的取消收尾缺口；并未从现有日志证明原始 bwrap 后代的每个身份或具体调度次序。Node 官方文档说明，exit 可以早于 stdio 关闭，close 等待 stdio 收尾；在 Linux 上杀父进程也不会自动杀掉全部后代。[Node child_process 文档](https://nodejs.org/api/child_process.html)

## 修复与确定性反例

文件服务的 spawn 创建专属 session / process group，固定 bwrap 文件 worker 不再另开 session。取消、服务关闭、超时或传输超限对本次专属组发送 SIGKILL，并继续等待 close 后才完成请求和放行下一请求；没有提前关闭管道或把 exit 当成收尾成功。Bash/grep/glob 的共享隔离参数没有改变，外层容器仍由 Runner 清理。此处只运行受信的固定文件 worker，不提供用户任意进程程序。

新增测试专用故障注入：真实容器中的文件服务将一次 spawn 替换为明确持有继承管道的父子进程，等后代启动标记后取消。旧生产代码在 10 秒测试期限内失败：只有 pipe_holder_ready、parent_exited，没有 pipes_closed；Runner 停止确认并移除容器。这个预期失败不计为通过，也不声称故障替身就是原始 bwrap 的全部内部结构。

修复后同一用例要求 FS_ABORTED、close 已发生、原 PID 和整个专属进程组均不存在，再结束工具空间。既有真实 bwrap seam 同时检查即时取消、取消后下一请求、只读策略、版本冲突、字节上限及环境/文件隔离；原生 CLI 文件读写也一并验证。三项定向检查全部通过，约 26.2 秒；原有文件验收的 90 秒期限没有放宽。

## 验证边界

完整最终回归结果在[本轮验证记录](2026-09-10-script-execution-binding.md)中登记。另一次完整命令误在受限宿主沙箱启动，明确报本地端口 listen EPERM 和 Docker socket permission denied；该结果不作为产品回归通过或新产品故障，已保留输出，改在获授权的本地 Docker 环境执行同一命令。

本修复关闭已复现的文件服务取消收尾缺口。此前原生 Bash/grep/glob 长工具序列的另一项总期限失败没有相同的 exit/close 证据，仍不能归到同一根因。真实官方矩阵、学生批卷、报告/PDF 和节点持久化恢复继续分别验收。
