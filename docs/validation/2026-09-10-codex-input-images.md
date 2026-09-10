# Codex 初始图片执行验证

2026-09-10（悉尼），基线 e934cf4；关联 #10 和既有最终扫描件验收。主责 @xiaoxuanli-a，Codex 实现和作者自查，尚未独立评审或远端发布。

## 依据与实施

先检查 Tutor marking/toolchain 的 codex-vision-entrypoint.sh、prepare_initial_images.py 以及 Blackbox Codex Harness 定义。旧消费者以初始图片避免依赖模型主动发现图片工具；本次在纯 Adapter 内增加显式相对路径配置，附件准备仍复用消费端工具。工作目录及来源保护沿用本项目约定。

无网络、无凭据挂载运行已安装 Codex 0.153.4 镜像的 `exec --help`，确认 `--image <FILE>...` 是初始图片参数。Agent Driver 在凭据 Runner 之前检查当前 manifest 的文件、媒体类型、单张及总大小；未增加任意 argv/env 或宿主路径入口。

## 验证

11 项本地测试通过：既有计划、终态、脱敏和多出口行为；图片顺序/路径映射；拒绝绝对路径、遍历、逗号、重复、未知扩展名、空洞数组、超额张数；缺失/非图片/无效大小/超额总大小不会进入凭据 Runner。初次测试类型检查指出测试用 manifest 缺字段，已补齐真实接口字段后通过。

既有 Docker 组合测试通过，7.67 秒：合成 CLI 与凭据验证版本、锁定、模拟刷新、脱敏、固定目录、单双出口产物交接和清理。此项不调用真实模型。构建、测试类型检查与包边界通过。

## 真实运行

首轮使用 Codex 0.153.4 / gpt-5.6-sol、low 推理和原定每节点 180 秒预算，真实 Marker 已读取附图，并描述了图中的导数答案；随后在未知 ID 约定上反复搜索和试算，180 秒超时。没有正常 Harness 终态、没有接纳候选、未调用 Reviewer/Reporter。Runner 确认停止并移除容器，输入和凭据占用已释放；没有把部分输出当作完成。

排查先回到 Tutor 的 marking/agents/marker.md 与 trusted/validation.py，确认消费端简化提示漏掉了 question:<path> / part:<path> 的 UUIDv5 规则。已补入准确的标识、官方来源、源资产和哈希规则，并限制无关 schema 遍历；没有预填候选、期望分数、修改评分 Gate 或提高超时预算。第二轮产出了全部三份候选，但模型用已弃用的 jsonschema RefResolver 自检时出现跨 schema 引用作用域错误，随后仍在 180 秒预算到期前没有正常终态。离线用 Tutor 实际 ContractRegistry 与业务 validator 检查保存的输出，结果 passed；这仅证明草稿有效，不构成 Agent 接纳，也没有补造收据。

参考旧 Reviewer-Fixer 的“复制现有候选再修正”做法，示例增加显式选择已释放合成运行草稿的入口。新 Marker 从原始来源及未接纳草稿出发，仍经过完整正常执行、Candidate Gate、独立 Reviewer 与 Final Gate；没有绕过失败终态。第三轮 Marker 正常完成（118.40 秒），Candidate Gate 通过，进入新的独立 Reviewer。Reviewer 完成了语义检查并写出复核文件，但重复 schema 校验时又使用旧 RefResolver，并在终态前超时。其复核文件离线通过原 Final Gate 的业务/哈希检查；正式流程仍失败，Reporter 未执行。离线验证没有 TypeScript 私有前驱收据，不计为正式 Final Gate 接纳。

进一步将 Reviewer 的任务说明限定为对照原始材料的语义复核与输出收据绑定，明确使用已通过 Candidate Gate 的确定性结构/算术证据，避免重新实现 host validator；必要的局部 schema 检查统一使用 referencing.Registry。主负责用户要求的独立复核、阈值和最终 Gate 均保持。第四轮完整通过：Marker 125.65 秒、Reviewer 91.74 秒、Reporter 126.23 秒，均在原 180 秒预算内正常终态、进程退出 0，三个执行句柄释放，Runner 资源移除。批改 5 节点和报告 4 节点全部接纳：intake → Marker → Candidate Gate → Reviewer → Final Gate；prepare → Reporter → Report Gate → render。Reviewer 给出 ACCEPT、7 项 PASS 与质量自评分 1；实际 Final Gate 核对全部绑定，报告 Gate 再核对可信指标。自评分不等于外部质量标定。

这是从第二轮真实未接纳草稿出发的新运行；首轮空白生成路径尚未在 180 秒内完成，不宣称已经验证冷启动一次成功。原草稿与 125 个来源文件保持一致，最终评分为 2/2；候选不是合成 Driver 或宿主预填。全部实际 Agent 使用 Codex 0.153.4 / gpt-5.6-sol，两个阅卷角色有一张初始图片，Reporter 只消费冻结指标。

生成的 PDF 为 271,746 字节、3 页横向 A3，SHA-256 `d86e6a39159634c56477c6fe5bc4d03e89b6a4373ea39f25f5f3aaeefd4a3684`。3 页均转为 1600 px PNG 逐页检查：封面 2/2 与合成范围说明、原答卷及反馈栏、分析文字可读，无重叠、裁切或缺字。满分案例没有扣分标注或练习链接，不覆盖这些情形。运行结束 attempts、两条 Workflow 的 artifacts/nodes 均无残留文件；私有导出与原始证据按调用方要求保留。来源证明、流程、角色事实、报告 Gate 和 PDF 摘要一起保留在本次本地验收目录。

当前完整真实模型证据仍只有一题、合成扫描页和草稿接续；真实学生、多页手写、扣分/返修的评分质量以及远端 PR 交付仍未完成。

自动审批曾因可能包含学生私有数据拒绝草稿重跑。离线独立重生成夹具，确认 122 个输入中 121 个字节一致，唯一差别是随机 operation_id；契约文件与安装的 schema 一致，无学生上传或数据库内容。提供这一来源证据后，同一命令获准执行。

结构和接线测试不能代替真实模型复杂契约交付或学生评分质量。私有执行证据仅保留在本地验收目录，仓库不收录原始事件或凭据。

[使用指南](../guides/codex-input-images.md) · [Harness 决策](../../.agents/decisions/product/README.md#p-20260909-harness-adapter)
