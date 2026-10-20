# 公司研究

入口 `/company-research` 是双期财报变化工作台，研究收入利润、现金流解释与风险变化，并可点击金额/结论读取保留原文。原主营业务、上下游研究及旧报告位于 `/company-research/legacy`；旧的 `?run=` 链接会跳转到该入口。两条链路共享 PI 和研究 Worker，报告和任务不依赖生成项目。

## 本地启动

1. 在已确认的本地开发数据库执行 `npx prisma migrate deploy` 应用迁移。旧研究链路保留四张表；财报变化使用七张版本表及索引、语义回执、人工验收表。本轮新增迁移 `20261019130000_research_execution`；生产按发布规范处理。
2. 在不提交的 `.env.local` 配置研究模型的 `COMPANY_RESEARCH_API_KEY` 与 DeepSeek 官方密钥 `COMPANY_RESEARCH_SEARCH_API_KEY`。搜索密钥未单独设置时复用 `DEEPSEEK_API_KEY`。
3. 默认网关为 `https://sub2api.380001.xyz/v1`，模型为 `gpt-5.6-luna`，推理强度为 `max`。可通过 `COMPANY_RESEARCH_BASE_URL`、`COMPANY_RESEARCH_MODEL`、`COMPANY_RESEARCH_REASONING` 指定服务端配置，推理强度支持 `high` / `max`，按配置原样发送；不自动降级模型。2026-10-18 本机按用户指定切换为 `gpt-6.1-sol` / `high`，凭据保存在已忽略的 `.env.local`。
4. `npm run dev` / `npm run dev:background` 自动管理研究 worker。也可单独运行 `npm run worker:research`；单任务运行用 `npm run worker:research:once`。

常驻 Worker 在启动时加载环境变量；修改 `.env.local` 后需在维护开发栈时重启加载。独立校准使用新进程，不能据此声称已有常驻进程已经切换。

生产部署时需要独立运行研究 worker，并提供同一数据库和服务端密钥。本次功能不自动部署生产。

搜索与正文读取分别调用 DeepSeek 官方 `POST https://api.deepseek.com/v1/tools/search` 和 `POST https://api.deepseek.com/v1/tools/fetch`，独立于研究模型网关。搜索每次最多返回 5 条；通过 `site:` 和 `before:` 传递域名与日期条件，并再次核对返回域名和发布日期。`before:` 使用截止日次日，包含研究截止日当天。查询词与条件合计最多 128 个 Unicode 字符，超限时要求缩短查询或减少域名，不截断过滤条件。搜索结果仅用于发现资料，引用仍需读取并保存正文；Fetch 无法读取 PDF 时沿用本地下载解析兜底。迁移后搜索缓存按 provider 区分，已有正文快照继续可用。

## 预算

仅保留 `COMPANY_RESEARCH_MAX_CALLS=40` 和 `COMPANY_RESEARCH_TIMEOUT_MS=1200000`（20 分钟）两项运行预算。补查轮次、来源数量及累计输入/输出 tokens 不限制；旧的 MAX_ROUNDS、MAX_INPUT_TOKENS、MAX_OUTPUT_TOKENS 配置不再生效。token 使用量仍记录。单次模型响应和上下文长度仍受模型技术限制。重启恢复不重置调用次数和开始时间。

## 数据与恢复

任务包含不可变公司身份、截止时间、研究状态及逐步 trace；每次工具开始和结束均以持久事务生成事件。来源包含原文快照、SHA-256、获取时间和可得的发布时间。报告包含逐条结论、原文引用和指标口径。

worker 采用 PostgreSQL 原子领取、60 秒 lease、10 秒 heartbeat 和 generation fencing；重启后以最近已提交的研究状态、草稿和资料恢复，不持久化或恢复隐藏推理。中断的工具显示失败，下一次调用另起步号。只读外部请求在崩溃边界可能重发，报告提交由同一任务事务覆盖，避免重复交付。

权限复用 `research.report.read/run`，所有 API 按当前用户过滤。SSE 使用事件序号续传。取消保留资料和草稿。

