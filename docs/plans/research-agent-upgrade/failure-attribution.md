# U01 历史轨迹失败归因

无：现有轨迹不支持把失败归因于上下文争用。这是证据充分性结论，不证明上下文争用从未发生。工具切换、重读和重复调用不能单独证明上下文丢失；compact 没有事件时不可观测。

共 18 个实际任务，completed 9，partial/failed/unknown 9；54 个问题中 18 个未完成。漏失或不完整轨迹 0。这批任务跨版本、提示词和修复阶段，仅作历史诊断。

各工具调用：check_coverage=19，read_evidence=152，record_claim=94，record_fact=174，search_evidence=117，submit_report=18，verify_claim=52。总计 626，失败调用 82。相同 query 重复 5，高度相似 query 重复 6；成功检索/读取中无新定位内容 75/269（27.88%）。

跨问题切换 141，返回原问题后重复读取 11。相同 claim 输入重复保存 17，同 claimHash 重复核验 6；它们说明调用分配可优化，不直接证明质量收益。18/18 任务的 compact 次数不可观测；8 个任务额度到顶且仍有未完成问题。

| 任务 | 资料 | 状态 | 观察/账本工具 | 问题调用分布 | 同/相似 query | 无新证据/成功检索读取 | 切换/返回重读 | 到顶未完成 | 失败问题归类 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | dev-000333 | partial | 40/40 | cash_flow+income_profit=8；income_profit=29；cash_flow=1；global=2 | 0/0 | 6/9 | 2/0 | 是 | cash_flow:budget_exhausted；income_profit:tool_error；risks:budget_exhausted |
| T02 | dev-000858 | partial | 40/40 | cash_flow+income_profit=1；income_profit=37；global=2 | 0/0 | 7/10 | 0/0 | 是 | cash_flow:budget_exhausted；income_profit:tool_error；risks:budget_exhausted |
| T03 | dev-600309 | partial | 40/40 | cash_flow+income_profit=3；income_profit=6；cash_flow=16；cash_flow+risks=1；risks=11；unassigned=1；global=2 | 1/0 | 5/17 | 17/3 | 是 | cash_flow:retrieval_miss；risks:verification_pending |
| T04 | dev-600519 | completed | 31/31 | cash_flow+income_profit=6；income_profit=7；cash_flow=11；risks=5；global=2 | 0/0 | 3/12 | 6/0 | 否 | — |
| T05 | dev-000333 | completed | 39/39 | cash_flow+income_profit=4；income_profit=8；cash_flow=9；cash_flow+risks=4；unassigned=5；risks=7；global=2 | 0/0 | 8/20 | 7/1 | 否 | — |
| T06 | dev-000858 | completed | 39/39 | cash_flow+income_profit=4；income_profit=9；cash_flow=18；cash_flow+risks=1；risks=5；global=2 | 0/0 | 4/19 | 11/1 | 否 | — |
| T07 | dev-600309 | partial | 40/40 | cash_flow+income_profit=3；income_profit=7；cash_flow=15；unassigned=1；risks=12；global=2 | 1/0 | 7/18 | 14/4 | 是 | cash_flow:retrieval_miss |
| T08 | dev-600519 | completed | 28/28 | cash_flow+income_profit=3；income_profit=8；cash_flow=10；risks=5；global=2 | 0/0 | 1/10 | 6/0 | 否 | — |
| T09 | dev-000333 | completed | 25/25 | cash_flow+income_profit=3；income_profit=6；cash_flow=8；risks=5；unassigned=1；global=2 | 0/0 | 0/11 | 6/0 | 否 | — |
| T10 | dev-000858 | partial | 39/39 | cash_flow+income_profit=3；income_profit=6；cash_flow=17；unassigned=3；cash_flow+risks=2；risks=5；global=3 | 0/0 | 7/23 | 9/0 | 否 | cash_flow:retrieval_miss |
| T11 | dev-600309 | partial | 40/40 | cash_flow+income_profit=5；income_profit=6；cash_flow=11；unassigned=2；risks=14；global=2 | 0/1 | 5/21 | 10/2 | 是 | cash_flow:retrieval_miss；risks:verification_pending |
| T12 | dev-600519 | completed | 23/23 | cash_flow+income_profit=3；income_profit=6；cash_flow=7；risks=5；global=2 | 0/0 | 0/9 | 6/0 | 否 | — |
| T13 | 历史保留 | partial | 40/40 | cash_flow+income_profit=6；income_profit=4；unassigned=16；cash_flow+income_profit+risks=6；cash_flow=3；cash_flow+risks=1；risks=2；global=2 | 3/4 | 15/32 | 7/0 | 是 | cash_flow:retrieval_miss；income_profit:retrieval_miss；risks:retrieval_miss |
| T14 | 历史保留 | completed | 26/26 | cash_flow+income_profit=3；income_profit=6；cash_flow=9；risks=6；global=2 | 0/0 | 0/9 | 6/0 | 否 | — |
| T15 | dev-000333 | completed | 31/31 | cash_flow+income_profit=4；income_profit=9；cash_flow=9；unassigned=2；risks=5；global=2 | 0/0 | 1/11 | 6/0 | 否 | — |
| T16 | dev-000858 | partial | 40/40 | cash_flow+income_profit=4；income_profit=10；cash_flow=15；cash_flow+risks=1；risks=6；unassigned=2；global=2 | 0/1 | 5/18 | 12/0 | 是 | cash_flow:retrieval_miss |
| T17 | dev-600309 | partial | 40/40 | cash_flow+income_profit=3；income_profit=6；cash_flow=6；cash_flow+risks=2；risks=21；global=2 | 0/0 | 1/11 | 10/0 | 是 | cash_flow:retrieval_miss；risks:verification_pending |
| T18 | dev-600519 | completed | 25/25 | cash_flow+income_profit=3；income_profit=7；cash_flow=7；unassigned=1；risks=5；global=2 | 0/0 | 0/9 | 6/0 | 否 | — |

