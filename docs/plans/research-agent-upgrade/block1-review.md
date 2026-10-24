# U 系列板块 1：验收与人工核对

这里汇总阶段 0 的可复验产物和仍需人工判断的项目。实现进度以 [progress.md](progress.md) 为准，实验配置以 [实施计划](agent-upgrade-proposal.md) 的 G0 为准。本轮开发不运行真实研究模型。

## 评分合同和四个原开发案例

[rubric v2](../../../fixtures/company-research/rubric-v2.json) 和 [可回答性草稿](../../../fixtures/company-research/answerability-dev-v1.json) 与 v1 并列保存。v1 评分、参考答案、原报告和预算没有改写。只有人工回执真实存在并绑定原件范围后，才能把标签和 rubric 冻结；生成报告的 evidence_gap 不能作为原文未披露的证明。

9 道既有完整人工参考题保留其确认依据。其余 3 道题需要逐项核对：

| 题目 | 当前草稿 | 需要人工裁定的范围 |
| --- | --- | --- |
| 五粮液现金流 | answerable / pending_review | 历史 baseline 已引用 2024 年报文件页 120—121 的会计调节解释；核对它是否满足固定题要求，不能因最近一次生成缺答改判未披露 |
| 美的现金流 | answerable / pending_review | 两期现金流及现金与利润解释的相关页，核对固定问题要求的解释范围 |
| 万华化学现金流 | not_disclosed 候选 / pending_review | 两份完整年报的现金流附注、管理层讨论及相关说明；文件页 16 的“未发生重大变动”本身不足以证明全篇未披露 |

人工核对时填写实际读过的文件页/章节范围、结论、原件 hash 和独立回执路径。新的未披露判断需要 answerability 回执，不能继承旧 partial 报告的同意。模型不能代填人工确认。

v2 的提议门槛为数值 ≥95%、沿用 v1 的三问完成率 ≥80%、可回答题支持 ≥90%、正确弃答 100%、错误断言 0，全部硬门及必需人工审查通过。未披露题的行为判定需要绑定**整份报告 hash** 的独立复核：缺口文字也可能包含实质断言。未审结果保留 unknown，并报告分母和未审数量；结构化状态代理只放在 diagnostic 中。

同一批历史报告的诊断重算保留四公司、12 题、36 个数值项：v1 数值 36/36，三问完成与结论支持均 9/12。按草稿标签，可回答题支持 9/11、漏答 2/11，另有 1 道未披露候选题的响应尚未人工审查。当前 officialEligible=false、gatePassed=null，不能据此宣称 v2 通过或研究质量改善。

受控本地核对包为 `data/research-agent-upgrade/evidence/U02/human-review.pending.md`，并列结果在 `U02/rescore-repair-validation-20261024-02/`。目录中的 reproduction.json 绑定输入、代码和输出 hash；原始私有资料与日志不进入 Git。换机需恢复受控证据后复验。

## 扩展样本与分层

[开发集 v2](../../../fixtures/company-research/development-v2.json) 包含 14 家公司、28 份两期年报和 2 份任务可见的原始扫描审计附件，共 42 题、84 个原披露金额、42 个增幅；[同行配对](../../../fixtures/company-research/peer-pairs-v1.json) 有 7 组。两期主年报和扫描附件分别登记，附件不会裁掉来适配旧评分器。

| 分层 | 候选案例 | 机器定位/结构检查 | 人工确认 |
| --- | ---: | ---: | ---: |
| 正常三问 | 12 | 4 | 0 |
| 原因未披露 | 2 | 0 | 0 |
| 口径/重述冲突 | 3 | 3 | 0 |
| 原始扫描 | 2 | 2 | 0 |
| 至少 200 页长文档 | 9 | 9 | 0 |

万华、光明的“原因未披露”只是两个候选，两期完整范围尚未经人审。光明还存在税费等分项原因和现金流调节表，不能凭管理层讨论未列总净额原因就判全篇未披露。候选达到每层 2 例不等于人工分层覆盖达标。

原始扫描来自洋河和华鲁的官方审计附件。真实本地 Docling/RapidOCR 各完成 3 页，共 6 页、41 blocks，回执均 partial、OCR 块均 needs_review。扫描层机器计数证明原扫描资料存在；它不证明整份文档已可读，也不证明研究答案已依赖 OCR 证据。