## 验收边界

平台确定性检查报告结构、已读取 source ID、原文引用存在性和已知发布日期。它不能仅凭字符串校验保证模型结论语义正确，需通过真实公司样例人工核查。正文未提供发布日期时保留为空，由研究过程根据文档确认报告期。旧 runs 链路仍不做 OCR，正文快照上限 350,000 字符，PDF 最多前 100 页；新 tasks 基础层的 OCR/检索另见下文，S11 才接入 Agent 执行。

## 接口

- `GET /api/company-research/resolve?query=...`：返回候选 A 股公司。
- `POST /api/company-research/runs`：`{symbol}`，必传 `Idempotency-Key`。
- `GET /api/company-research/runs`：当前用户最近 30 次研究。
- `GET /api/company-research/runs/{id}`：状态、步骤、来源摘要和报告。
- `POST /api/company-research/runs/{id}/cancel`：请求取消。
- `GET /api/company-research/runs/{id}/events`：SSE，支持 `Last-Event-ID` / `after`。

研究上下文每轮从持久化草稿、来源片段和最近工具结果重建，避免整段历史反复传入或压缩时丢失已读证据。平台在取得基础证据后要求保存草稿，在工具次数或时间耗尽时保存已有成果，不按 token 用量提前提交。


## 执行策略 v2

调查先读取财务摘要，再通过 `get_company_filings` 每次一页定位最新年报和最新定期报告；公告 API 新增可选 `page`，默认 1，响应含 `page` 和 `has_more`。每页计一次工具调用。PDF 失败尝试公告详情页，再由模型切换 DeepSeek 搜索。

`record_evidence` 按稳定 question ID 保存单个问题的结论、原文引用、披露状态及财务口径。`check_research_coverage` 改为空参数，不再生成整篇报告。`write_report_section` 仅排序已有证据 ID，平台自动组装引用及未编排章节。正式提交仍需覆盖检查。补充合作方名称未找到只进入局限性；必需问题缺失、冲突或引用错误阻止完成。

正文关键词去空白、去重后最多使用 8 个；trace 显示收到与使用数量。同查询命中任务缓存，同正文同关键词标记重复；新关键词允许重新提取。无进展的同一问题连续两次搜索必须切换公告或域名。搜索结果先按研究对象筛选，不能把无关结果当证据。

剩余 120 秒或 3 次工具调用时进入不可逆的 finalizing 阶段，禁止新增外部调查。请求受任务硬截止限制。截止或取消时直接从已核查证据生成报告；系统自动保存不增加工具步号，也不会假装正式提交。API/SSE 增加 phase、deadline、stopReason、coverage、systemEvents；页面显示阶段与系统收尾说明。

状态版本、问题证据、查询历史、读取指纹和阶段都保存在现有 JSON 检查点，不增加数据库表。旧终态报告不改动；旧活跃任务保留有效草稿与引用，并重新核查新版问题，计数和开始时间不重置。

## 财报变化研究基础层 v1

S01—S05 的契约和存储准备见 [实施进度](plans/research-agent-upgrade/progress.md)、[合同](plans/research-agent-upgrade/contracts.md)、[固定评测](plans/research-agent-upgrade/evaluation.md)。这部分使用追加迁移 `20261018140000_research_version_foundation`，与上述旧研究任务并存。

`POST /api/company-research/tasks` 接收严格的 financial_change v1 请求和 `Idempotency-Key`，重新核实证券身份，保存 actor 私有的 **draft**。请求含公司、两期、asOf、三类问题、合并/母公司口径、币种、比较状态和预算。不会交给旧 Worker 执行；完整计划生成和研究执行在 S11 接入。

可用读取边界：`GET /api/company-research/tasks/{id}`；`GET /api/company-research/tasks/{id}/reports/{revision}`；`GET /api/company-research/tasks/{id}/documents/{documentId}/{version}`。文档加 `?content=original` 或 `?content=parsed` 下载对应受控内容，始终检查任务归属，使用 private/no-store 和 attachment；已知 digest 不能绕过授权。`POST /api/company-research/tasks/{id}/cancel` 取消草稿/执行权并保留资料。计划、文档注册、attempt 与报告写入先由受信 repository 使用；S05 不开放客户端任意写报告或修改计划。

