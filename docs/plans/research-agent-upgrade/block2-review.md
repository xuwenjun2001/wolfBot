# 板块 2（U10—U14）实现审查

2026-10-25（北京时间），审查 `codex/agent-upgrade` 的 `8af165565a30f04c829cfc3909f7ff0ebc71100f`，范围为 U10—U14 的纯策略、运行时、批次及持久化调用链。起点工作区干净。本轮只提交审查和交接文档，未修改产品实现。

发现 3 个可复现问题，均影响 B/B2。U13 需要修复，U14 依赖同一调度器，需要补回归；U10—U12 的纯函数验收记录保留。既有测试通过不能覆盖下列状态转换反例。

## R1 / P1：更新重试保留了已完成的报告节点，导致没有下一动作

位置：[execution-contracts.ts](../../../src/lib/company-research/execution-contracts.ts) 的 `rebindFinancialCheckpoint`，第 55—57 行。

当一次 B/B2 更新正常提交 partial，但仍有未读取的 pending 来源时，`queueResearchReportUpdate` 允许在原预算内重试。retry 分支清除 `submitted` 和 `checkedHash`，却原样保留 `nodes`。上次 `submit_report` 已将三个 report 节点全部设为 completed；若其他节点也已 completed/partial，新的 scheduler 没有 ready 节点。`check_coverage`、读取和提交都会返回 `SCHEDULER_TOOL_NOT_ALLOWED`，即使预算仍充足。

真实隔离 PG + 固定 provider 已复现：先创建研究、登记新来源、执行更新直到 submitted partial，再用新幂等键排队 retry。此时还剩 **28** 次工具额度，`nextAction` 为 null，覆盖检查被拒绝，重试报告的 `submitted` 为 false。此反例经过真实 queue、checkpoint、PI loop 和 report store；没有真实模型调用。测试 provider 在记录拒绝后主动结束，避免无意义循环。

修复应显式重新打开本轮的收尾节点，并明确待处理来源如何继续读取；保留原预算、停止的缺口和尝试计数。不能通过清空全部缺口或增加额度解决。现有 PG 测试只检查 retry 字段保留，未把已提交 partial 恢复后执行到再次提交。

## R2 / P2：保存首条结论便关闭整个问题的事实与结论写入

位置：[financial-scheduler.ts](../../../src/lib/company-research/financial-scheduler.ts) 的 `observe`，第 268 行。

每次成功 `record_claim` 都无条件把 compare 节点设为 completed。工具合同允许逐条保存结论，也不要求保存结论时六个金额已经齐备；例如先保存收入结论，再补利润金额或另一条结论，属于可接受的增量动作。但节点关闭后，scheduler 立即切换其他问题，后续本问 `record_fact` 被拒绝为 `SCHEDULER_NODE_MISMATCH`，另一条结论同样无法保存。

若首条结论核验通过，就没有失败核验来重新打开节点；最后 `check_coverage` 即使发现必需金额缺失，也仅保持 report 节点 pending，不能返回 compare 修复。因此在证据和预算足够时仍会形成无法补齐的 partial。纯状态反例已复现：在两期检索完成后保存收入利润首条结论，剩余 29 次调用时收入事实仍被拒绝。

修复应把问题完成条件与单条保存区分开：至少允许保存本问必需事实和多条结论，或让 coverage 缺口触发受预算约束的局部修复。显式缺证仍可 partial，不能把“所有金额必须齐全”变成全局等待门。现有成功测试由测试 provider 预先保证六个事实全部保存后才提交结论，掩盖了这一顺序依赖。

## R3 / P2：准入没有计入新增结论带来的核验预留

位置：[financial-scheduler.ts](../../../src/lib/company-research/financial-scheduler.ts) 的 `admit`，第 173—175 行。

当前准入只比较调用前的 `closureReserve`。当剩余 3 次、原预留为 2 时，新增 supported 结论的 `record_claim` 会被允许。保存后仅剩 2 次，但此结论新增一次核验要求，实际需要 `verify_claim`、`check_coverage`、`submit_report` 共 3 次。

纯状态反例确认：记录结论 → 核验成功 → 覆盖检查后余额为 0，提交被拒绝，`submitted` 保持 false。运行时会进入提前停止的封存路径；报告会增加停止缺口，更新来源也不能按正常提交完成检查。B2 的批次预检同样使用调用前的预留，所以无法拦截该问题。

修复应在写入准入前投影本次动作新增或失效的核验义务，并保证扣除本次调用后仍够收尾。当前纯 `reserveForClosure` 只计算给定状态，其函数结果本身不是问题；缺口在 U13 的准入接线。增加边界回归时应覆盖新增 claim，以及修改事实使既有 review hash 失效的情况。

## 本轮验证与证据边界

| 验证 | 本轮结果 |
| --- | --- |
| `npm run test:unit -- src/lib/company-research` | 231 passed，64 DB-only skipped；退出 0 |
| `npm run type-check` | 退出 0；保留 Node DEP0190 提示 |
| 现有隔离 PG 演练 | 64/64；34 迁移、重复部署、新 client 和旧读写兼容通过 |
| 额外纯状态复现 | 3 个当前错误行为断言通过；这表示确认缺陷，不表示功能验收通过 |
| 额外 PG 复现 | R1 的完整排队、更新、提交、重试调用链确认；退出 0 |
| `npm run check:docs` / 差异检查 | 85 Markdown / 631 本地链接通过；`git diff --check` 通过 |
| 真实模型 / U15 | 本轮未运行，真实质量及收益未验收 |

本轮证据归本研究审查所有，沿用受控 evidence 保留策略，不自动清理。纯状态脚本、结果、单测和类型日志位于 `data/research-agent-upgrade/evidence/U14/`，前缀 `review-u10-u14-`。纯状态脚本 SHA-256 为 `4324cec0313c40046025e34696d74d46d1323e8a734ebc5559233881a6cb5ea1`；结果 JSON 为 `ef1ad8db967aeec1991a2817270b5141307e2002bc2d899926562bf8b8c682bf`。

PG 通过本地 `review-pg-launch.cjs` 在现有 runner 中追加复现脚本；原 runner 和产品文件保持原样。命令：`node data/research-agent-upgrade/evidence/U14/review-pg-launch.cjs --native-postgres=data/research-agent-upgrade/evidence/S05/native-postgres-16.14/package/native/bin`。它仅连接新建的 localhost `research_test`，保留合成记录和证据，已停止自有集群。

PG 清单：`data/research-agent-upgrade/evidence/S05/rehearsal-4a18233c-94aa-47cc-a0ac-b8532b48b3e8/manifest.json`，SHA-256 `03bfea3775d46ac8c45e52cfe0bdd75563eafd660ea8c38a1c9a234defe68b1e`，`outcome=passed`、`nativeClusterStopped=true`。同目录的 `review-u10-u14-repro.log` 保存 R1 原始结果，`database-tests.log` 保存 64 项现有测试结果。原件留本地，不加入 Git。

后续先修复 R1—R3 并补充真实调用链回归，再恢复 U13/U14 的验收状态。G0/U04、CLI 真实 adapter、样本和实验执行协议等原阻塞保持；本审查没有启动其他板块或生产操作。
