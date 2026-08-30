# WolfBot Agent MVP 实施计划

- 状态：待实施
- 计划日期：2026-08-29
- 目标版本：WolfBot Agent MVP 0.1.0
- 实施基线：`main` 分支当前 Wolf Dashboard 代码
- 参考基线：QuantPilot `2015ecdc8f3d891f81ff0a5a8d42a2d2f2dd0a5c`

> 本文是实施计划，不表示所列能力已经完成。只有通过文末 MVP 验收门槛的能力，才能作为已实现功能写入项目说明或简历。

## 1. 目标与最小闭环

WolfBot 从现有的发言监控仪表盘扩展为一个可安装投资策略 skill、可自主调用行情工具并基于证据回答的本地 Agent 项目。MVP 必须完成以下闭环：

1. 用户提出独立的研究问题，并选择“自动选择 skill”“指定 skill”或“不使用 skill”。
2. Agent 根据问题决定要加载的 skill 和需要获取的数据，自主执行多轮只读工具调用。
3. 系统能够解析股票、指数和 ETF，获取实时行情、前复权日 K 与技术指标，并展示数据来源和时间。
4. 对“根据条件找股票”的问题，Agent 能在明确股票池中执行确定性的全池筛选，再对候选进行行情验证，而不是逐只猜测或仅凭模型知识回答。
5. Agent 只有在证据充分时才能提交结论；证据不足时必须提交结构化的 `insufficient_evidence`。
6. 用户可以查看工具轨迹、证据、最终回答和候选标的 K 线，但看不到或持久化模型的隐藏推理。
7. 现有发言检查与策略总结功能完整保留，并迁移到独立的 `/monitor` 页面。

### 1.1 MVP 用户故事

MVP 至少支持以下四类请求：

- 单标的研究：“分析贵州茅台最近 120 个交易日的趋势和回撤。”
- 指数或 ETF 研究：“给我上证指数最近半年的 K 线和均线状态。”
- 条件选股：“筛选全 A 股中 MA5 > MA10 > MA20、近 20 日涨幅超过 8%、成交额高于 20 日均额 1.2 倍的股票，排除 ST，列出前 10 只。”
- 策略 skill 问答：“按 wolf-investing 的方法分析宁德时代；信息不足时继续取数，直到能给出结论或说明证据不足。”

每次提问都是独立研究任务。MVP 不把上一轮问题、回答或候选股票作为下一轮的隐式上下文。

### 1.2 不在 MVP 范围内

- 自动交易、模拟下单、账户连接或收益承诺。
- 让 skill 执行 Shell、任意脚本、文件写入或任意网络请求。
- 依赖未接入的数据回答财务质量、估值、行业概念、主力资金、新闻催化或公告影响。
- 通用自然语言到任意 SQL、Python 或表达式执行。
- 长期对话记忆、多用户权限、云端部署、分布式数据库和 ClickHouse。
- 用模型补造缺失行情、把旧数据伪装成最新数据，或把“符合筛选条件”表述为“建议买入”。

## 2. 关键产品决策

| 事项 | MVP 决策 |
| --- | --- |
| 运行形态 | FastAPI 主服务继续监听 `127.0.0.1:8787`；新增长期运行的 TypeScript PI Agent sidecar，监听 `127.0.0.1:8790` |
| Agent SDK | 固定 `@earendil-works/pi-agent-core@0.82.1` 和 `@earendil-works/pi-ai@0.82.1`，版本与参考 QuantPilot 一致 |
| 请求上下文 | 每次请求独立，不继承跨任务聊天历史 |
| skill 来源 | 仓库内置 skill，以及用户上传的本地 `.zip`、`.tgz`、`.tar.gz` 包 |
| skill 路由 | 默认自动选择一个已启用 skill；用户可手工覆盖或明确选择“不使用 skill” |
| 市场数据 | 腾讯提供实时报价和前复权日 K；东财只用于证券搜索与股票池导入；本地 SQLite 保存证券、日线和派生特征 |
| 全市场筛选 | 固定策略复用 QuantPilot screener；自定义条件使用白名单 DSL 和专用 `screen_stocks` 工具 |
| 页面 | `/` 为 Agent 工作台，`/skills` 为 skill 管理，`/monitor` 保留现有仪表盘 |
| 运行并发 | MVP 同一时间只允许一个活动 Agent run |
| 终态 | Agent 必须调用终端工具提交 `completed` 或 `insufficient_evidence`；未调用终端工具即为运行失败 |
| 可观测性 | 保存工具名、规范化参数、耗时、结果摘要和证据引用；不保存隐藏思维链 |