新 repository 将需求/计划/文档/报告/事件保存为不可变版本，旧代码读取旧表不受新表影响。计划乐观版本冲突、报告竞争写和过期 attempt 都会失败；逻辑工具预算和 deadline 不随 attempt 重建。报告提交核对页文本 receipt 与来源/时期/时间关系；语义、计算、解析和完整产品验收仍分别属于后续步骤。

原件和页文本 receipt 位于 `data/company-research/artifacts/{actor摘要}/{内容摘要}`。数据库只存元数据、digest 引用与状态。相同 actor 可复用相同 bytes，跨 actor 存储隔离；每次读取重新核对长度/hash，拒绝目录链接和路径输入。数据库事务失败后可能留下未引用对象，需要独立保留/清理操作；不自动扫描删除。备份或迁移时应保留数据库和对应目录，单独恢复数据库不能保证原件可用。取消不删除资料；没有默认 TTL，后续删除必须按数据生命周期规范明确执行，不能只删除某个共享内容文件。

验证入口：`npm run test:research:postgres`。需要 Docker 和本机已有的 `postgres:16` 镜像；脚本创建专用临时容器，仅绑定 localhost 的随机端口，以 migrate deploy 演练旧库 → 追加迁移 → 重复 deploy，再核对旧代码读写兼容、独立 Prisma 客户端和并发/隔离测试，最后删除自己创建的容器。输出留在 `data/research-agent-upgrade/evidence/S05/`。它不使用 `.env` 中的应用数据库连接，不执行 db push，也不改生产数据。

Docker 不可用时，可显式传入已有可信 PostgreSQL 16 工具目录：`npm run test:research:postgres -- --native-postgres=<绝对路径/bin>`。该目录需有 initdb、pg_ctl、postgres；runner 会在本次证据目录新建专用集群、只监听随机 localhost 端口，最终停止自己创建的集群，保留日志与数据供核查。不会复用该目录附近的旧数据库。Docker 仍是默认方式；缺工具时直接失败，不自动连接应用库。

Windows 开发服务可能锁住已加载的 Prisma DLL。演练脚本在独立目录生成客户端并做 ORM smoke，避免替换运行中的文件；正常应用客户端在维护开发服务时再按 `npm run prisma:generate` 更新。当前新 repository 使用参数化 SQL，没有依赖新增 ORM delegate 才能运行的隐式前提。


### 原件发现和导入（S06）

`GET /api/company-research/tasks/{id}/documents` 返回该任务的版本清单；加 `?discover=1&page=1` 查询原始公告候选，保留分页。优先巨潮，失败时复用 market-data 公告和现有 DeepSeek Search；搜索链接不代表已下载原件。`POST` 接收 `{provider:"cninfo",candidateId:"cninfo-公告编号",page:1}`，服务端重新查询官方记录；或 `{provider:"manual",url,title,periodId}` 导入待核查链接。手动输入不能声明自己已核实日期或身份。下载失败会返回错误，不登记为已取得正文。

下载固定已验证 DNS 地址，每次重定向重新核对公网地址，限制 50 MB，并校验 PDF/HTML 内容和类型。原件与公告依据内容寻址、actor 隔离；同一链接同 bytes/依据重试复用，修订保留新版本。文档的 acquired 状态仅代表已取得 bytes，不能代表解析或财报身份核验完成。

巨潮 announcementTime 是上海日历标签，按 Asia/Shanghai 转日期，并在当天结束后才允许用于严格 asOf。抓取时间、URL 路径、搜索日期不能替代披露依据；独立日期冲突和无依据都返回 date_unverified，未来资料返回 after_cutoff。冻结开发集旧日期不原地改写，S06 的八份日期修正记录单独留存。

复验：`node --import tsx scripts/research/verify-acquisition.ts` 检查开发集八份原始公告日期、实时公告发现及一份公开原件下载/hash，结果在 `data/research-agent-upgrade/evidence/S06/`。需要公网；不访问保留集或模型。

