# Codex 初始图片附件

Codex Adapter 的调用配置可提供 `inputImages`，值为输入快照内的相对路径数组。例如：

```ts
const config = {
  model: 'your-authorized-model', reasoning: 'low', subagents: false, search: false,
  inputImages: ['source/prompt-images/page-0001.jpg'],
};
```

Adapter 保留数组顺序，将每项映射为 `/task/input/<path>` 下的 `--image` 参数。工作、输出路径不变；prompt 仍由用户提供。Adapter 不读文件、不缩放图像。

最多 64 项，只接受 PNG/JPEG/WebP 扩展名和安全 ASCII 相对路径；重复、绝对路径、遍历、逗号、反斜杠及控制字符被拒绝。CodexAgentDriver 在进入凭据 Runner 前检查附件属于当前输入 manifest、媒体类型为图片、每张不超过 20 MiB、总计不超过 64 MiB。物化仍由 ArtifactStore 核对真实文件摘要和链接安全。

图片必须在任务开始前准备好。Tutor 的显式合成真实调用入口 `src/examples/tutor-marking/real.ts` 复用已安装 Tutor 的 prepare_initial_images，把规范化扫描页缩放为初始 JPEG；该工具只属于消费端。初始附图与原始来源一起捕获，Marker/Reviewer 可以直接看图，评分和报告 Gate 不依赖模型自述“我看到了图片”。

真实入口沿用 [既有真实调用配置](tutor-grading-codex.md)，另需 `TUTOR_WORKSPACE` 和 `TUTOR_PYTHON`。执行 `node --import tsx src/examples/tutor-marking/real.ts`，最多三个 Agent 节点，每个 180 秒。该入口只生成明确标注的合成试卷、参考答案和扫描页，没有自动发现学生材料；真实 Driver 与合成 Driver 分开。保留每次结果及失败证据，任何 Gate 不通过就终止后续链路。

若先前合成运行只执行了 Marker、已确认释放并留下三份草稿，可显式设置 `AGENTFLOW_SCANNED_DRAFT_RUN=scanned-codex-XXXXXX`，从同一 acceptance root 下该运行的原输入和真实草稿开始新的执行。草稿以 `source/prior-candidate` 作为普通输入，原件保持不变；新的 Marker 仍需检查并交付 outputs，经正常 Harness 终态、Candidate Gate、独立 Reviewer 和 Final Gate。它不恢复 CLI 会话，不接纳超时结果，不自动挑选历史运行，也没有自动增加重试次数。该示例只支持一次草稿接续，未提供可持久恢复的通用草稿管理。

本配置不放宽网络或凭据权限，也不声明其他 Harness 已支持初始图片。实际运行结果见 [验证记录](../validation/2026-09-10-codex-input-images.md)。