## 3. 优先复用 QuantPilot

实现每一项功能前，先核对下表对应的 QuantPilot 文件。能够裁剪复用时保留其契约、安全边界和测试思想，不在 WolfBot 中重新设计另一套不兼容机制。

| WolfBot 能力 | 优先参考的 QuantPilot 实现 | 复用范围 |
| --- | --- | --- |
| PI Agent 循环与终端提交 | `src/lib/agent/pi/run-engine.ts`、`docs/pi-agent.md` | Agent 生命周期、工具回灌、预算、超时、终端工具约束 |
| OpenAI-compatible Provider | `src/lib/agent/providers/openai-compatible.ts` | Provider 消息和工具调用适配；沿用 WolfBot 现有环境变量语义 |
| 本地行情工具白名单 | `src/lib/domains/finance/agent-tools/quant-api.ts` | 固定 origin、路径 allowlist、请求次数、响应大小和超时限制 |
| skill 编译与按需加载 | `src/lib/agent/skills/compiler.ts` | skill 元数据、按需加载、引用读取和提示注入边界 |
| skill 安装治理 | `src/lib/quant/skills-admin.ts`、`docs/skills-governance.md` | 压缩包校验、路径穿越防护、哈希、启停和卸载 |
| 股票池与条件选股 | `services/market-data/.../repositories/universes.py`、`repositories/screener.py`、`routers/research.py` | universe、数据覆盖、安全过滤、固定模式、候选响应和结构化空结果 |
| 宽域选股调度 | `src/lib/quant/data-prefetch.ts` | 宽域问题识别、先筛选再补充候选行情、空候选处理 |
| K 线图 | `src/app/strategy-platform/StockKlineDetail.tsx` | 蜡烛、成交量、均线、选中状态和响应式尺寸的交互设计 |
| 数据 Agent 边界 | `docs/data-agent-architecture.md` | Agent 只通过受控 API 访问数据，不直接访问数据库 |

QuantPilot 使用 MIT License。若实现阶段实质性改编代码，必须保留必要版权信息，并在仓库新增 `THIRD_PARTY_NOTICES.md` 记录来源、commit、许可证和改编文件。

## 4. 总体架构

```text
Browser
  |
  | HTTP + SSE
  v
FastAPI / SQLite :8787
  |-- Agent run、事件、证据和产物
  |-- 行情、K 线、指标、股票池和 screener API
  |-- skill 安装、启停和只读内容 API
  |-- /、/skills、/monitor 静态页面
  |
  | internal HTTP + streamed events
  v
PI Agent sidecar :8790
  |-- Provider adapter
  |-- skill 路由和上下文编译
  |-- 受控工具循环
  |-- terminal submission
  |
  +----> FastAPI /api/v1/* 只读数据接口

External data sources
  |-- Tencent：实时报价、日 K
  +-- EastMoney：证券搜索、A 股股票池导入
```

### 4.1 进程职责

FastAPI 是唯一的产品入口和持久化所有者：

- 创建 run、消费 sidecar 事件并写入 SQLite。
- 对浏览器提供 SSE，不让浏览器直接连接 sidecar。
- 负责所有行情获取、标准化、缓存、技术指标和筛选。
- 安装和管理 skill；只向 sidecar 暴露经过校验的 skill 内容。
- sidecar 不可用时，`/monitor` 和市场数据接口仍可工作。

PI Agent sidecar 只负责模型执行：

- 接收一个独立任务、可用 skill 摘要、工具定义和运行预算。
- 调用固定工具并产生结构化事件。
- 不直接访问 SQLite、外部行情源、任意文件或 Shell。
- 只能通过终端工具给出可展示的最终结果。

### 4.2 sidecar 内部接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/healthz` | sidecar 健康和 SDK 版本 |
| `POST` | `/internal/v1/runs` | 启动一次 run，并以流式事件返回执行过程 |
| `POST` | `/internal/v1/runs/{run_id}/cancel` | 取消当前 run |

FastAPI 在后台任务中消费 sidecar 事件流。连接中断、格式错误或无终端提交都必须把 run 标为失败，不能拼接半截模型文本作为答案。