### 页、块与原文定位（S07）

对最新文档版本调用 `POST /api/company-research/tasks/{id}/documents/{documentId}/{version}/parse`，JSON 可指定 maxPages（默认 500，上限 1000）和 maxCharacters（默认 200 万，上限 500 万）。结果作为同一文档的新不可变版本保存；原件不改。解析器版本与配置匹配且原件相同时复用已校验缓存；变更解析器或限制会创建新版本。权限在读取原件、解析和发布前各自校验。

v1 页文本回执继续可读；v2 回执绑定原件 hash、解析器版本、总页数和稳定块，记录失败页/截断页及质量。PDF 的 filePage 始终是一基文件页；printedPage 只保留识别到的实际印刷标签，不用它替换文件页。原生 pdf-parse 没有几何坐标或结构化财务表格；不补造框。跨页段落保留两个位置，阅读时可以分别查原文。

HTML 的 locator 是 `source-range:开始:结束`，指向保留 UTF-8 原文中的字符范围，由 blockId 解析回执还原；它不是浏览器 DOM 的 CSS 选择器。不执行脚本，也不把脚本/样式当证据。此适配器仅处理静态 UTF-8 HTML；动态正文、其他编码和布局表格需后续适配。报告入库会重新核对页、块或单元格的实际原文，不能凭页上存在同一句话就认可伪造的块 ID。

HTML `source-ranges-v2` 将块间换行计入字符预算，单页最多 50 万字符、1 万块；超限保存 partial 和截断标记。版本升级后不会复用旧 HTML 解析缓存。报告发布同时检查文档和 v2 回执状态，拒绝 unreadable 或公司/年份核验失败的来源；该检查适用于财务事实、输入事实及仅含结论的报告。

复验：`node --import tsx scripts/research/verify-parsing.ts` 在八份固定公开年报上逐页解析，核对 32 条引用，检查重复 ID、截断、跨页段落和 HTML。原始输出位于 `data/research-agent-upgrade/evidence/S07/`；这是定位/合同验收，不是研究结论语义或 OCR 准确率。

### 扫描件与结构化表格（S08）

同一 parse API 增加 `engine`：`native` 只取原生文本；默认 `auto` 对空页、乱码或失败页尝试 OCR，单纯达到页数/字符上限不会触发；`docling` 强制走版面与表格服务，`ocr` 另外强制整页 OCR。服务故障保留原生文本并明确返回回退 warning。取消、超时、失败回退和失败页的最终回执允许重试；正常结果与解析设置绑定缓存。

服务是独立的 Python 3.12 CPU 进程，Docker 开发编排另提供 2 CPU/4 GiB/单槽配置。`DOCUMENT_PARSER_URL` 默认 `http://127.0.0.1:7821`，token 只在服务端使用，单任务超时默认 180 秒；平台 parse 请求总期限为 240 秒。模型预置、离线运行、缓存与启动办法见 [OCR 服务](../services/document-parser/README.md)。当前配方已完成 Linux CPU 容器验收，禁网 probe / HTTP 峰值分别约 2.14 / 1.70 GiB、无 OOM；实际取消、超时保留完成页和冷进程恢复通过，见进度 E-S08-04。既有引擎故障和失败证据保留。

输出包含真实页框、表格行列与合并跨度，保留原生 `nativeText`；不猜坐标，不自动合并跨页表。OCR 和重建表格均为 `needs_review`，报告入库会拒绝从这些块直接发布 known 财务事实。样本通过不等于任意新上传资料已经核实，业务审查工作流在后续步骤接入。

