# WolfBot 板块走势研究能力改进计划

- 状态：P0 已实施；P1 部分实施（Skill、artifacts、前端卡片）；P1 资金流与 P2 新闻催化未实施
- 计划日期：2026-09-01
- 实施基线：<code>main</code> 分支 <code>170e1d8</code>
- 触发问题：“液冷板块今天的走势如何”
- 对照模型：<code>gpt-5.6-luna</code>，reasoning effort 为 <code>max</code>

> 本文是诊断与实施计划。第 1 至 12 节记录的是实施前的诊断结论与设计意图，保留原样以便追溯；实际落地范围见下方“实施状态”。计划中的行情数字仅用于记录本次对照实验；未经 WolfBot 受控数据接口复核的数字不能作为产品事实或自动化验收夹具。

## 0. 实施状态

已实施（P0 全部）：

- <code>market_calendar.py</code>：北京时间七种交易阶段、交易日历、最近完整交易日、<code>effective_trade_date</code> 与 <code>fallback_reason</code>，时钟可注入。
- <code>market_boards.py</code>、<code>board_store.py</code>、<code>board_service.py</code>、<code>board_router.py</code>：板块解析、快照、宽度、成分，以及第 9 节的三张 SQLite 表。
- 5 条固定 FastAPI 路由与 5 个 sidecar 工具，全部在 <code>skill_mode=none</code> 下注册。
- 第 8.3 节错误码全部实现，并按白名单透传给模型作为路由依据。
- 重写对象路由系统提示词；板块最小充分证据由 sidecar 机械校验（<code>BOARD_EVIDENCE_INCOMPLETE</code>）。

已实施（P1 自足部分）：

- <code>skills/wolf-sector-research/</code> 新增，且核心板块工具不依赖该 Skill。
- 第 11 节的 <code>market_context</code>、<code>board_evidence</code>、<code>board_members</code> artifacts 与前端板块卡片、回退提示、领涨/拖累表格。

未实施：

- <code>get_board_fund_flow</code>（P1）与 <code>get_topic_catalysts</code>（P2）。二者需要额外的来源治理决策，本次未接入；因此第 14 节验收矩阵中涉及新闻的两行仍不适用。
- 多 Provider 主备切换（P1）。当前只有东方财富一个板块来源。

## 1. 结论

这次差距主要不是模型能力或 reasoning effort，而是运行环境、市场对象模型、数据源和证据契约不同。

项目内的真实 run 与独立子 Agent 都使用 <code>gpt-5.6-luna</code> 和 <code>max</code>。独立子 Agent 可以访问公开网页，先识别北京时间和 A 股交易阶段，再把“液冷板块”映射到第三方概念板块，获取板块涨跌、涨跌家数、领涨股和新闻催化。WolfBot 只能使用固定工具；现有工具只覆盖证券解析、单标的行情、技术指标和全 A 股票池，既不能解析概念板块，也没有板块行情、成分、宽度或新闻证据，所以按当前证据规则返回 <code>insufficient_evidence</code> 是符合现有契约的结果。

要获得相似且可审计的回答，不能只调整提示词或替换模型。最低可行改造是：

1. 增加北京时间市场会话与最近完整交易日解析。
2. 增加板块/主题对象解析、板块快照、市场宽度和成分股工具。
3. 让核心板块工具在 <code>skill_mode=none</code> 时仍然可用。
4. 重写对象路由和证据充分性规则，禁止把所有中文名称都交给 <code>resolve_symbol</code>。
5. 将第三方板块数据封装在 FastAPI 后端，统一限流、缓存、来源、口径、错误和持久化；模型不能传 URL。
6. 新闻催化作为增强层接入受控白名单来源，不作为回答板块涨跌的硬门槛。

## 2. 目标、边界、失败场景和验证方式

### 2.1 目标

对“某板块今天走势如何”这类问题，WolfBot 应当：

- 明确回答时点、市场时区和当前市场阶段。
- 当“今天”尚无有效行情时，自动回退到最近一个有数据的完整交易日，并写出绝对日期。
- 说明采用哪个平台、哪种板块类型和哪套成分口径。
- 至少给出板块涨跌幅、上涨/下跌家数或等价宽度指标、成分覆盖率和代表性领涨/拖累股。
- 核心行情证据可用时提交 <code>completed</code>；新闻缺失只影响催化解释，不应把基础走势回答降为证据不足。
- 对不同平台成分差异、实时性和数据覆盖给出明确限制，不将题材走势表述为投资建议。