## 5. Agent 运行闭环

### 5.1 工具集合

MVP 只向 Agent 注册以下工具：

| 工具 | 职责 | 主要约束 |
| --- | --- | --- |
| `load_skill` | 加载已选择 skill 的 `SKILL.md` | 只能读取已安装且启用的 skill；单次 run 至多加载一个策略 skill |
| `read_skill_reference` | 按需读取 skill 引用文件 | 路径必须位于 skill 根目录；限制文件类型、大小和读取次数 |
| `quant_api_get` | 访问本地只读行情和研究 API | 固定 `127.0.0.1:8787`、固定 `/api/v1/` allowlist、禁止管理接口 |
| `screen_stocks` | 执行结构化条件选股 | 只接受白名单字段和操作符；服务端确定性执行；不接受 SQL 或脚本 |
| `submit_analysis` | 提交最终回答 | 必须包含终态、证据引用、数据时间和风险限制；同轮不能混用其他工具 |

不注册 Shell、通用 HTTP、文件写入、脚本执行、数据库查询或交易工具。skill 中即使出现相关指令，也不能改变物理工具集合。

### 5.2 默认预算

| 限制 | 默认值 |
| --- | ---: |
| 模型轮次 | 8 |
| 总工具调用 | 20 |
| 行情与筛选请求 | 16 |
| 累计模型输出 token | 12,000 |
| 整体超时 | 300 秒 |
| 同时活动 run | 1 |

达到预算、用户取消、Provider 超时或工具连续失败时停止循环，并保存明确的失败原因。预算不能被 skill 放宽。

### 5.3 标准执行序列

```text
用户问题
  -> 识别任务类型和明确标的/股票池
  -> 自动选择 skill，或使用用户覆盖项
  -> load_skill（选择“不使用 skill”时跳过）
  -> 获取股票、指数或股票池证据
  -> Agent 判断证据缺口并继续调用工具
  -> 单标的：报价 + K 线 + 指标 + 必要指数上下文
  -> 条件选股：全池筛选 + 候选验证 + 必要指数上下文
  -> submit_analysis(completed | insufficient_evidence)
  -> FastAPI 校验引用和终态后展示
```

Agent 不能自行声明“信息已经足够”而绕过服务端校验。`completed` 至少要满足：

- 回答中的证券身份无歧义。
- 每个关键行情数字能够指向本次 run 的工具证据。
- 数据携带 `as_of`、`fetched_at`、来源和复权方式。
- 使用 skill 时，回答标明 skill 名称和版本。
- 条件选股时，回答包含股票池、筛选日期、扫描数量、覆盖率、条件和候选总数。

## 6. 行情与证券身份

### 6.1 对外只读 API

| 方法 | 路径 | MVP 行为 |
| --- | --- | --- |
| `GET` | `/api/v1/symbols/resolve` | 按代码、名称和精确别名解析股票、指数、ETF；返回候选和歧义状态 |
| `GET` | `/api/v1/quotes/realtime/{symbol}` | 返回实时或最近报价、昨收、涨跌幅和数据质量 |
| `GET` | `/api/v1/quotes/history/{symbol}` | 返回日 K；默认 `period=daily&adjustment=qfq&limit=240` |
| `GET` | `/api/v1/indicators/technical/{symbol}` | 返回由同一批日 K 确定性计算的技术指标 |
| `GET` | `/api/v1/research/universes/summary` | 返回股票池规模、数据就绪数量、共同交易日和覆盖率 |
| `GET` | `/api/v1/research/universes/{id}/members` | 分页返回股票池成员和数据状态 |
| `GET` | `/api/v1/research/screeners/a-share/short-term-candidates` | QuantPilot 风格的固定 `short_term`、`limit_up_relay`、`trend_liquidity` 模式 |
| `POST` | `/api/v1/research/screeners/a-share/query` | 执行白名单 DSL 的自定义条件筛选；由 `screen_stocks` 专用工具调用 |

`quant_api_get` 不允许调用写接口。通用筛选使用专门工具，是因为复杂条件不应编码进超长 GET URL，也不应扩大为通用 POST 工具。

### 6.2 身份与数据契约