本地开发验收有三份真实/派生财报样本（18 项行、年列与金额核对）和一份明确标记的两页合成扫描压力样本；人工抽查与机器结果分别记录。`verify-ocr.ts <probe目录>` 核对前者，运行中的服务可用 `verify-parser-service.ts` 验证取消、超时、跨页和缓存；取消验收还须核实实际保留页与 cancelled_partial，不能把抢先完成算作停止成功。新人工批次可用 `prepare-ocr-review.ts <新服务证据目录>` 生成原图与实际单元格对照，保留已有抽查材料。2026-10-19 用户已逐项核对并确认本批通过，见 [E-S08-02 人工确认](plans/research-agent-upgrade/progress.md)；确认另存 acceptance.json，原对照材料保留。E-S08-04 补齐容器验收，新表格字段/坐标与已确认批次机器对照一致；合成表头“合并”识别为“合井”的已知误字未改。

### 财务口径与精确计算（S09）

`financial-normalization.ts` 识别营业收入、营业总收入、归母净利润与经营现金流净额，保留披露字符串及单位标签；元/千元/万元/亿元只规范化一次，括号表示负数，0 与缺失分开。百分数、每股单位、未知币种及破损千分位不当作金额。FinancialFact 的可选 normalization/sourceQuality/disclosure/accountingBasis/derivedFrom 字段向后兼容；有归一化结果时 schema 会重算核对。

金额用十进制字符串和 BigInt，不经浮点数相减；原始小数最多 12 位，百分比保留 6 位，按绝对值四舍五入、中点远离零。`compareFinancialFacts` 返回 comparable/missing/conflict/incomparable 及引用，核对公司、指标、合并/母公司、日历范围、累计/单季和会计/重述依据。零基数保留差额、百分比为空；负基数按冻结规则用绝对值做分母并显式注明。重述口径没有共同 accountingBasis 时拒绝比较，不替模型补假设。

`deriveSingleQuarter` 只用同年、同口径、相邻的完整累计值：Q1 本身是单季，H1−Q1、前三季−H1、全年−前三季才得到后续季度。前期缺失不能补零，来源待复核、口径不一致或期间不相邻都会拒绝。引用和 derivedFrom 保留两个输入。

后续可比报告中的前期重述值需要 `restatement: restated`、accountingBasis 和 `periodEvidence`（同一来源中的真实年份/列头引用）。单季任务的辅助累计期间由 `researchEvidencePeriods(spec)` 给出，例如 2024Q2 允许 `ytd_2024_06` 与 `ytd_2024_03`；这些 ID 可用于资料导入和检索过滤，任意其他期间仍拒绝。报告将原始累计事实放在可选 supportingFacts，最终单季事实的 derivedFrom 引用它们。提交时重算金额、期间、口径和完整来源引用，输入事实不计入最终问题覆盖。所有输入与期间标签继续受 actor、公司、asOf、原文定位和 OCR 质量检查约束；语义归属仍需 S12。

复验：`node --import tsx scripts/research/verify-financials.ts`。四家公司 24 项金额与 12 项变化复算通过，原始报告及源码/fixture hash 留在 `data/research-agent-upgrade/evidence/S09/`。这是已给定参考输入的确定性计算验收，不是模型自动抽取事实、查明会计政策或解释现金流原因的质量成绩。S08 的样本人工确认和容器验收不自动核实其他业务资料。

### 任务证据检索与分段读取（S10）

`POST /api/company-research/tasks/{id}/evidence` 接收 `{operation:"search",input:{query:"经营现金流变化",topK:5}}`，或 `{operation:"read",input:{documentId,documentVersion,locator,offset:0,maxCharacters:2000}}`。需要同源请求及 research.report.read 权限，响应为 private/no-store；可信 actor 与任务固定在服务端，不能由工具输入指定。`researchEvidenceReader(actor,taskId)` 提供相同的 search/read 接口，新财报执行器已将其注册到现有 PI 循环。

搜索先裁掉其他 actor、公司、不在任务及必要累计输入范围内的完整期间、未来或披露未知的资料，再选每个来源的最新合格时间版本。新版本 unreadable 不会被旧解析成功覆盖。可选 periodIds（最多 2）、documentIds（最多 100）缩小语料；fields 可选 revenue/parent_profit/cash_flow/risk（至少 1、最多 4），在评分前筛选块字段/风险章节。字段来自原文及相邻文本行的词法识别，是检索提示，不能当作已核实 FinancialFact。原件/解析/index 缓存读取均先校验 actor 和持久化元数据，命中缓存不跳过权限。

