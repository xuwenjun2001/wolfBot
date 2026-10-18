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

## S03 实测结果

按 [冻结评测](evaluation.md) 在独立 PostgreSQL 和随机 `research-baseline-*` 身份下运行现有 `createRun → claimRun → executeResearch → checkpoint`。资料/市场/搜索是封闭的固定公开输入，模型网关是真实请求；没有调用真实 DeepSeek Search/Fetch。仅为回放从测试适配器注入冻结 asOf，旧 API 仍不支持用户指定双期和问题，不能把这个注入视为产品能力。

2026-10-18 先运行 1 个校准，再执行 4 公司开发集。共 5 次真实网关请求，全部 HTTP 401 Unauthorized，全部任务 failed、0 个工具实际执行。没有收到模型 usage；token 测量与费用均 unknown，检查点零计数不是实测零消耗。失败阶段为网关鉴权，没有得到可评价的模型答案。此结果说明凭据“存在”不足以证明网关可用。

| 开发任务 | 终态 | 请求数 | 耗时 ms | 双期题分类 |
| --- | --- | --- | --- | --- |
| 茅台 | failed | 1 | 2512 | 3 题 unsupported |
| 五粮液 | failed | 1 | 152 | 3 题 unsupported |
| 美的 | failed | 1 | 135 | 3 题 unsupported |
| 万华 | failed | 1 | 138 | 3 题 unsupported |

“unsupported”是事先由旧输入/输出合同确认的能力范围；网关 401 是另一个实际失败维度。开发集模型成功 0/4，不能报告财务准确率或相对提升。待网关凭据修复可另存一次运行，不能覆盖本次失败；完整双期能力首次可比基线仍在 S13。

本机原件：`data/research-agent-upgrade/evidence/S03/calibration-1792329337598/` 和 `development-1792329381075/`。包含 manifest、逐任务最终快照、状态/来源、可观察工具调用片段和 usage 完整性。隐藏推理、凭据、请求 headers、未经筛选的错误正文未保存。数据库只保存测试数据；原件长期保留，不随容器删除。

```powershell
# 显式指定全新的 localhost research_test* 空库，先 migrate deploy。
# 凭据从本地 env 读取，命令不打印。
node --import tsx scripts/research/run-baseline.ts --calibrate
node --import tsx scripts/research/run-baseline.ts
# 不访问模型或数据库，仅复验已有结果和资料/评分 hash：
node --import tsx scripts/research/verify-baseline.ts data/research-agent-upgrade/evidence/S03/development-1792329381075/manifest.json
```

运行器要求 `RESEARCH_TEST_DATABASE_URL`，拒绝隐式使用应用库、非 localhost 或非 `research_test*` 数据库，也拒绝消费已有任务。校准与正式开发各用一份空库。归档回放验证的是当时观察，不意味着模型可逐 token 确定性重现。原件不可获得时，这次结果只能读摘要，不能声称离线复验通过。

## 用户指定新模型的配置校准

2026-10-18 用户指定在同一网关使用 `gpt-6.1-sol` / `high`。本机密钥仅存 `.env.local`；研究配置允许 high/max，runtime 与请求体保持一致。旧模型/max 的失败原件、rubric 和资料 hash 保留。

新配置探测用 `node --import tsx scripts/research/run-baseline.ts --calibrate --config-calibration`，仍需全新的隔离空库。该模式只跑第一个开发案例，沿用校准的 4 次工具/360 秒预算；产物保存为独立 `config-calibration-*`，明确 `comparableToFrozenBaseline=false`。普通校准/开发运行继续严格核对冻结的模型与 reasoning，不能用这个参数运行完整开发集或改写评分合同。

这项校准只验证网关及旧执行链路接入，不证明双期研究、实时搜索或业务质量。真实结果见 progress.md 的 E-S03-02。