- 内部 canonical symbol 使用带市场前缀的格式，例如 `sh600519`、`sz300750`、`bj920xxx`、`sh000001`。
- `sh000001` 是上证指数，`sz000001` 是平安银行；裸 `000001` 必须返回歧义候选，不能静默猜测。
- 指数、股票、ETF 和北交所证券必须显式携带 `asset_type` 与 `exchange`。
- 行情响应统一包含 `source`、`symbol`、`code`、`name`、`asset_type`、`as_of`、`fetched_at`、`adjustment` 和 `data_quality`。
- 数据源失败、字段缺失或数据陈旧必须进入 `data_quality` 和错误信息；禁止用另一个来源的旧值静默替换。
- K 线默认使用腾讯前复权日线。未复权、前复权和后复权数据不可混算指标。

### 6.3 MVP 技术指标

- MA5、MA10、MA20、MA30、MA60。
- 5 日、10 日、20 日和 60 日区间收益率。
- 20 日平均成交额与当日/20 日成交额比值。
- 20 日年化波动率。
- 20 日和 60 日最大回撤。
- 最近 4 日与 10 日涨停次数（数据字段完整时）。
- 最新涨跌幅、成交额、换手率、是否 ST、涨跌停状态和交易状态（数据字段完整时）。

## 7. 全市场条件选股

这是 MVP 的必要功能，不是后续增强项。没有本节，WolfBot 只能分析用户已经点名的证券，无法完成“根据条件找股票”的逻辑闭环。

### 7.1 两类筛选

1. 固定预设：直接裁剪 QuantPilot 的 `short_term`、`limit_up_relay` 和 `trend_liquidity` 规则、评分、安全门槛和响应契约。
2. 自定义条件：Agent 把用户明确给出的条件转换为白名单 DSL，由 `screen_stocks` 调用服务端筛选器。

skill 可以解释策略术语并建议 DSL 条件，但不能提供可执行 SQL、Python 或新的字段。最终筛选条件必须通过服务端 schema 校验。

### 7.2 白名单 DSL

示例用户问题：

> 筛选全 A 股中 MA5 > MA10 > MA20、近 20 日涨幅超过 8%、成交额高于 20 日均额 1.2 倍，排除 ST，列出前 10 只。

对应工具输入：

```json
{
  "universe_id": "a-share",
  "as_of": null,
  "conditions": [
    { "field": "ma5", "op": "gt", "right_field": "ma10" },
    { "field": "ma10", "op": "gt", "right_field": "ma20" },
    { "field": "return_20d_pct", "op": "gt", "value": 8 },
    { "field": "amount_ratio_20d", "op": "gte", "value": 1.2 },
    { "field": "is_st", "op": "eq", "value": false }
  ],
  "sort": [
    { "field": "return_20d_pct", "direction": "desc" }
  ],
  "limit": 10
}
```

MVP 规则：

- `conditions` 只支持 AND，最多 12 项。需要 OR 或复杂嵌套时返回不支持，并要求用户拆分问题。
- 操作符只允许 `eq`、`gt`、`gte`、`lt`、`lte`、`between`。
- `right_field` 只能引用类型兼容的白名单字段。
- 数值必须是有限值，并受各字段合理区间限制；`limit` 默认 10，Agent 侧最大 20。
- 条件通过 schema 转换为内部 AST，再使用参数化查询或内存谓词执行；任何字符串都不能作为 SQL 片段。
- 所有筛选都隐含数据日期一致、非 ST、非停牌、非涨跌停且安全字段明确的资格门槛。用户若明确要求研究 ST 或涨停标的，MVP 返回不支持，不放松安全门槛。

首版自定义字段白名单：

| 类别 | 字段 |
| --- | --- |
| 身份 | `exchange`、`board`、`asset_type` |
| 当日行情 | `close`、`change_pct`、`amount`、`turnover` |
| 均线 | `ma5`、`ma10`、`ma20`、`ma30`、`ma60` |
| 趋势与量能 | `return_5d_pct`、`return_10d_pct`、`return_20d_pct`、`return_60d_pct`、`amount_ratio_20d` |
| 风险 | `volatility_20d_pct`、`max_drawdown_20d_pct`、`max_drawdown_60d_pct` |
| 交易状态 | `is_st`、`is_limit_up`、`is_limit_down`、`trade_status`、`limit_up_count_4d`、`limit_up_count_10d` |