### 2.2 本计划不做的事

- 不让模型直接浏览任意网页、传入任意 URL、执行 Shell、SQL 或第三方脚本。
- 不把某一家数据平台的“液冷板块”口径描述为唯一官方分类。
- 不因为计划增加板块数据就自动给出买入、卖出或收益承诺。
- 不在本次文档任务中实现代码、迁移数据库、安装依赖、提交或推送。
- 不把本次独立子 Agent 报出的具体行情数字固化为长期测试期望。

### 2.3 需要明确区分的失败场景

| 场景 | 产品行为 |
| --- | --- |
| 查询可映射到唯一板块，核心行情和宽度可用 | 返回 <code>completed</code> |
| 查询映射到多个行业/概念口径 | 返回候选口径；能根据“板块/概念/行业”等上下文确定时继续，否则要求用户澄清 |
| 当前日期尚未开盘或为非交易日 | 回退到最近完整交易日，明确原始请求日期和实际数据日期 |
| 上游连接失败、限流或响应畸形 | 报告上游不可用，不得伪装成“无此板块”或空数据 |
| 板块存在但成分覆盖不足 | 可返回带覆盖警告的结果；低于硬门槛时才提交 <code>insufficient_evidence</code> |
| 只有新闻、没有板块量价和宽度 | 返回 <code>insufficient_evidence</code>，新闻不能替代行情 |
| 有板块量价和宽度、没有新闻 | 返回 <code>completed</code>，催化部分标为未验证或省略 |

### 2.4 验证方式

- 使用固定时钟覆盖盘前、盘中、午间休市、盘后、周末/休市日。
- 以原问题“液冷板块今天的走势如何”作为真实 Provider 回归用例。
- 分别验证 <code>skill_mode=none</code>、<code>auto</code> 和显式板块 Skill。
- 自动校验终端提交引用的精确成功 <code>tool_call_id</code>。
- 注入上游断线、429、空页、畸形 JSON、成分覆盖不足和过期缓存。
- 只有核心板块数据确实不可获得时，才允许该回归用例以 <code>insufficient_evidence</code> 通过。

## 3. 对照实验

### 3.1 WolfBot 真实 run

本地 SQLite 中存在原问题的完整运行记录：

| 字段 | 值 |
| --- | --- |
| Run ID | <code>827cfa8cf8fd40d4904d6c3744f6dc49</code> |
| 问题 | 液冷板块今天的走势如何 |
| 模型 | <code>gpt-5.6-luna</code> |
| Reasoning effort | 本地配置为 <code>max</code> |
| Skill 模式 | <code>none</code> |
| 开始时间 | 2026-09-01 01:46:24（北京时间；数据库为 2026-08-31T17:46:24Z） |
| 终态 | <code>insufficient_evidence</code> |

真实工具轨迹为：

1. <code>resolve_symbol({"query":"液冷板块"})</code> 返回 HTTP 400。
2. <code>resolve_symbol({"query":"液冷"})</code> 再次返回 HTTP 400。
3. 第一次提交 <code>insufficient_evidence</code> 时，<code>dataAsOf:null</code> 触发历史运行中的 <code>INVALID_TOOL_INPUT</code>。
4. <code>get_universe_summary</code> 成功，但它只能证明全 A 股票池覆盖情况。
5. 最终仅引用全 A 股票池摘要，提交 <code>insufficient_evidence</code>。

最终回答的核心意思是：当前数据只覆盖 A 股个股行情，没有可查询的液冷板块指数或经验证的成分股集合，因此无法确认板块走势。

<code>dataAsOf:null</code> 的解析问题不是证据不足的根因，只是增加了一轮无效调用。当前代码已经有显式的 null 守卫，但测试中还应保留这个历史输入作为回归，防止 Schema 与运行时解析再次漂移。

### 3.2 独立 Luna Max 子 Agent

按用户要求，本会话另启独立子 Agent，使用 <code>gpt-5.6-luna</code> 和 <code>max</code>，原样提问“液冷板块今天的走势如何”。其回答首先指出查询时间是北京时间 2026-09-01 02:01，A 股 9 月 1 日尚未开盘，因此改为说明最近交易日 2026-08-31 的收盘表现。

它给出的回答要点是：

