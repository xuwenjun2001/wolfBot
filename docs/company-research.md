# 公司研究

入口 `/company-research`。独立的 PI 研究任务从 DeepSeek Search/Fetch、PDF 与财务接口取得资料，研究主营业务、上下游及近期财报。报告和任务不依赖生成项目或 Next.js 构建。

## 本地启动

1. 执行 `npx prisma migrate deploy`，新增四张 `company_research_*` 表。
2. 在不提交的 `.env.local` 配置研究模型的 `COMPANY_RESEARCH_API_KEY` 与 DeepSeek 官方密钥 `COMPANY_RESEARCH_SEARCH_API_KEY`。搜索密钥未单独设置时复用 `DEEPSEEK_API_KEY`。
3. 默认网关为 `https://sub2api.380001.xyz/v1`，模型为 `gpt-5.6-luna`，推理强度为 `max`。可通过 `COMPANY_RESEARCH_BASE_URL`、`COMPANY_RESEARCH_MODEL` 指定服务端配置；不自动降级模型。
4. `npm run dev` / `npm run dev:background` 自动管理研究 worker。也可单独运行 `npm run worker:research`；单任务运行用 `npm run worker:research:once`。

生产部署时需要独立运行研究 worker，并提供同一数据库和服务端密钥。本次功能不自动部署生产。

搜索与正文读取分别调用 DeepSeek 官方 `POST https://api.deepseek.com/v1/tools/search` 和 `POST https://api.deepseek.com/v1/tools/fetch`，独立于研究模型网关。搜索每次最多返回 5 条；通过 `site:` 和 `before:` 传递域名与日期条件，并再次核对返回域名和发布日期。`before:` 使用截止日次日，包含研究截止日当天。查询词与条件合计最多 128 个 Unicode 字符，超限时要求缩短查询或减少域名，不截断过滤条件。搜索结果仅用于发现资料，引用仍需读取并保存正文；Fetch 无法读取 PDF 时沿用本地下载解析兜底。迁移后搜索缓存按 provider 区分，已有正文快照继续可用。

## 预算

仅保留 `COMPANY_RESEARCH_MAX_CALLS=40` 和 `COMPANY_RESEARCH_TIMEOUT_MS=1200000`（20 分钟）两项运行预算。补查轮次、来源数量及累计输入/输出 tokens 不限制；旧的 MAX_ROUNDS、MAX_INPUT_TOKENS、MAX_OUTPUT_TOKENS 配置不再生效。token 使用量仍记录。单次模型响应和上下文长度仍受模型技术限制。重启恢复不重置调用次数和开始时间。

## 数据与恢复

任务包含不可变公司身份、截止时间、研究状态及逐步 trace；每次工具开始和结束均以持久事务生成事件。来源包含原文快照、SHA-256、获取时间和可得的发布时间。报告包含逐条结论、原文引用和指标口径。

worker 采用 PostgreSQL 原子领取、60 秒 lease、10 秒 heartbeat 和 generation fencing；重启后以最近已提交的研究状态、草稿和资料恢复，不持久化或恢复隐藏推理。中断的工具显示失败，下一次调用另起步号。只读外部请求在崩溃边界可能重发，报告提交由同一任务事务覆盖，避免重复交付。

权限复用 `research.report.read/run`，所有 API 按当前用户过滤。SSE 使用事件序号续传。取消保留资料和草稿。

## 验收边界

平台确定性检查报告结构、已读取 source ID、原文引用存在性和已知发布日期。它不能仅凭字符串校验保证模型结论语义正确，需通过真实公司样例人工核查。正文未提供发布日期时保留为空，由研究过程根据文档确认报告期。扫描 PDF 暂不做 OCR，正文快照上限 350,000 字符（模型按主题接收有界片段），PDF 最多前 100 页；相关限制必须体现在部分报告中。

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


### 2026-09-18 本地验收

安迪苏新版任务 `8196b923-5437-4176-99ae-fa93a7439d0e`：26 步，674 秒，正式提交后状态 completed。旧任务保留。取得财务摘要、2025 年年报全文、2026 年半年报全文；没有依赖重复网络搜索找财报。共 4 次证据校验拒绝（3 次原文引用不匹配、1 次缺少报告期），都只修复对应问题，没有整篇报告结构重写。

人工对照已保存半年报第 7 页：营业收入 9,707,078,578 元、归母净利润 904,848,549 元、经营现金流净额 1,199,704,896 元，同比为 14.04%、22.25%、-17.26%。年报产品收入和上下游表已读取并引用。实名客户/供应商不在本次已核实结论内；完成状态不等于已核实全部补充信息，也不等于逐句语义自动证明。

定向验证：50 项 TypeScript 测试（含数据库隔离、检查点、SSE 事件序列、真实 PI schema 重试和硬截止模拟）、41 项 Python 测试通过。页面刷新保留步号、来源和草稿。本地交付，不含生产部署。