zh-context-bm25-v4 使用中文二元词、指标别名、相邻原文行、财务摘要/数值行及风险章节加权；先覆盖各来源期间，再按分数填充，每来源文件页最多一条。表格只以当前行和公共表头建立词频/字段，行标题不会传播到其他行；不会复用旧 v3 索引。命中仍返回真实块/表格定位、原件与解析 hash、质量、分数和片段。相邻文本逐块附带 locator，不把拼接文本伪装为原文引文。needs_review 可以被查到，但不能因此成为 known。

query 为 1—300 字符；topK 为 1—20，默认 5；maxOutputCharacters 为 1500—20000，默认 10000，以序列化字符计量，limited 表示输出受限。read 每次 100—5000 字符，通过 nextOffset 继续；只读取当前任务可用的对应版本及实际页/块/单元格。单任务最多读取 5000 个文档版本元数据、50 MB 已筛选解析语料和 10 万索引块，超限明确拒绝。它能重查超过 8 份来源之前的证据，不把全文塞入每轮模型上下文。

索引按 task/document/version/indexVersion 不可变保存，绑定 parsedSha256，正文与原件一起进入 actor 私有内容寻址存储。更改解析器或索引版本会追加新对象；取消不删除，未引用对象不自动回收。数据库迁移为 `20261019020000_research_evidence_indexes`；备份应同时保留数据库及对应文件目录，生命周期见 [数据保留规则](data-lifecycle.md)。

复验：`node --import tsx scripts/research/verify-retrieval.ts <S07解析证据目录>`；原 v1 可用 `--profile=baseline-v1` 重放。冻结四家公司/八份年报/12 个问题、24 个目标来源页、k=5，基线 10/24、v2 13/24、v3 23/24，完整覆盖问题从 2/12 到 11/12。v3 仍漏美的 2024 风险续页 p65（命中章节起始 p64），这些是在同一开发集上的调参结果；不代表保留集、语义支持率或真实 Agent 完成率。无 embedding、reranker 和模型调用，未扩大 40 次/20 分钟研究预算。原始报告与版本/hash 见进度 E-S10-01。

### 2026-09-18 本地验收

安迪苏新版任务 `8196b923-5437-4176-99ae-fa93a7439d0e`：26 步，674 秒，正式提交后状态 completed。旧任务保留。取得财务摘要、2025 年年报全文、2026 年半年报全文；没有依赖重复网络搜索找财报。共 4 次证据校验拒绝（3 次原文引用不匹配、1 次缺少报告期），都只修复对应问题，没有整篇报告结构重写。

人工对照已保存半年报第 7 页：营业收入 9,707,078,578 元、归母净利润 904,848,549 元、经营现金流净额 1,199,704,896 元，同比为 14.04%、22.25%、-17.26%。年报产品收入和上下游表已读取并引用。实名客户/供应商不在本次已核实结论内；完成状态不等于已核实全部补充信息，也不等于逐句语义自动证明。

定向验证：50 项 TypeScript 测试（含数据库隔离、检查点、SSE 事件序列、真实 PI schema 重试和硬截止模拟）、41 项 Python 测试通过。页面刷新保留步号、来源和草稿。本地交付，不含生产部署。

## 双期财报执行、报告与阅读器

新公告更新会封存上一轮预算与累计用量，再建立一轮受相同上限约束的研究预算。工作台同时展示本轮工具额度和任务累计用量。失败重试、进程恢复和计划修订继承该轮剩余额度及截止时间；重复点击和仅修改截止日期不会获得新预算。来源需要实际读取并正常提交研究结果才算完成检查，失败前未读的来源可在剩余额度内重试。

创建任务先保存 draft；`POST /api/company-research/tasks/{id}/start` 生成公开三问计划并入队。Worker 在旧研究和新任务间交替领取，按期刷新租约；过期接管读取公开检查点，不恢复模型的隐藏对话。开始时间、40 次工具与 20 分钟默认预算属于逻辑任务，接管不会重置。连续四次同参数且没有事实变化的调用会停止并保留 partial。

