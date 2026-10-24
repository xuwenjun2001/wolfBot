# 财报研究 Agent 升级：从这里继续

本计划把 wolfbot 的公司研究升级为可交互、可追溯的财报变化研究 Agent，用于展示 AI 应用、Agent 和全栈工程能力。计划建立于 2026-10-18，时间统一使用北京时间。

目标场景：用户选择一家公司、两期财报和研究截至时间，系统解释收入利润、经营现金流及主要风险的变化。用户能查看研究计划、调整关注问题、点击结论核对原文，并在新财报到来后查看结论修订。

本目录保存执行计划与跨会话交接。现有功能说明仍由 [公司研究文档](../../company-research.md) 维护；项目完整文档索引仍在 [docs/README](../../README.md)。

## 新会话先做什么

1. 读 [进度与交接](progress.md)：确认当前步骤、上次结果、下一动作、相关未提交文件及阻塞。
2. 读 [开发规范](development.md) 与 [决策记录](decisions.md)：理解边界和已经选定的路线。
3. 读 [20 步计划](plan.md) 中当前步骤及依赖，不重新制定一套并行计划。
4. 在仓库根运行 `git status --short`、`git rev-parse --short HEAD`；检查本步实际源码、依赖与证据。若记录和源码不一致，先记录差异并修正状态。
5. 在进度文件登记本次负责的步骤、文件范围和下一动作，再开始已获授权的工作。

根目录 [AGENTS.md](../../../AGENTS.md) 提供 Codex 会话入口；[Cursor 规则](../../../.cursor/rules/research-agent-upgrade.mdc) 指向相同资料。跨会话靠这些文件承接，不依赖旧聊天是否可见。

用户只说“继续升级”时，默认完成当前进行中步骤；没有进行中步骤则推进依赖已完成的最小待办步骤。用户明确要求连续多步时按指定范围推进。完成一个步骤通常无需再次询问该步骤内的实现和验证许可。

## 文件各管什么

| 文件 | 唯一职责 |
| --- | --- |
| [plan.md](plan.md) | 固定的 S01—S20、依赖、产物、验收标准与阶段门 |
| [development.md](development.md) | 架构、数据、Agent、界面、测试和协作规范 |
| [progress.md](progress.md) | 当前状态、验收证据、正在修改的文件及最近交接；唯一进度来源 |
| [decisions.md](decisions.md) | 重要技术选择、理由、适用边界与变更历史 |
| [baseline.md](baseline.md) | S01 实现审计及 S03 真实网关失败基线 |
| [evaluation.md](evaluation.md) | S02 固定资料、答案核验状态和评分合同 |
| [human-annotation.md](human-annotation.md) | 人工标注的数据范围、原文核对流程、判定标签与结果保存方式 |
| [human-annotation-worksheet.md](human-annotation-worksheet.md) | 四家公司待审核数值、32 条引文、逐题答案与人工填写模板 |
| [contracts.md](contracts.md) | S04 版本、引用和执行权语义 |
| [s11-s15-validation.md](s11-s15-validation.md) | 双期 Agent/工作台交付、G0 实跑、失败实验与界面验证证据 |
| [reliability.md](reliability.md) | S18 故障矩阵、实际进程中断、观测字段与恢复操作 |
| [evaluation-results.md](evaluation-results.md) | S19 冻结合同、真实配对结果、失败、候选取舍与保留集边界 |
| [delivery.md](delivery.md) | S20 架构、演示脚本、环境恢复与可核对项目描述 |
| [release-failures.md](release-failures.md) | S20 原完整发布门 35 个失败用例、实际报错与原始定位 |
| [review-s16-s20.md](review-s16-s20.md) | S16—S20 Review：证券解析入口、更新截止时间与失败来源重试反例 |
| [agent-upgrade-proposal.md](agent-upgrade-proposal.md) | 面向面试的后续升级草案：执行计划、多 Agent、上下文、人工介入与对照评测；尚未启动开发，不替代原 20 步状态 |

会话历史直接追加在 `progress.md`，避免再维护一份不同步的日志。详细测试原件保存在受控证据目录，进度文件保留脱敏摘要、位置、版本和 hash。

## 首版范围

- 一家公司、两期可比较财报，研究收入利润、经营现金流和风险变化。
- 文本 PDF、扫描 PDF、表格；逐条结论具有可定位的出处和明确时点。
- 可查看和修改的研究计划、渐进显示的结果、刷新/重连恢复和取消。
- 用户主动触发新资料检查，生成报告版本差异；已有报告保持不可变。
- 固定资料评测、真实模型验收与一个 Skill 候选的离线对照实验。

同行比较、通用多 Agent 调度、MCP Apps、全面 A2UI 接入、定时订阅和生产部署进入后续范围。AG-UI 可在首版做事件适配，是否引入 SDK 以 S14 的实际兼容性为准。首版始终复用 PI 和现有研究运行治理。

## 现状与拟新增能力

2026-10-18 静态核对：已有公司识别、财务/公告接口、DeepSeek Search/Fetch、PDF 文本提取、证据台账、Worker 租约、SSE 和取消。当前正文上下文主要选最近 8 份来源，扫描件无 OCR；引用存在性校验不能单独证明结论语义正确。详见 S01 现状审计与 S03 实测记录。

代码入口：`src/lib/company-research/`、`src/app/company-research/`、`src/app/api/company-research/`、`scripts/workers/company-research-worker.ts`。现有研究与主看板生成链路不同；不能把看板 benchmark 结果直接当作新研究链路的成绩。

## 可复制的新会话指令

```text
继续 wolfbot 财报研究 Agent 的 20 步升级。
先读取 AGENTS.md 和 docs/plans/research-agent-upgrade/README.md，
以 progress.md 为当前进度，核对实际源码与已有改动后承接下一步。
完成本步实现与相关验证，更新状态、证据、决策和交接记录。
```

如果只希望查看进展，可改为“读取上述文件，汇报当前完成情况和下一步，不修改代码”。

## 换目录、分支或电脑

新会话需要能访问同一工作区，或已经带上这些文件及对应源码的 checkout。未提交/未跟踪文件不会自动出现在新 worktree 或远端仓库；切换前记录并保留所需文件。不要用一次 `git add .` 把所有本地工作混在一起。

私有样本、隐藏题和大证据不随文档提交。它们需要通过清单中的授权位置恢复并核对 hash。资料缺失时明确标记不可复验；不能用聊天中的“之前通过”补齐证据。