| 失败类别 | 问题数 | 依据代码 |
| --- | --- | --- |
| retrieval_miss | 9 | RETRIEVED_EVIDENCE_INSUFFICIENT |
| not_disclosed | 0 | 无符合条件的直接证据 |
| budget_exhausted | 4 | BUDGET_LIMIT_WITH_UNFINISHED_QUESTION |
| verification_pending | 3 | FINAL_CLAIM_VERIFICATION_PENDING |
| context_loss | 0 | 无符合条件的直接证据 |
| tool_error | 2 | UNRESOLVED_REQUIRED_SAVE_REJECTED |
| planning | 0 | 无符合条件的直接证据 |

按问题分布依据显式 questionId、metric、claimId 和最终/历史引用定位关联；搜索优先使用 fields，再用 query 词项推断。共享调用进入组合桶，每个相关问题分摊 1/n；覆盖检查和提交为 global。切换统计只使用单问题归属调用，忽略共享或未知调用，因此只是可观察代理。

重复 query 使用 NFKC、大小写及标点规范化；高度相似门槛为字符二元组 Jaccard ≥0.85，每个后续 query 最多计一次，并在 JSON 保留过滤范围是否相同。相同词串跨文档过滤不一定是浪费。无新证据采用文档版本、定位、偏移和返回内容 SHA-256 去重，分母仅为可解析的成功 search/read；不等于语义信息增益，重叠或扩展片段仍可能记为新单元。

每个失败问题只有一个主要类别，预算等共现因素另留在受控 JSON。retrieval_miss 表示已取回证据不足，不能单凭此判断原文存在答案或原文未披露；not_disclosed 必须有完整文档人工核查回执。verification_pending 表示终态明确缺少独立语义核验。context_loss 只接受直接上下文管理器遗失事件，不能由重复读取推断。预算到顶记录使用原 40 次上限及公开 checkpoint 的步骤状态，未记载步骤标 not_recorded。

逐调用归属、失败依据行号、未完成计划步骤和真实 query 仅保存于受控 evidence/U01 目录。本文不包含历史保留题、答案正文或隐藏思维链。

## 范围、依据与复验

本轮于 2026-10-24 在 codex/agent-upgrade 分支执行，无真实模型调用、无数据库操作。输入仅为 S19 已有运行的 task.json、result.json、tools.jsonl、observations.jsonl 与阶段 results.json；未读取外部隐藏题、答案或未来保留集。公开文档只含统计；逐行依据与真实 query 在受控本地目录保存。

| 任务别名 | 历史批次 / 阶段 | 实际任务数 |
| --- | --- | --- |
| T01—T04 | paired-20261020-01 / baseline | 4 |
| T05—T08 | paired-20261020-02 / baseline | 4 |
| T09—T12 | paired-20261020-02 / candidate | 4 |
| T13—T14 | paired-20261020-02 / holdout-continuation-02 / holdout（已消费） | 2 |
| T15—T18 | repair-validation-20261020-01 / baseline | 4 |
| — | human-review-20261020-01：核查材料，无新 task 轨迹 | 0 |

34 条阶段汇总记录只有 18 个唯一 taskId；两个 continuation 复制了 16 条开发结果，均按 taskId 去重。基础设施预检与核查材料不计为新任务；有任务记录但缺日志时才进入漏轨迹统计。18 份任务各有四类输入，观察调用数与 usage.toolCalls 完全一致。54 个问题的完成判定优先沿用原冻结 score.questions；两个历史保留任务没有冻结数值评分时采用终态报告的 supported 状态与必需事实是否齐备，并在 JSON 标 report_state。这是诊断口径，不新增独立质量验收，也不与其他批次混算提升幅度。