事实来自受授权原始财报，金额换算和比较由 decimal-v1 完成。发布同时校验身份、时间、引用原文、金额/单位/列归属与逐条语义审查。复杂多列归属不明确时需要修复，不能只凭数字在页面出现就通过。OCR 待复核仍不能成为 known。

语义审查通过独立调用执行，当前使用同一个配置模型，明确标为 separate_call_same_model。先运行 `node --import tsx scripts/research/calibrate-reviewer.ts` 生成开发资料校准回执，再在服务端环境将 `COMPANY_RESEARCH_REVIEW_CALIBRATION` 指向该回执并重启需要加载配置的 Worker。回执绑定模型与 reviewer prompt hash；没有有效回执时，引用检查通过的结论仍保留语义待审，报告为 partial。校准是开发集有限反例检查，不能作为整体语义准确率。

报告的 completed 表示机器核验完成。工作台另有人工验收记录，只有用户亲自核对数字和解释后提交，按 report revision/hash 绑定；模型工具不能执行这个动作。draft、partial、机器核验完成和人工验收分别显示。原件、报告和审查回执不原地覆盖。

| API | 行为 |
| --- | --- |
| `GET /api/company-research/tasks` | 当前用户最近 30 个版本化任务 |
| `POST /api/company-research/tasks/{id}/start` | `expectedPlanRevision`；重复入队复用已有计划 |
| `POST /api/company-research/tasks/{id}/revise` | `expectedRequestRevision`、`expectedPlanRevision`、修订字段和 `Idempotency-Key`；追加请求/计划版本并重新排队 |
| `POST /api/company-research/tasks/{id}/updates/run` | `expectedRequestRevision`、`expectedPlanRevision`、`expectedReportRevision`、`asOf` 和 `Idempotency-Key`；只对截止时点可用的新来源排入报告更新 |
| `GET /api/company-research/tasks/{id}` | 权威快照，含计划、公开检查点、资料、报告、变化表和核验信息 |
| `GET /api/company-research/tasks/{id}/events` | SSE；每次连接先发送 snapshot，research 事件使快照失效，后续快照恢复完整状态 |
| `GET /api/company-research/tasks/{id}/reports/history` | 报告版本摘要、请求/计划版本、截至时间、状态和规范化报告 hash |
| `GET /api/company-research/tasks/{id}/reports/{revision}` | 不可变报告及其对应请求规格、财务变化 |
| `GET /api/company-research/tasks/{id}/reports/{revision}/diff` | 指定报告与前一版的确定性数字、结论和引用差异；v1 无前版时返回空差异 |
| `GET /api/company-research/tasks/{id}/source` | `reportRevision`（0 为公开草稿）、`claimId` 或 `factId`、`citationIndex`；读取原引用的明确版本/hash |
| `POST /api/company-research/tasks/{id}/accept` | 用户人工验收；传 `reportRevision`、`reportHash`、`checkedNumbersAndExplanations:true` |

所有接口从认证 actor 派生归属。source 不接受任意 actor 或任意磁盘路径；历史原文不跟随最新索引切换。阅读器只渲染文本和结构化表格，外链过滤协议；逐字匹配才标黄，没有坐标时明确使用页/块/文本定位。派生扫描验收样本的 needs_review、未知披露时间必须保留。当前未采用 AG-UI SDK，也不声称协议兼容。

工作台可修订三问、年度两期和资料截止日。修订需要同时匹配请求与计划 revision；相同幂等键及内容只接受一次，版本冲突返回 409。公司身份、口径和预算不在修订字段中；切换公司请创建新任务。成功修订会追加不可变请求和计划、保留现有报告/原件、使旧 attempt 的 generation 失效并排入新计划。检查点会按新版本重建，已取得的合格文档仍留在任务中供后续检索复用。修订不增加工具额度、token 统计、原始开始时间或截止时间；原额度已耗尽时，新 attempt 仅封存 partial。快照同时提供旧报告对应的 `reportSpec`，避免把上一请求的报告误标成新版本结果。