财务、估值、行业、概念、资金流、新闻和公告不在白名单中。用户用这些条件选股时，Agent 必须列出缺失的数据能力并提交 `insufficient_evidence`。

### 7.3 股票池与本地特征

新增以下 SQLite 数据域：

- `market_symbols`：canonical symbol、代码、名称、市场、资产类型、板块、ST 标识、启用状态和来源。
- `market_daily_bars`：按 symbol、交易日和复权方式保存 OHLCV、成交额及交易状态。
- `market_daily_features`：按 symbol 和交易日保存最新均线、收益、波动、回撤、量能与安全字段。
- `market_sync_runs`：保存股票池导入、历史初始化和增量同步的覆盖率、错误和时间。

同步流程：

1. 从东财导入 A 股证券列表，只把它作为股票池和名称来源。
2. 以受限并发和明确重试从腾讯初始化日 K；失败证券保留失败状态，不伪造记录。
3. 确定共同可用交易日，计算并保存派生特征。
4. APScheduler 在交易日收盘后执行增量同步；另提供显式的手工初始化命令。
5. `start.ps1` 只检查并报告覆盖率，不在启动前台服务时阻塞执行全市场初始化。

MVP 使用 SQLite，暂不移植 QuantPilot 的 TimescaleDB、Redis 和 ClickHouse。接口契约保留 `data_basis` 与 `analytics` 字段，明确返回 `sqlite`/`disabled`，为后续替换分析存储留出兼容边界。

### 7.4 筛选执行与候选验证

```text
用户条件
  -> schema 校验和规范化
  -> 读取股票池共同交易日及覆盖率
  -> 资格门槛：日期、新鲜度、历史长度、交易安全字段
  -> 对全部 eligible symbols 执行确定性条件
  -> 计算 matched_count 并排序、截取候选
  -> 返回每个候选命中的具体字段和值
  -> Agent 对候选获取最新报价，必要时获取前几名 K 线
  -> 获取主要指数上下文
  -> 形成带证据的回答
```

筛选响应必须包含：

- `universe_id`、`trade_date`、`timeframe`、`adjustment`。
- `total_symbols`、`scanned_symbols`、`eligible_symbols`、`excluded_symbols`。
- `excluded_reasons`、`safety_coverage_pct`、`coverage_warning`。
- 规范化后的条件与排序。
- `matched_count`、受 `limit` 限制的 `candidates`。
- 每个候选的证券身份、字段值、`matched_conditions`、警告和缺失字段。
- `source`、`data_basis`、`fetched_at` 和 `data_quality`。

覆盖率充分但没有命中时，返回结构化空候选并允许 `completed`，回答“在该股票池和日期内未找到符合全部条件的股票”。覆盖率不足、共同交易日过旧或关键安全字段未知时，Agent 只能提交 `insufficient_evidence`，不得把局部结果称为全市场结果。

### 7.5 条件选股回答格式

最终回答固定包含：

1. 筛选口径：股票池、日期、复权、条件、排序和数量。
2. 覆盖说明：总数、实际扫描数、合格数、覆盖率和主要排除原因。
3. 候选表：代码、名称、关键命中值、策略解释和风险警告。
4. skill 说明：使用的 skill 名称、版本，以及它如何影响解释或排序。
5. 证据和限制：数据来源、最新时间、不支持的数据维度，以及“筛选命中不构成买入建议”。

页面只显示一张可切换标的的 K 线图，默认选择排名第一的候选；不同时堆叠十张图。

## 8. skill 安装与运行治理

### 8.1 目录与来源

- 仓库公开内置 skill：`skills/wolf-investing/`，版本从 `0.1.0` 开始。
- 用户上传 skill：安装到 Git 忽略的数据目录，不写入仓库。
- 当前本地私有 `wolf-investing` 原始材料保持不动；只提炼可公开的策略原则、字段说明和引用结构。
- 每个包必须包含 `SKILL.md`；可选 `references/`、`assets/`、`scripts/` 和 `agents/openai.yaml`。

上传的 `scripts/` 与 `assets/` 可以保存、列出和计算哈希，但 MVP 永不执行其中脚本。

### 8.2 安装安全限制

沿用 QuantPilot 的归档治理边界：