主要判定的读取位置是 result.json#/score/questions、task.json#/report/claims、task.json#/report/facts、公开 checkpoint 以及相关 tools.jsonl 行号。工具拒绝只有在相同期间和指标的事实仍缺失时才归为 tool_error；已恢复的旧错误不算当前瓶颈。预算可作为共现因素，但不覆盖已有的证据不足或核验未完成依据。

| 任务 | 额度到顶时公开计划仍未完成或未记载的步骤 | 未完成问题 |
| --- | --- | --- |
| T01 | income_profit/compare=running；income_profit/verify=pending；cash_flow/compare=running；cash_flow/verify=pending；risks/retrieve=not_recorded；risks/compare=not_recorded；risks/verify=not_recorded | cash_flow、income_profit、risks |
| T02 | income_profit/compare=running；income_profit/verify=pending；cash_flow/retrieve=not_recorded；cash_flow/compare=running；cash_flow/verify=not_recorded；risks/retrieve=not_recorded；risks/compare=not_recorded；risks/verify=not_recorded | cash_flow、income_profit、risks |
| T03 | cash_flow/verify=partial；risks/compare=not_recorded；risks/verify=pending | cash_flow、risks |
| T07 | cash_flow/verify=partial | cash_flow |
| T11 | cash_flow/verify=partial；risks/compare=not_recorded；risks/verify=pending | cash_flow、risks |
| T13 | income_profit/compare=not_recorded；income_profit/verify=partial；cash_flow/compare=not_recorded；cash_flow/verify=partial；risks/compare=not_recorded；risks/verify=partial | cash_flow、income_profit、risks |
| T16 | cash_flow/verify=partial | cash_flow |
| T17 | cash_flow/verify=partial；risks/compare=not_recorded；risks/verify=pending | cash_flow、risks |

上表是最终公开 checkpoint 的状态；not_recorded 表示没有对应完成记录，不能单凭它断言步骤从未执行。额度到顶以原 40 次上限和 usage 账本为准；第 40 次调用可以成功提交 partial，不能把“到顶”一律写成工具执行异常。T10 在 39 次后提交 partial，因此不计到顶任务。

not_disclosed 的零计数表示这批轨迹没有完整文档人工核查回执；不否认某些资料可能确实未披露。规划循环的可观察信号包括 17 次相同 claim 输入重复保存，以及 6 次同 claimHash 重复核验；这些调用与未完成核验共同支持先改进调用分配、重复操作抑制和收尾预留。仅凭这些记录无法证明拆分上下文会提高研究质量。后续多 Agent 的质量收益应保持为待检验假设；延迟与规模收益也应单独实验。

在仓库根目录运行，输出目录必须尚不存在；复验时替换末尾的新目录名：

```powershell
node --import tsx scripts/research/attribute-failures.ts --campaign=data/research-agent-upgrade/evidence/S19/paired-20261020-01 --campaign=data/research-agent-upgrade/evidence/S19/paired-20261020-02 --campaign=data/research-agent-upgrade/evidence/S19/repair-validation-20261020-01 --campaign=data/research-agent-upgrade/evidence/S19/human-review-20261020-01 --output=data/research-agent-upgrade/evidence/U01/<new-run>
```

本轮最终原件位于受控目录 data/research-agent-upgrade/evidence/U01/history-20261024-05/：attribution.json 保存逐任务、逐问题及逐调用依据，failure-attribution.md 为脱敏自动汇总，manifest.json 绑定 81 份输入和实现文件的 SHA-256，并在输出前复核输入未变。目录使用独占创建，历史目录只读。04 原件完整保留；05 修复了检索字段 risk 与问题标识 risks 的别名归属，混合 cash_flow/risk 的搜索进入共享桶并按 1/n 分摊。可观察切换由 142 修订为 141，其余总体统计与主要失败类别不变。

real-queries.json 包含 117 条真实 search_evidence 输入；development-real-queries.json 仅含 16 个开发任务的 95 条。两者 schemaVersion=1，queries 条目包含 campaign、phase、caseId、taskId、visibility、callId、ordinal、line、query、fields、questionIds、documentIds、periodIds、topK、indexVersion。questionIds 使用 income_profit、cash_flow、risks，可为多问题共享；U05 只消费 development-real-queries.json。JSON 不复制来源正文、参考答案或模型隐藏推理。

单元测试覆盖 risk 字段共享归属、解析与损坏输入、结果重复、任务身份冲突、共享调用、返回重读、query 相似度、证据指纹、七类归因、恢复后的旧错误、不可观测 compact、预算步骤和公开 Markdown 脱敏。初始命令、退出码与日志见受控 validation-20261024-01/，别名补修与 05 审计见 validation-20261024-02/；[升级进度](progress.md) 由主 AI 集成后登记。原历史质量结果仍见 [S19 配对评测](evaluation-results.md)。