- 将“液冷服务器概念”映射到东方财富常用口径 <code>BK1138</code>。
- 判断 2026-08-31 板块明显强势，声称板块涨幅超过 3%、约 140 只个股上涨。
- 列出荣亿精密、冠龙节能、康盛股份、浪潮信息等强势股。
- 使用液冷订单、AI 芯片功耗和相关产线消息解释催化。
- 明确说明不同平台的板块成分口径不同，且 8 月 31 日的表现不能证明 9 月 1 日必然继续上涨。

子 Agent 引用的公开页面：

- [东方财富 BK1138 页面](https://quote.eastmoney.com/bk/90.BK1138.html?jump_to_web=true)
- [财联社相关盘面报道](https://www.cls.cn/detail/2469628)
- [证券时报相关产业报道](https://stcn.com/article/detail/4165081.html)

这些数字是“独立 Agent 回答了什么”的实验记录，不是 WolfBot 已验证数据。本机随后尝试独立访问东方财富数据接口时连接被远端断开，包括关闭环境代理后的重试，因此本计划不宣称已复核“超过 3%”或“约 140 只上涨”等数字。实施验收必须从受控 Provider 响应生成断言，而不是复制这次回答。

### 3.3 对照的有效性

这是一次用于定位能力边界的对照诊断，不是严格的模型 A/B 测试：

- 已控制：模型名称、reasoning effort、问题文本和相近查询时点。
- 未控制：系统提示词、可用工具、网络权限、数据缓存、上下文和终端证据规则。

正是这些未控制变量解释了主要差距。项目若只把模型换成 Luna Max，而不补齐工具和数据契约，结果仍会是证据不足。

## 4. 根因矩阵

| 层级 | 当前事实 | 对回答的影响 | 优先级 |
| --- | --- | --- | --- |
| 模型 | 项目和独立 Agent 都是 Luna Max | 不是主要差异来源 | 结论项 |
| 运行环境 | 独立 Agent 可查公开网页；sidecar 只能调用固定 FastAPI 工具 | 无法发现板块代码、行情和新闻 | P0 |
| 对象模型 | <code>resolve_symbol</code> 只解析股票、指数、ETF 等证券 | “液冷板块”被错误当成单一证券 | P0 |
| 提示词 | 系统提示要求所有名称先走 <code>resolve_symbol</code>，只描述单标的趋势流程 | 模型被引导到必然失败的工具路径 | P0 |
| 市场时点 | 没有北京时间交易阶段和最近完整交易日工具 | 无法正确解释“今天尚未开盘” | P0 |
| 数据层 | 没有板块目录、快照、成分、宽度和资金流 | 无法量化“强/弱、普涨/分化” | P0/P1 |
| Skill | <code>wolf-investing</code> 明确排除行业、概念、资金和新闻 | 自动加载现有 Skill 也会按约定返回证据不足 | P1 |
| 证据规则 | 现有证据充分性围绕单标的 K 线和股票池 | 没有板块问题的最小充分证据定义 | P0 |
| 新闻能力 | 无受控新闻或公告来源 | 无法解释催化，但不应阻断基础走势 | P2 |
| 错误语义 | HTTP 400、上游失败和“对象不存在”缺少板块专用分类 | 模型难以决定改路由、回退还是结束 | P0 |
| 展示层 | 只有通用答案、证据和候选股展示 | 无法清楚呈现板块口径、宽度和领涨/拖累 | P1 |

## 5. 目标回答契约

当查询时间为 2026-09-01 02:01（北京时间）且最近完整交易日为 2026-08-31 时，回答结构应接近：

> 截至 2026-09-01 02:01，A 股当日尚未产生可用盘中行情。以下采用最近完整交易日 2026-08-31，并按“某数据源的液冷服务器概念”口径说明。
>
> 板块当日涨跌幅为 X%，上涨 Y 家、下跌 Z 家，成分覆盖率为 C%；整体属于强势上行/震荡分化/弱势下行。领涨股包括 A、B，主要拖累包括 C、D。
>
> 若存在受控新闻证据，再补充已验证的催化；否则写明“本次只验证了行情，未验证新闻原因”。不同平台的成分口径可能不同，不能据此推断下一交易日表现。

最终提交至少包含以下结构化字段：

~~~json
{
  "market_context": {
    "timezone": "Asia/Shanghai",
    "observed_at": "2026-09-01T02:01:00+08:00",
    "phase": "pre_open",
    "requested_date": "2026-09-01",
    "effective_trade_date": "2026-08-31",
    "fallback_reason": "current_session_has_no_market_data"
  },
  "board": {
    "board_id": "opaque-provider-board-id",
    "name": "液冷服务器",
    "board_type": "concept",
    "provider": "provider-name",
    "constituent_basis": "provider-defined"
  },
  "snapshot": {
    "change_pct": 0,
    "snapshot_at": "provider timestamp",
    "source": "provider-name",
    "data_quality": "complete"
  },
  "breadth": {
    "advancers": 0,
    "decliners": 0,
    "unchanged": 0,
    "covered_members": 0,
    "total_members": 0,
    "coverage_pct": 0
  },
  "leaders": [],
  "laggards": [],
  "catalysts": [],
  "limitations": []
}
~~~

字段值必须来自工具结果；模型只负责组织和解释，不能自行补算缺失的成分或行情。

## 6. 目标数据流

~~~text
User question
  |
  v
PI sidecar
  |-- get_market_session_context
  |-- route by market object kind
  |     |-- stock/index/ETF -> resolve_symbol
  |     +-- industry/concept/theme/region -> resolve_board
  |-- get_board_snapshot + get_board_breadth
  |-- get_board_members (leaders/laggards)
  |-- optional get_board_fund_flow
  |-- optional get_topic_catalysts
  v
FastAPI fixed /api/v1 endpoints
  |-- market calendar and session policy
  |-- board provider interface, cache and failure classification
  |-- SQLite board identity, membership and snapshots
  |-- optional whitelisted news adapters
  v
Governed upstream providers
~~~

sidecar 仍然不访问 SQLite、任意文件或任意网络。所有 URL、请求方法、query key、来源凭据、限流和重试都由 FastAPI 固定。

## 7. 市场时点与对象路由

### 7.1 市场会话上下文

新增 <code>get_market_session_context</code>，由后端根据 <code>Asia/Shanghai</code>、交易日历和可配置交易时段返回：

- <code>pre_open</code>
- <code>opening_auction</code>
- <code>morning_session</code>
- <code>lunch_break</code>
- <code>afternoon_session</code>
- <code>post_close</code>
- <code>non_trading_day</code>

同时返回：

- <code>observed_at</code>
- <code>calendar_date</code>
- <code>is_trading_day</code>
- <code>latest_completed_trade_date</code>
- <code>effective_trade_date</code>
- <code>fallback_reason</code>

“今天”不是简单替换为服务器日期。盘前和非交易日默认使用最近完整交易日；盘中使用当前快照，并明确数据仍在变化；盘后只有在收盘快照完整时才使用当日。

### 7.2 市场对象分类

在规划工具前先区分：

- <code>stock</code>
- <code>index</code>
- <code>etf</code>
- <code>industry</code>
- <code>concept</code>
- <code>theme</code>
- <code>region</code>

显式包含“板块、概念、行业、赛道、主题”的查询优先进入板块路由。<code>resolve_symbol</code> 只处理可交易证券或指数；<code>resolve_board</code> 处理行业、概念、主题和地域板块。解析响应需包含候选、匹配依据、别名、板块类型、来源和置信度，不能只返回 HTTP 400。

## 8. 固定工具与 API

### 8.1 始终可用的核心工具

这些工具属于市场基础能力，在 <code>skill_mode=none</code> 下也必须注册：

| Sidecar 工具 | 固定 FastAPI 路由 | 最小用途 |
| --- | --- | --- |
| <code>get_market_session_context</code> | <code>GET /api/v1/market/session</code> | 解析北京时间、市场阶段和有效交易日 |
| <code>resolve_board</code> | <code>GET /api/v1/boards/resolve</code> | 将名称/别名解析为板块对象 |
| <code>get_board_snapshot</code> | <code>GET /api/v1/boards/{board_id}/snapshot</code> | 读取涨跌、时点、来源和口径 |
| <code>get_board_breadth</code> | <code>GET /api/v1/boards/{board_id}/breadth</code> | 读取涨跌家数、覆盖率和分布 |
| <code>get_board_members</code> | <code>GET /api/v1/boards/{board_id}/members</code> | 读取成分及领涨/拖累排序 |

### 8.2 增强工具

| Sidecar 工具 | 固定 FastAPI 路由 | 约束 |
| --- | --- | --- |
| <code>get_board_fund_flow</code> | <code>GET /api/v1/boards/{board_id}/fund-flow</code> | 仅在来源、时间和计算口径明确时启用 |
| <code>get_topic_catalysts</code> | <code>GET /api/v1/boards/{board_id}/catalysts</code> | 只查后端白名单来源，返回标题、发布时间、来源和关联理由 |

模型输入只允许板块 ID、日期、排序、方向和有限条数等枚举字段。模型不能输入 origin、URL、path、任意 query key、Cookie 或请求头。

### 8.3 建议错误码

| 错误码 | 含义 | Agent 行为 |
| --- | --- | --- |
| <code>BOARD_NOT_FOUND</code> | 受支持来源中没有匹配对象 | 查看候选或说明口径缺失 |
| <code>AMBIGUOUS_BOARD</code> | 多个高相似候选 | 使用上下文选择或请求澄清 |
| <code>UPSTREAM_UNAVAILABLE</code> | 连接、超时或 5xx | 可使用满足新鲜度要求的缓存，否则证据不足 |
| <code>UPSTREAM_RATE_LIMITED</code> | 429 或限流信号 | 尊重退避，不在 Agent 循环中连续重试 |
| <code>NO_SESSION_DATA</code> | 当前时段尚无有效数据 | 使用会话工具给出的最近完整交易日 |
| <code>STALE_BOARD_DATA</code> | 数据超过允许新鲜度 | 明确过期；按问题类型决定是否终止 |
| <code>INSUFFICIENT_COVERAGE</code> | 成分宽度覆盖低于硬门槛 | 返回覆盖明细并提交证据不足 |
| <code>UPSTREAM_INVALID_RESPONSE</code> | 空页、畸形 JSON 或字段缺失 | 不得转换为“板块不存在” |

## 9. 后端数据模型与来源治理

### 9.1 SQLite 最小表

新增或等价实现以下持久化结构：

<code>market_boards</code>

- <code>id</code>：内部不透明 ID。
- <code>provider</code>、<code>provider_board_code</code>。
- <code>name</code>、<code>normalized_name</code>、<code>aliases_json</code>。
- <code>board_type</code>、<code>definition</code>、<code>constituent_basis</code>。
- <code>source_url_hash</code> 或可审计来源标识，不持久化凭据。
- <code>active</code>、<code>fetched_at</code>、<code>updated_at</code>。

<code>market_board_memberships</code>

- <code>board_id</code>、<code>symbol</code>。
- <code>valid_from</code>、<code>valid_to</code>。
- <code>source</code>、<code>as_of</code>、<code>fetched_at</code>。
- 唯一约束和索引应支持按板块、日期查询有效成分。

<code>market_board_snapshots</code>

- <code>board_id</code>、<code>trade_date</code>、<code>snapshot_at</code>、<code>market_phase</code>。
- 开、高、低、当前/收盘、<code>change_pct</code>、成交额等上游实际提供字段。
- <code>advancers</code>、<code>decliners</code>、<code>unchanged</code>、涨跌停家数。
- <code>covered_members</code>、<code>total_members</code>、<code>coverage_pct</code>。
- <code>source</code>、<code>data_quality</code>、<code>fetched_at</code>。

如上游快照不直接提供宽度，后端可从同一时点的有效成分与个股快照计算，但必须持久化计算时点、输入覆盖率和算法版本。不能把不同日期或不同来源的成分与行情静默混合。

### 9.2 Provider 接口

在 <code>market_data.py</code> 或独立板块模块中定义受控 Provider 接口，至少拆分：

- 板块目录/别名。
- 板块快照。
- 板块成分。
- 成分行情或宽度。
- 可选资金流。
- 可选新闻催化。

东方财富可作为首个板块数据来源，但必须集中实现会话复用、串行/受限并发、最小间隔、抖动、429/5xx 退避、超时、响应大小限制和结构校验。接口连接失败时应优先返回明确上游错误或合格缓存，不能返回空列表伪装成功。

后续主备源必须通过统一字段契约接入。降级时必须保留 <code>provider</code> 和 <code>constituent_basis</code>，不能把不同平台口径拼成一个看似连续的时间序列。

### 9.3 缓存和新鲜度

- 板块目录和别名：低频刷新，可使用较长缓存。
- 板块成分：按交易日或来源变更刷新。
- 盘中快照和宽度：短 TTL，并返回 <code>snapshot_at</code>。
- 盘后完整快照：落库后可长期复用。
- 新闻：按发布时间和 URL/内容摘要去重，保留来源抓取时间。

每个接口均返回 <code>source</code>、<code>as_of</code>/<code>snapshot_at</code>、<code>fetched_at</code>、<code>data_quality</code>、<code>coverage</code> 和 <code>warnings</code>。

## 10. Sidecar、Skill 与证据规则

### 10.1 系统提示词

替换当前“所有名称先用 <code>resolve_symbol</code>”的绝对规则，改为：

1. 先用 <code>get_market_session_context</code> 解释“今天、昨日、最近”等相对日期。
2. 根据问题对象选择 <code>resolve_symbol</code> 或 <code>resolve_board</code>。
3. 板块走势优先获取快照和宽度，再按需要获取领涨/拖累。
4. 新闻和资金只用于解释，不得替代板块核心行情。
5. 上游失败只允许按错误码进行一次合规回退，禁止猜测新 URL 或参数。

### 10.2 Skill 策略

建议新增 <code>skills/wolf-sector-research/</code>：

- 定义板块趋势的分析顺序、强弱/宽度解释和限制措辞。
- 提供字段契约，例如成分覆盖、资金流口径和新闻证据规则。
- 不包含凭据、私有 URL、任意网络能力或硬编码当日行情。

但 <code>resolve_board</code>、市场会话、快照、宽度和成分工具不能依赖这个 Skill 才出现。否则用户选择“不使用 Skill”时会再次复现本问题。<code>auto</code> 模式可加载该 Skill 以获得更完整的催化和风险解释。

现有 <code>wolf-investing</code> 应继续保持其单标的边界，或在版本升级时明确链接到板块 Skill；不要静默放宽原有字段契约。

### 10.3 板块问题的最小充分证据

提交 <code>completed</code> 至少需要：

1. 成功解析的板块身份、板块类型和来源口径。
2. 明确的市场阶段、有效交易日期和数据时点。
3. 板块涨跌或等价强弱指标。
4. 上涨/下跌家数或等价宽度，以及成分覆盖率。

领涨/拖累股属于推荐证据，新闻和资金流属于增强证据。只有第 1 至 4 项无法达到门槛时，才应提交 <code>insufficient_evidence</code>。

终端证据必须逐项引用成功工具结果的精确 <code>tool_call_id</code>。回答中的数字需要能追溯到板块快照、宽度或成分工具，不能只引用全 A 股票池摘要。

## 11. 前端与 artifacts

新增板块专用 artifacts：

| Artifact | 内容 |
| --- | --- |
| <code>market_context</code> | 市场阶段、查询时点、请求日期、回退日期和原因 |
| <code>board_evidence</code> | 板块身份、口径、快照、宽度、覆盖和来源 |
| <code>board_members</code> | 领涨、拖累及成分排序 |
| <code>board_fund_flow</code> | 可选资金流及口径 |
| <code>news_evidence</code> | 可选白名单新闻、时间和关联理由 |

Agent 页面增加：

- “当日尚未开盘，已回退至 2026-08-31”之类的醒目提示。
- 板块涨跌、上涨/下跌家数、覆盖率和数据时点卡片。
- 领涨/拖累表格。
- 资金流和新闻催化的可选区域。
- 板块来源及“不同平台成分可能不同”的限制说明。

通用 Markdown 回答仍保留；结构化卡片不能隐藏数据过期、覆盖不足或来源降级警告。

## 12. 分阶段实施

### P0：让基础走势可以回答

1. 增加市场会话/交易日历服务和固定时钟测试。
2. 增加板块目录、解析、快照、宽度、成分 Provider 与最小 SQLite 表。
3. 增加五个核心 FastAPI 路由和 sidecar 工具。
4. 重写对象路由提示词和板块最小充分证据规则。
5. 在 <code>skill_mode=none</code> 下完成原问题的 <code>completed</code> 回归。
6. 增加 <code>dataAsOf:null</code>、上游断线、板块歧义和覆盖不足回归。

P0 完成后，产品应能给出带绝对日期、板块涨跌、宽度、领涨/拖累和口径限制的回答，即使没有新闻。

### P1：提高可靠性和解释力

1. 完善板块成分历史、盘后快照和缓存恢复。
2. 增加资金流工具及明确口径。
3. 新增 <code>wolf-sector-research</code> Skill。
4. 增加板块 artifacts 和前端卡片。
5. 增加 Provider 主备切换，但禁止跨口径静默拼接。

### P2：受控新闻催化

1. 接入白名单新闻来源，统一去重、发布时间和来源标识。
2. 建立“新闻与板块关联理由”字段，避免仅按关键词硬贴标签。
3. 对催化解释增加多源交叉验证和时间先后检查。
4. <code>auto</code> 模式可追加催化；新闻不可用时基础走势仍应完成。

## 13. 预计影响文件

实施时至少检查或修改：

- <code>wolf-dashboard/backend/app/market_router.py</code>
- <code>wolf-dashboard/backend/app/market_data.py</code>
- <code>wolf-dashboard/backend/app/market_store.py</code>
- <code>wolf-dashboard/backend/app/agent_service.py</code>
- 新的市场日历/板块 Provider 模块
- <code>wolf-dashboard/backend/tests/</code>
- <code>wolf-dashboard/agent-sidecar/src/tools.ts</code>
- <code>wolf-dashboard/agent-sidecar/src/run-engine.ts</code>
- <code>wolf-dashboard/agent-sidecar/test/</code>
- <code>wolf-dashboard/frontend/agent.js</code>、<code>agent.html</code>、<code>agent.css</code>
- 新的 <code>skills/wolf-sector-research/</code>
- <code>wolf-dashboard/README.md</code>
- <code>docs/PROJECT_MAP.md</code>

实现若以 <code>feat</code> 或 <code>fix</code> 提交，还必须按仓库规范同步 <code>CHANGELOG.md</code>、<code>COMMIT_LOG.md</code> 和唯一变更 ID。本次只新增计划文档，未获授权提交，因此不更新提交日志。

## 14. 验收矩阵

| 用例 | 模式 | 期望 |
| --- | --- | --- |
| 2026-09-01 02:01 问“液冷板块今天的走势如何” | <code>none</code> | 明确 9 月 1 日尚无行情，回退到 8 月 31 日；核心数据可用时为 <code>completed</code> |
| 同一问题 | <code>auto</code> | 在基础走势上可追加板块 Skill 和已验证催化 |
| 盘中同一问题 | <code>none</code> | 使用当日快照，明确仍在变化和 <code>snapshot_at</code> |
| 周末问“今天” | 任意 | 回退到最近完整交易日，不把周末日期写成交易日 |
| “液冷概念”和“液冷行业”同时存在 | 任意 | 返回口径候选或按明确语义选择，不交给证券解析器 |
| 板块快照成功、新闻失败 | <code>auto</code> | <code>completed</code>，新闻部分说明不可用 |
| 新闻成功、板块快照失败且无合格缓存 | <code>auto</code> | <code>insufficient_evidence</code> |
| 上游连接被断开 | 任意 | 返回 <code>UPSTREAM_UNAVAILABLE</code>，不声称板块不存在 |
| 成分只覆盖少量股票 | 任意 | 展示覆盖率；低于门槛时证据不足 |
| <code>submit_analysis</code> 使用 <code>dataAsOf:null</code> | 任意 | Schema 与运行时解析一致，不产生内部类型错误 |
| 终端引用不存在或失败的 call ID | 任意 | 以 <code>INVALID_EVIDENCE_REFERENCE</code> 拒绝 |

真实 Provider 验收必须记录：

- run ID、模型、reasoning effort、Skill 模式和绝对查询时间。
- 每个市场工具的成功/失败、错误码和精确 call ID。
- 板块来源、口径、有效交易日、快照时间和覆盖率。
- 最终状态与回答。
- 上游数字是否经过独立来源复核；未复核时明确说明。

## 15. 完成标准

本计划的实现只有在以下条件全部满足时才算完成：

- 原问题在板块核心数据可用时不再因为工具缺失返回证据不足。
- 盘前、盘中、盘后和非交易日都使用明确的北京时间与绝对日期。
- <code>none</code> 模式具备基础板块走势能力，Skill 只增强方法和解释。
- 板块身份、行情、宽度、成分和可选新闻均有来源、时点、口径和覆盖信息。
- 上游失败、无匹配、无当前时段数据和覆盖不足有不同错误语义。
- 模型不能传 URL，也不能访问任意网络、SQLite、文件或 Shell。
- 自动测试、项目级检查和真实 Provider 回归通过，且不会把正常可用数据下的 <code>insufficient_evidence</code> 当作通过。
- README、项目全景图、变更记录和提交日志按实际实现同步。