已完成研究可显式检查巨潮公告。候选必须重新下载后才成为任务资料；同一来源的新 bytes 会成为新原件版本，但沿用旧公告日期无法证明修订 bytes 何时公开，因此会进入披露日期待核实状态。不同公告 ID 若指向同一期间、同一 bytes 和相同披露证据，会复用既有文档。模型搜索只作为候选发现，不能替代已核实官方原件。用户选择新报告截止日期后，更新入口同时检查请求、计划和报告 revision，并要求幂等键。只有来源 hash 未进入上一版报告、披露已核实且截至所选 `asOf` 可用的资料才会排队；否则返回“无新证据”，不创建报告。

更新会追加 plan revision；若截止日期改变，也追加 request revision。任务沿用原逻辑工具预算、累计用量、开始时间和 deadline。公开 checkpoint 保留受影响期间之外的事实/结论，失效受影响期间的事实与其依赖结论；保留结论仍在新 plan/asOf 下重新做语义核验。新报告完成后，报告历史按规范化 JSON hash 展示版本身份，diff API 对相邻不可变报告按指标/范围/期间、稳定 claim ID 和文档版本/hash/locator 计算变化，不调用模型编写差异或原因。支持、修订、撤回和未变化均由两版报告状态确定；缺少新报告证据时，旧报告不会被改写。

执行 `npm run test:research:postgres` 会创建专用临时 PostgreSQL，演练旧库升级、重复迁移、旧代码兼容及新链路测试；不会迁移应用数据库。追加 `-- --financial-e2e` 才调用当前真实模型，对固定茅台双期公开 PDF 运行完整语料/缺后期资料两例，并核对历史 OCR 输出的阅读器。需要受控开发资料与校准回执，费用未知；固定资料运行不等于实时公告发现全链路验收。原始结果在 `data/research-agent-upgrade/evidence/S13/`，开发步骤状态以升级目录 progress 为准。

页面组件验证可运行 `node scripts/research/serve-financial-workbench.js data/research-agent-upgrade/evidence/S13/<运行目录>`。可追加一个 PG 测试生成的 `data/research-agent-upgrade/evidence/S15/<批次>/reader-fixture.json`，检查恶意文本/链接作为数据渲染；追加 `--stream-replay` 会增加明确标注的合成事件任务，主动制造断线、重复、乱序和终态，供真实浏览器验证重连/切换。它只在回环地址启动只读 QA 页面，使用真实工作台组件、Tailwind 和已保存 repository 响应，Next Link 有测试替身；不等于完整 Next/auth/live Worker E2E，不写验收状态或调用模型。关闭该命令结束 QA 服务。当前实跑及限制见 [S11—S15 验收证据](plans/research-agent-upgrade/s11-s15-validation.md)。

### S11—S15 Review 回归加固

发布财务事实时，数值引用必须同时通过完整金额 token、单位、事实期间和明确的年份列归属。报告标题中的年份不能代替表头；倒序列可以在表头一一对应时读取，缺表头、重复年份、调整前后或百分比子列则保守拒绝。括号、ASCII/Unicode 负号和全角数字按披露符号解析，不能把负数的绝对值当成正数。

研究 Worker 传递的 attempt token 会贯穿导入、解析和文档注册。注册在任务锁内入口及原件/解析产物写入后、metadata INSERT 前再次检查任务状态、generation、worker 与 lease；取消、接管或租约过期的旧 attempt 不能留下 ready 文档。没有 Worker token 的人工管理调用保持原有兼容入口。

阅读器对引用先做 NFKC 和空白归一匹配，再映射回原文的 UTF-16 范围，因此换行、组合字符、全角字符或长页不会把上下文固定在前 9000 个字符。只有原文中存在逐字字符串时才生成 highlight；归一匹配只用于定位上下文，不伪造高亮。定向回归和 disposable PostgreSQL 验证记录在 [S11—S15 验收证据](plans/research-agent-upgrade/s11-s15-validation.md) 与 [进度交接](plans/research-agent-upgrade/progress.md)。
