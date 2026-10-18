# 公司研究

入口 `/company-research`。独立的 PI 研究任务从 DeepSeek Search/Fetch、PDF 与财务接口取得资料，研究主营业务、上下游及近期财报。报告和任务不依赖生成项目或 Next.js 构建。

## 本地启动

1. 执行 `npx prisma migrate deploy` 应用已有迁移。旧研究链路使用四张 `company_research_*` 表，财报变化基础层另加七张版本表。
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

复验：`node --import tsx scripts/research/verify-parsing.ts` 在八份固定公开年报上逐页解析，核对 32 条引用，检查重复 ID、截断、跨页段落和 HTML。原始输出位于 `data/research-agent-upgrade/evidence/S07/`；这是定位/合同验收，不是研究结论语义或 OCR 准确率。

### 扫描件与结构化表格（S08）

同一 parse API 增加 `engine`：`native` 只取原生文本；默认 `auto` 对空页、乱码或失败页尝试 OCR，单纯达到页数/字符上限不会触发；`docling` 强制走版面与表格服务，`ocr` 另外强制整页 OCR。服务故障保留原生文本并明确返回回退 warning。取消、超时、失败回退和失败页的最终回执允许重试；正常结果与解析设置绑定缓存。

服务是独立的 Python 3.12 CPU 进程，Docker 开发编排另提供 2 CPU/4 GB/单槽配置。`DOCUMENT_PARSER_URL` 默认 `http://127.0.0.1:7821`，token 只在服务端使用，单任务超时默认 180 秒；平台 parse 请求总期限为 240 秒。模型预置、离线运行、缓存与启动办法见 [OCR 服务](../services/document-parser/README.md)。本机原生环境已实跑；容器构建遇到 Docker 引擎故障，启动和资源测量仍待补，详见进度。

输出包含真实页框、表格行列与合并跨度，保留原生 `nativeText`；不猜坐标，不自动合并跨页表。OCR 和重建表格均为 `needs_review`，报告入库会拒绝从这些块直接发布 known 财务事实。样本通过不等于任意新上传资料已经核实，业务审查工作流在后续步骤接入。

本地开发验收有三份真实/派生财报样本（18 项行、年列与金额核对）和一份明确标记的两页合成扫描压力样本；人工抽查与机器结果分别记录。`verify-ocr.ts` 核对前者，运行中的服务可用 `verify-parser-service.ts` 验证取消、超时、跨页和缓存。使用 `prepare-ocr-review.ts <服务证据目录>` 生成原图与实际单元格对照，等待真人记录，不由脚本代签。

### 2026-09-18 本地验收

安迪苏新版任务 `8196b923-5437-4176-99ae-fa93a7439d0e`：26 步，674 秒，正式提交后状态 completed。旧任务保留。取得财务摘要、2025 年年报全文、2026 年半年报全文；没有依赖重复网络搜索找财报。共 4 次证据校验拒绝（3 次原文引用不匹配、1 次缺少报告期），都只修复对应问题，没有整篇报告结构重写。

人工对照已保存半年报第 7 页：营业收入 9,707,078,578 元、归母净利润 904,848,549 元、经营现金流净额 1,199,704,896 元，同比为 14.04%、22.25%、-17.26%。年报产品收入和上下游表已读取并引用。实名客户/供应商不在本次已核实结论内；完成状态不等于已核实全部补充信息，也不等于逐句语义自动证明。

定向验证：50 项 TypeScript 测试（含数据库隔离、检查点、SSE 事件序列、真实 PI schema 重试和硬截止模拟）、41 项 Python 测试通过。页面刷新保留步号、来源和草稿。本地交付，不含生产部署。