6 例明确阻止当前真实执行：海尔/平安/太保需要重述比较适配；平安/太保/招行的原件单位 million_yuan 尚不在生产金额合同内；招行的生产原生解析存在中文字形问题；洋河/华鲁的扫描附件仅部分解析，且旧评分器不支持三文档任务绑定。准备校验器可复算这些原值，但不会修改生产合同、转换原件口径或静默删例。

机器复验命令如下，输出目录需换成新的名称：

```powershell
node --import tsx scripts/research/verify-fixtures.ts --dataset=fixtures/company-research/development-v2.json --output-dir=data/research-agent-upgrade/evidence/U04/<new-run>
```

本轮验证全部 30 份原件/解析回执 hash、金额换算、变化复算、42 个标签 schema 和 211 处原文引用。受控人工表为 `data/research-agent-upgrade/evidence/U04/human-annotation-worksheet.md`，其 hash 在开发清单中登记；14 家新金标准均未由人工冻结。重述基期值和列头单独保留在 comparisonFacts，不覆盖原披露 facts。

[新保留登记](../../../fixtures/company-research/holdout-registration-v2.json) 只提交 hash 和数量：4 家、8 原件、12 题。身份、题目与原件保持外部隔离；答案尚待独立人工，登记中的准备回执也不能充当生产解析验收。换机须恢复受控根和开发证据，不能仅从 Git 重建原件或重跑盲采来替代恢复。

## 原因与风险页检索基线

[检索标签 v2](../../../fixtures/company-research/retrieval-labels-v2.json) 在旧四家开发资料上包含 12 条规范 query、21 条 U01 历史真实 query，共 33 条查询、66 个预期文件页。真实 query 来自最终归因批次 `history-20261024-05` 的开发轨迹，保留原 documentIds、periodIds、fields、topK 和索引版本。现金流新页标签仍是待人工核对草稿，数值和风险页沿用既有参考。

当前索引 `zh-context-bm25-v4` 在统一两期语料上，不加历史调用过滤的 Recall@5 为 **39/66（59.1%）**、MRR 为 **0.5318**。按严格页证据类型分列如下；同一 query 可含两种证据，不能把问型中的范围页算作因果解释页。

| 页证据类型 | 含该类型的查询数 | Recall@5 命中页/预期页 | MRR |
| --- | ---: | ---: | ---: |
| 数值控制 | 10 | 20/20 | 0.8667 |
| 因果解释 | 9 | 2/15 | 0.1605 |
| 披露范围 | 6 | 4/9 | 0.3488 |
| 风险表述 | 11 | 13/22 | 0.5692 |

按 query 问型，直接现金流原因查询命中 0/12；规范 query 为 17/24，真实 query 文本为 22/42。另组 `observedScope` 沿用真实请求的文件、期间和字段过滤：21 条均可评分，2 个范围外金标单独保留，Recall@5 为 19/40、MRR 为 0.4441。它使用当前语料和索引，不复现历史字符截断或模型上下文，不能称为原调用的完整重放。

复验使用明确的解析目录，输出目录另取新名：

```powershell
node --import tsx scripts/research/verify-retrieval.ts --labels=fixtures/company-research/retrieval-labels-v2.json --parsed-root=data/research-agent-upgrade/evidence/S07/2026-10-18T17-44-58-299Z --output-dir=data/research-agent-upgrade/evidence/U05/<new-run>
```

报告 `U05/block1-20261024/scope-current-01/report.json` 保存 Recall@1/3/5/10、逐题排名、完整分母、原件/解析/标签/源码 hash；MRR 按完整唯一页排名计算。`--profile=baseline-v1` 的无标签旧用法复验仍为 10/24 页、2 道完整问题。当前结果支持后续调查原因与风险定位，尚未进行检索优化或研究质量对照；未调用模型、embedding 或 reranker。

## 当前门禁

U02 的评分实现和诊断重算、U04 的机器准备与核对已完成，人工标签、rubric、数值/语义分层及未披露响应审查仍待处理。G0 还需要实验预算登记确认；本页将随 runner 的实际验证补齐。原 S 系列维持 18/20，S19/S20 质量阻塞继续保留。
