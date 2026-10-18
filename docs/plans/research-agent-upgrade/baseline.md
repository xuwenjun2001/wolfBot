# 财报变化研究：冻结场景与实现基线

审计日：2026-10-18。源码起点 `d17ac893b9605971f5ec47be7d1577aa32d8bd0e`，工作分支 `codex/research-foundation-s01-s05`。开始时工作区干净；S01 只修改计划文档。源码逐文件 SHA-256 在本地 `data/research-agent-upgrade/evidence/S01/workspace.json`；对应源码可从上述提交恢复。这里描述审计时系统，后续能力以实现和进度为准。

## 首版任务

一个经过证券解析确认的上市公司、两期财报、明确的截至时间。比较合并口径下的收入、归母净利润、经营活动现金流量净额，以及风险披露的变化。默认同长期间同比；半年报与全年、合并与母公司、营业收入与营业总收入、原始与重述值不得直接混比。允许输出 partial、不可比较或证据不足，并保留原因。

固定三个问题：收入与利润如何变化；经营现金流是否与利润同向以及有哪些有出处的解释；风险披露新增、延续或消失了什么。计算是确定性的，因果解释需要原文支持，未发现披露不能写成不存在风险。历史研究仅使用已核实在 asOf 可用的资料，披露日期未知不通过严格历史门。

## 可追踪的调用链

1. `/company-research` 的 client 通过 resolve 确认公司；POST runs 仅接受 `{symbol}`。route 校验 same-origin、`research.report.run`、幂等键、模型/搜索配置，再调 `resolveCompanies` 和 `store.createRun`。
2. `createRun` 建立 actor 私有任务，当前摘要只含 company，asOf 取创建时刻。没有 project 关系或共享机制；不得在升级中假设项目成员自动可读。
3. 独立 `scripts/workers/company-research-worker.ts` 从数据库 SKIP LOCKED 领取排队/过期任务，增加 generation，调用 `executeResearch`。租约 60 秒，心跳 10 秒；工具调用前及 checkpoint 校验 owner/generation/租约。
4. runtime 复用 PI 循环、provider 和工具 schema，依次确认身份、取财务摘要、查公告、读原文、记录问题证据、检查覆盖并提交。ledger 自动组装报告；失败/预算耗尽保留合格证据，不能把自动收尾视为正式模型提交。
5. checkpoint 在事务内保存 state、steps、sources、report 与递增事件。GET runs/{id} 和 SSE 均按 actor 查询；事件按序号续传，初次/终态有快照。公开来源摘要剔除正文。
6. cancel route 再校验权限与归属，queued 立即取消，running 由心跳/工具边界停止。Worker 退出保留检查点，由下一任在租约过期后恢复；不保存隐藏推理。

## 已有能力和缺口

| 领域 | 审计时已有 | 后续新增 |
| --- | --- | --- |
| 身份与隔离 | A 股解析、能力权限、actor 私有读写 | 版本化身份与资源关系；继续 actor 隔离 |
| 资料 | 公告分页、DeepSeek Search/Fetch、PDF 文本兜底、来源快照 hash | 原始 bytes hash、资料不可变版本、严格披露时点、受控原件存储 |
| 解析 | 最多前 100 页，350,000 字符 | 稳定页/块/表格定位、扫描件 OCR、质量状态 |
| 研究 | 主营、产业链、近期财务的固定问题；最近 8 来源片段 | 任意指定双期及三类变化问题、显式计划、检索与变化计算 |
| 证据 | 已读 source ID、片段存在性、已知日期检查 | 语义支持核验、严格未知日期处理、事实口径与报告不可变版本 |
| 治理 | 幂等、lease、fencing、取消、预算、SSE | 请求/计划/报告 revision 分离；旧计划失效与修订预算继承 |
| 评测 | 研究单测和可选数据库测试；旧案例文档 | 固定财报数据集、研究专用 baseline runner 和结果清单 |

引用字符串匹配不证明因果/语义正确。旧实现接受未知发布时间；当前 source.hash 是文本内容摘要，不是原 PDF bytes。财务接口的 revenue 是营业总收入，现金流只有每股值。恢复沿用工具累计次数和最初开始时间，但没有显式 execution attempt 表。

## 依赖与本次核实

Node `v24.12.0`、npm `11.6.2`，Prisma/PostgreSQL、独立研究 Worker、market-data。本机 Docker 可用，已有业务库及服务正在运行；5432、8000、3000 可连接。验证新持久化时另建 disposable PostgreSQL 容器，不修改这些业务服务或领取其任务。

`COMPANY_RESEARCH_API_KEY`、`COMPANY_RESEARCH_SEARCH_API_KEY`、`DEEPSEEK_API_KEY`、`DATABASE_URL` 均已配置，仅核实存在性。配置入口 `config.ts`：默认网关 `https://sub2api.380001.xyz/v1`，模型 `gpt-5.6-luna`、reasoning `max`；搜索固定 DeepSeek 官方端点；默认 40 工具/20 分钟。当前配置与网络实际可用性在 S03 分开验证。

2026-10-18 实跑 `npm run test:unit -- src/lib/company-research`：43 通过、2 个数据库测试跳过。`check:docs` 通过（65 文件、387 链接）；`check:module-boundaries` 因三个既有文件超限失败（chat 4161/4100、data-prefetch 2211/2040、market-data api 1541/1540）。本地原件在 `data/research-agent-upgrade/evidence/S01/`，由本升级任务所有，保留至 S20 及交接归档，不随普通 tmp 清理。

没有执行生产迁移、部署或数据复制。历史安迪苏验收、旧 CI 和看板 benchmark 均不作为本轮研究模型基线。
