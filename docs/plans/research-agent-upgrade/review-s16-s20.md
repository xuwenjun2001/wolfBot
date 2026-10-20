# S16—S20 Review：入口解析与报告更新

2026-10-20，审查 HEAD `8736a9041cf10caaaa5273f52fddadf2f5fcfb8e`，分支 `codex/research-agent-s11-s15`。范围为 S16—S20 实现、验收材料，以及用户报告的“安迪苏 / 601919”创建失败。本次只登记 review，没有修改产品代码或执行生产部署。

## 结论和状态

确认三个问题。入口解析缺陷早于 S16，属于本次用户反馈暴露的集成问题；另外两个由 S17 的更新调度引入。S17 从 done 重开为 in_progress，当前已验收计数为 17/20。S16、S18 本轮未发现新的确定性缺陷；其历史验证边界不扩大。

S19、S20 原本就是 blocked。S19 全分母为数值 9/18、问题 3/6、冻结 claim 支持 3/6，未通过质量门；S20 原发布检查为 1418 passed / 35 failed / 71 skipped。本次没有重跑真实模型评测、保留集或完整发布门，原阻塞仍在。

## R1 / P1：创建时使用行情解析器不支持的证券格式

位置：`src/app/api/company-research/tasks/route.ts:26`，关联 `connectors.ts` 的 `resolveCompanies` 与 `FinancialWorkbench.tsx` 的 `create`。

工作台先按用户输入查询，再把选中的六位代码规范化为带交易所后缀的任务身份。创建 API 直接用该完整身份再次查询，连接器没有转换。对当前本地行情服务的实际读取均返回 HTTP 200：

| 查询 | 返回 |
| --- | --- |
| 安迪苏、600299 | 600299 / 安迪苏 / SH |
| 600299.SH | 空 results |
| 601919 | 601919 / 中远海控 / SH |
| 601919.SH | 空 results |
| 600519.SH | 空 results |

所以合法选择在写入任务前被判为“公司身份未通过证券解析确认”。这不是用户输入有误或行情服务不可达。应统一查询代码和内部规范身份之间的转换，并继续校验权威名称、代码及交易所；不能直接删除身份验证。

现有 API 测试把解析器 mock 成始终返回匹配公司，S20 的 `run-research-delivery.ts` 又直接导入存档任务，未经过 resolve → create → start。这两类通过记录都未覆盖当前失败路径。修复应增加该边界回归及从空任务列表开始的入口旅程。

## R2 / P1：原截止时间耗尽后仍接受新财报更新

位置：`src/lib/company-research/report-update-store.ts:115`，关联 `attempt-store.ts:27` 与 `financial-runtime.ts:33`。

更新接口接受终态任务、清除受影响事实并排队，但继续使用首次任务的 startedAt/deadline/tool_calls。默认截止为首次启动后 20 分钟；隔天发现新财报时，Worker 虽能领取，模型分支却因 remaining=0 被跳过，直接提交新的 partial。用户无法通过此入口真正研究新来源。

独立 PostgreSQL 反例将合成任务设为前一天开始，导入可用新 hash 后调用真实更新与 Worker 函数：排队成功，模型调用 0，工具调用 0，报告从 v1 变 v2/partial，stopReason 为“已达到任务原始截止时间”，新文件仍 acquired。

D28 明确要求沿用旧预算，因此这是当前设计与 S17 新财报更新目标的冲突，不是 Worker 恢复逻辑意外重置预算。修复需定义用户主动更新对应的新逻辑运行及独立限额，保留旧运行消耗；同一次更新的重试/恢复继续共用其限额。至少在未具备可执行预算时拒绝排队，不能继续显示已受理后直接交付空更新。不得清零原任务用量来伪造通过。

## R3 / P2：排队回执提前把未读资料标成已检查

位置：`src/lib/company-research/report-update-store.ts:70`。

`priorHashes` 汇入所有历史 `report.update.queued` 的 sourceHashes，未检查对应来源是否读取、核验或处理成功。若模型在第一轮请求就发生临时故障，运行器会保留 partial；此时相同来源已被永久排除，点击再次更新得到 no_new_evidence。原幂等键重放也只返回旧计划，不重新排队。

独立 PostgreSQL 反例保留完整 20 分钟预算，用无网络的故障 Provider 在首次模型调用抛错：调用次数 1、工具次数 0、文档仍 acquired，报告 v2/partial；随后换新幂等键更新，返回 `{ queued: false, reason: 'no_new_evidence' }`。这与 R2 独立，单独修复截止时间不能解决。

修复应区分“更新已排队”和“此来源已经完成检查”的持久记录。失败且未检查的来源可在剩余预算内恢复，已明确判为无关且成功处理的来源继续去重。

## 本轮验证和证据

| 验证 | 结果 |
| --- | --- |
| 公司研究库、任务 API、财报工作台、精确评分定向 Vitest | 140 passed；44 个 PG 用例先跳过，随后在隔离库另跑 |
| 独立 PostgreSQL runner | 44/44 passed；旧库写入、33 条升级迁移、重复 deploy、新客户端与旧代码兼容通过 |
| S19 输入/阶段保护 Node 测试 | 8/8 passed；未读取真实保留题或调用模型 |
| 六组证券解析实际请求 | 全部 HTTP 200；三组带后缀请求返回空列表 |
| 两个新增 review 反例 | 均复现上述异常；只使用合成资料和无网络 Provider |

以上正常测试通过不抵消新增反例。未重跑 build、全量类型/lint、完整 release、真实模型评测或 SIGKILL 演练，不把历史通过记录当作本轮执行。

本轮证据目录为 `data/research-agent-upgrade/evidence/review-s16-s20/20261020-01/`，不提交原始响应、日志或探针脚本。`manifest.json` SHA-256 为 `acfc31f65a2537fbffd3784098ba75ef0b5a91fd6cd174ec49470dfad181edae`；其中保留解析响应、测试日志、探针与 runner 指纹。`update-probes.json` SHA-256 为 `805102229fba170ee89aa6fad8803d1fd3c96ff078820b0d9691ba838132a68c`。

隔离 PG manifest 为 `S05/rehearsal-de4ac63a-3042-4cca-9812-54b6587f4fce/manifest.json`，SHA-256 `8d97bcaef43771ee630c9c14453d814f6a6c88b925881e449e417e7f9b847b04`，outcome=passed、nativeClusterStopped=true。只修改临时 research_test；业务库和日常服务未操作。

下一次修复先解决 R1，再修正 S17 的运行预算与失败来源回执，并把两个反例纳入正式回归。完成后重验 S17 和 S20 入口旅程；S19 质量修复和原 35 项发布失败仍按各自证据处理。