- 上传文件最大 5 MiB。
- 归档最多 250 个 entry。
- 单文件解压后最大 10 MiB。
- 总解压大小最大 50 MiB。
- 拒绝绝对路径、`..` 穿越、符号链接、硬链接、设备文件、加密 entry 和重复规范化路径。
- 安装前先解压到临时目录，完整校验后再原子移动到目标位置。
- 保存归档 SHA-256、skill 内容 SHA-256、名称、版本、来源和安装时间。
- 名称冲突或降级安装必须显式失败；不覆盖现有 skill。

### 8.3 skill API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/skills` | 列出内置和上传 skill、版本、哈希和启用状态 |
| `POST` | `/api/v1/skills/install` | 上传并安装归档 |
| `PATCH` | `/api/v1/skills/{skill_id}` | 启用或停用 |
| `DELETE` | `/api/v1/skills/{skill_id}` | 卸载上传 skill；内置 skill 不允许删除 |

### 8.4 自动选择

FastAPI 向 sidecar 只发送已启用 skill 的短元数据：ID、名称、版本、描述和适用范围。Agent 最多选择一个策略 skill。选择完成后再调用 `load_skill` 获取正文，避免把所有 skill 全量注入上下文。

手工指定 skill 时不再自动改选；指定的 skill 缺失或被停用时 run 直接失败并给出可定位错误。选择“不使用 skill”时不调用任何 skill 工具。

## 9. 持久化与事件

在现有 SQLite 中新增：

- `skills`：安装元数据、哈希、来源和启用状态。
- `agent_runs`：问题、skill 模式、实际 skill、模型、状态、预算、终态、答案和错误。
- `agent_events`：run 内单调序号、事件类型、可展示 payload、时间和耗时。
- `agent_evidence`：工具、端点、证券、`as_of`、摘要和内容哈希。
- `agent_artifacts`：K 线数据、候选表等可重建产物的引用和类型。
- 第 7.3 节的四张市场数据表。

事件类型至少包括：

- `run_started`
- `skill_selected`
- `tool_started`
- `tool_completed`
- `tool_failed`
- `evidence_added`
- `terminal_submitted`
- `run_failed`
- `run_cancelled`

事件 payload 不保存 Provider 的隐藏 reasoning、API Key、Cookie、完整环境变量或超大工具原文。浏览器展示规范化工具参数、状态、耗时、数据时间和摘要。

## 10. 前端页面

### 10.1 `/` Agent 工作台

首屏直接提供可用的研究工作区，不增加营销落地页。主要区域：

- 问题输入和发送/取消操作。
- skill 模式选择：自动、指定、不使用。
- 当前 run 状态和预算摘要。
- 可折叠的工具轨迹与证据列表。
- 最终回答和条件选股候选表。
- SVG K 线、成交量和 MA5/10/20/30/60；点击候选行切换图表。

运行期间保持布局尺寸稳定；加载、空结果、失败、取消和证据不足都有独立状态。SSE 断线后可按最后 event ID 恢复，不重复展示事件。

### 10.2 `/skills` skill 管理

- 内置和上传 skill 列表。
- 显示版本、来源、SHA-256、安装时间和启用状态。
- 本地归档上传、校验进度、错误详情、启停和卸载。
- 内置 skill 可停用但不能卸载。

### 10.3 `/monitor` 现有功能

把当前 `/` 页面原样迁移到 `/monitor`，保留：

- 发言增量采集和最新发言展示。
- 引用内容、游标状态和手工采集。
- 现有 watchlist、行情快照、策略总结和任务接口。

迁移只改变页面入口，不在本项目中顺手重写其数据模型或业务逻辑。回归测试要确保 `/monitor` 的静态资源和原有 API 均可用。

## 11. 失败场景与明确行为

| 场景 | 预期行为 |
| --- | --- |
| 裸 `000001` 无法确定市场 | 返回歧义候选；Agent 请求更明确输入或提交证据不足，不自行选择 |
| 用户条件不在 DSL 白名单 | 明确列出不支持字段并提交 `insufficient_evidence` |
| 用户条件含 OR、公式或模糊词 | 不执行任意表达式；要求拆分或量化条件 |
| 筛选覆盖率充分但零命中 | 返回结构化空结果，`completed` 是合法终态 |
| 股票池覆盖率不足或数据陈旧 | 返回覆盖警告；不得声称“全 A 股均不符合” |
| 腾讯或东财失败 | 保存来源错误和受影响证券；不静默使用模型记忆或伪造值 |
| skill 包含穿越路径或链接 | 安装失败，不留下半安装目录 |
| skill 请求 Shell、外网或脚本执行 | 物理工具不存在，请求无法执行并写入安全事件 |
| Provider 未配置 | run 返回 `needs_configuration`，不生成占位投资结论 |
| sidecar 不可用 | Agent run 返回 503；`/monitor` 和普通行情 API 不受影响 |
| 超预算、超时或缺少终端提交 | run 标为失败，保留已取得的证据但不展示为最终答案 |
| 已有活动 run | 新 run 返回 409，并允许用户取消当前 run |

## 12. 分阶段实施

每个阶段完成后先通过该阶段门槛，再进入下一阶段。实现过程中若改变模块、入口、依赖、配置或测试命令，同步更新 `docs/PROJECT_MAP.md` 和相关 README；获得提交授权后再按仓库规范更新 `COMMIT_LOG.md`，`feat`/`fix` 同时更新 `CHANGELOG.md`。

### 阶段 0：契约与骨架

交付：

- 建立 sidecar TypeScript package、锁定 PI Agent 依赖和内部 HTTP 契约。
- 在 FastAPI 中建立 run、event、evidence schema 和迁移兼容逻辑。
- 定义五个工具的 JSON Schema、事件类型和 terminal submission schema。
- 扩展 `start.ps1` 同时管理 FastAPI 和 sidecar，并正确传播退出与错误。

门槛：

- fake Provider 能完成“调用一个工具 -> 收到工具结果 -> terminal submit”的测试。
- sidecar 异常退出时 FastAPI 能结束对应 run，且不会影响 `/monitor`。

### 阶段 1：行情、证券解析与 K 线

交付：

- 复用现有腾讯实现，补齐证券身份、指数、ETF、北交所和数据质量契约。
- 实现 resolve、realtime、history 和 technical indicators API。
- 增加缓存、超时、显式错误和指标单元测试。

门槛：

- 股票、指数和 ETF 各有一个 fixture 测试。
- `sh000001` 与 `sz000001` 明确区分；裸代码歧义测试通过。
- 指标由 fixture K 线可重复计算，复权方式不会混用。

### 阶段 2：股票池与 screener

交付：

- 实现股票池导入、日线初始化、增量更新、特征表和覆盖状态。
- 裁剪实现 QuantPilot 三个固定筛选模式。
- 实现白名单 DSL、`screen_stocks` 工具、资格门槛、候选证据和结构化空结果。
- 提供手工市场初始化命令，并在 README 记录预计耗时、限流和恢复方式。

门槛：

- fixture 股票池能够稳定筛出预期候选，排序可重复。
- SQL 注入、未知字段、无穷数、超限条件和复杂表达式全部被拒绝。
- 覆盖充分的零候选与覆盖不足被区分。
- Agent 可完成一次“全池筛选 -> 候选验证 -> terminal submit”。

### 阶段 3：skill 管理与公开 wolf-investing

交付：

- 实现内置 skill 发现、归档安装、哈希、启停和卸载。
- 建立经过脱敏的 `skills/wolf-investing/`，不包含原始聊天、Excel、Cookie 或私有证据。
- 实现自动选择、手工覆盖和“不使用 skill”。
- skill 内容明确只引用 MVP 可用数据；无法验证的维度要求 Agent 声明限制。

门槛：

- 正常 zip/tgz 安装成功；恶意路径、链接、重复 entry 和大小超限测试失败关闭。
- 自动模式可选择 `wolf-investing`，手工模式不会被覆盖。
- skill 中的脚本无法执行，也不能扩大工具 allowlist。

### 阶段 4：三页面 UI 与流式运行

交付：

- 新建 `/` Agent 工作台和 `/skills`。
- 把当前仪表盘迁移到 `/monitor` 并保持功能。
- 实现 SSE 轨迹、回答、证据、候选表和本地 SVG K 线。
- 增加加载、无数据、零候选、证据不足、失败、取消和 sidecar 离线状态。

门槛：

- 桌面和移动视口没有文本溢出、控件重叠或图表空白。
- 切换候选不会改变页面关键区域尺寸，K 线、成交量和均线同步更新。
- `/monitor` 原有 API 回归和主要人工流程通过。

### 阶段 5：端到端验收、文档与归因

交付：

- 执行第 13 节的端到端用例，并保存不含敏感数据的测试结果。
- 更新根 README、`wolf-dashboard/README.md`、项目全景图、`.env.example` 和启动说明。
- 新增 `THIRD_PARTY_NOTICES.md`，记录 QuantPilot MIT 来源及改编范围。
- 检查依赖许可证、安全边界、忽略规则和仓库待提交文件。

门槛：

- 所有自动测试、`git diff --check`、文档链接和敏感文件检查通过。
- 从全新本地配置可以按 README 启动服务、初始化数据并完成一个 Agent run。

## 13. 测试与验收矩阵

### 13.1 自动测试

| 层级 | 必测内容 |
| --- | --- |
| FastAPI 单元测试 | symbol 解析、行情错误、指标公式、复权、数据新鲜度 |
| screener 单元测试 | 三个预设、DSL 校验、排序、资格门槛、覆盖率、空结果、注入拒绝 |
| skill 单元测试 | 包格式、路径安全、大小限制、哈希、版本冲突、启停和卸载 |
| sidecar 单元测试 | 工具循环、skill 路由、预算、超时、取消、terminal 独占、无 terminal 失败 |
| 集成测试 | FastAPI fake market fixtures + fake Provider 完成单标的和条件选股 run |
| API 回归 | 现有 posts、strategies、watchlist、aliases、events 和任务接口 |
| 前端检查 | 三条路由、SSE 重连、候选切换、SVG 非空、桌面和移动布局 |

### 13.2 端到端用例

1. “分析贵州茅台最近 120 个交易日的趋势和回撤。”
   - 能解析 `sh600519`，显示前复权 K 线、指标、来源和时间。
2. “分析上证指数最近半年。”
   - 解析为 `sh000001` 指数，不与平安银行混淆。
3. 第 7.2 节的全 A 股条件选股。
   - 展示规范化条件、覆盖率、候选总数、前 10 名和可切换 K 线。
4. 使用 `wolf-investing` 分析一个明确股票。
   - 轨迹包含 skill 加载和多轮取数，回答标注 skill 版本。
5. 使用一个不可能命中的数值条件。
   - 覆盖充分时返回可信的零候选结论。
6. “筛选低 PE、业绩高增长且有政策催化的股票。”
   - 因 MVP 缺少财务与催化数据而提交 `insufficient_evidence`，不生成股票名单。
7. 安装合法 skill 包和包含 `../` 的恶意包。
   - 前者可启用，后者不留下任何安装结果。
8. sidecar 执行中访问 `/monitor` 并触发原有查询。
   - 页面和接口保持响应，不被长时间推理阻塞。

### 13.3 MVP 完成标准

以下条件全部满足，才算形成可写入简历的最小功能闭环：

- [ ] Agent 真实使用 PI Agent SDK 进行多轮工具调用，不是一次普通聊天补上静态答案。
- [ ] 股票、指数、ETF 的身份、报价、K 线和指标端点可用且带数据质量元数据。
- [ ] 条件选股扫描明确股票池，返回覆盖率、候选证据和可信空结果。
- [ ] 自定义条件只能走白名单 DSL；不支持的条件会失败关闭。
- [ ] 至少一个公开脱敏的 `wolf-investing` skill 可安装/启用并被自动选择。
- [ ] Agent 会继续取数直到证据充分、预算耗尽或明确证据不足。
- [ ] `/`、`/skills`、`/monitor` 三个页面可用，现有监控功能无回归。
- [ ] 工具轨迹和证据可审计，但没有隐藏思维链或敏感凭据。
- [ ] 主流程、边界和预期失败场景有自动测试；启动和初始化步骤可复现。
- [ ] QuantPilot 改编范围与 MIT License 已归因。

## 14. 后续增强方向

MVP 验收后再逐步加入：

- 财务三表、估值历史、行业分类、资金流、公告和新闻证据。
- 更多筛选字段、可视化条件编辑器和策略 preset 管理；仍不开放任意代码执行。
- 更大的本地历史范围、复权因子验证和交易日历。
- 多标的对比、回测与研究报告导出。
- 从 SQLite 迁移到专门的时序或分析存储，但保持现有 API 契约。
- 多并发 run、任务队列、恢复执行和更完整的评测集。

这些增强不应阻塞 0.1.0 的 Agent、行情、skill 和条件选股闭环。
