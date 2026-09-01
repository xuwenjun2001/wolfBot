# WolfBot 项目全景图

状态：Wolf Dashboard Agent 工具契约可靠性修复已通过自动回归与真实 Provider 验收（2026-08-31）。

## 当前范围

仓库包含维护规范、策略证据材料和 `wolf-dashboard` 本地服务。服务由 FastAPI/SQLite、原生三页面前端和本地 TypeScript PI Agent sidecar 组成。后续结构变化仍需在本文件登记；不要把本地数据库、Cookie、原始导出、上传 skill、依赖或构建产物写入仓库。

## 当前文件树

```text
wolfBot/
├── .gitignore                         # 通用及本地生成物忽略规则
├── .gitmessage                        # Git 提交正文模板
├── AGENTS.md                          # 仓库级代理与工程规范
├── CHANGELOG.md                       # feat/fix 变更记录
├── COMMIT_LOG.md                      # 所有提交的原因、实现和验证记录
├── CONTRIBUTING.md                    # 贡献、提交与评审流程
├── README.md                          # 项目入口、启动和限制
├── THIRD_PARTY_NOTICES.md             # QuantPilot MIT 改编归因
├── docs/
│   ├── PROJECT_MAP.md                 # 本文件：全景、索引与同步规则
│   └── improvement-plans/             # 产品与工程改进方案
│       ├── wolfbot-agent-mvp.md        # Agent MVP 计划与验收矩阵
│       ├── wolfbot-agent-tool-contract-reliability.md # 工具契约与运行可靠性修复计划
│       ├── wolfbot-sector-trend-research.md # 板块走势研究能力诊断与改进计划
│       └── wolfbot-single-symbol-chart-autoload.md # 单标的 K 线自动展示修复计划
├── skills/
│   ├── wolf-investing/                # 公开、脱敏的单标的内置 skill
│   └── wolf-sector-research/          # 公开、脱敏的板块走势内置 skill
└── wolf-dashboard/
    ├── .env.example                   # 无凭据配置样例
    ├── README.md                      # 目录级运行、API、初始化和恢复说明
    ├── backend/
    │   ├── app/                       # FastAPI、Agent、行情、skill 和旧监控服务
    │   ├── requirements.txt            # Python 依赖约束
    │   └── tests/                      # Python 回归与 MVP 测试
    ├── agent-sidecar/
    │   ├── src/                       # PI Agent、Provider、工具边界和 HTTP 服务
    │   ├── test/                      # Vitest 测试
    │   ├── scripts/                   # 显式执行的真实 Provider smoke
    │   ├── package.json                # Node 脚本与固定依赖
    │   ├── package-lock.json           # npm 锁文件
    │   └── THIRD_PARTY_NOTICE.md       # sidecar 局部 QuantPilot 归因
    ├── frontend/
    │   ├── agent.{html,css,js}         # `/` Agent 工作台
    │   ├── agent-market.js             # 图表标的选择与 OHLCV/均线合并纯函数
    │   ├── tests/                      # `node --test` 前端纯逻辑回归
    │   ├── skills.{html,css,js}        # `/skills` skill 管理
    │   ├── index.html                  # `/monitor` 原有仪表盘
    │   ├── app.js、styles.css          # monitor 逻辑和样式
    │   └── static files                # 无构建步骤的原生前端
    └── scripts/
        ├── start.ps1                  # Windows 双进程启动与清理
        ├── initialize-market.py       # EastMoney 目录导入 + 显式腾讯行情初始化 CLI
        ├── install-task.ps1           # Windows 登录任务注册
        └── dev.py                     # 仅启动 FastAPI 的开发入口
```

## 定位索引

| 需要查找 | 首先阅读 | 说明 |
| --- | --- | --- |
| 开始任务、判断影响范围 | `docs/PROJECT_MAP.md` | 当前树、模块登记和同步触发条件 |
| 代码质量、安全、测试要求 | `AGENTS.md` | 仓库级强制工作约定 |
| 开发和评审流程 | `CONTRIBUTING.md` | 分支、验证和提交步骤 |
| 项目状态和启动入口 | `README.md` | 维护者概览、前置条件和限制 |
| 目录级运行、API、市场初始化 | `wolf-dashboard/README.md` | 代码事实对应的操作步骤 |
| 产品边界和验收矩阵 | `docs/improvement-plans/wolfbot-agent-mvp.md` | MVP 计划；计划态不等于验收完成 |
| Agent 工具调用与 `TOOL_LIMIT` 修复记录 | `docs/improvement-plans/wolfbot-agent-tool-contract-reliability.md` | 专用工具契约、失败语义、预算和真实 Provider 验收结果 |
| 板块走势问题、市场时点与证据能力改造 | `docs/improvement-plans/wolfbot-sector-trend-research.md` | “液冷板块今天的走势如何”对照诊断、板块工具/API、数据模型、阶段计划和验收矩阵 |
| 单标的已识别但 K 线未自动显示 | `docs/improvement-plans/wolfbot-single-symbol-chart-autoload.md` | 公共证券身份投影、图表目标发现、自动加载幂等性、OHLCV/均线合并和回归矩阵 |
| 北京时间市场阶段与有效交易日 | `wolf-dashboard/backend/app/market_calendar.py` | 阶段边界、交易日判定依据和回退原因 |
| 板块身份、快照、宽度、成分与上游错误分类 | `wolf-dashboard/backend/app/market_boards.py`、`board_service.py` | Provider 契约、宽度计算口径、缓存新鲜度和覆盖门槛 |
| feat/fix 原因与修改记录 | `CHANGELOG.md` | 按变更 ID 追溯 |
| 所有提交的原因与验证 | `COMMIT_LOG.md` | 按提交标题和日期集中审阅 |
| QuantPilot 改编归因 | `THIRD_PARTY_NOTICES.md` | MIT 文本、commit 和实际文件范围 |

## 模块登记

| 路径 | 职责 | 公共入口 | 输入/输出与依赖 | 测试/验证 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `wolf-dashboard/backend/app/main.py` | FastAPI 生命周期、旧监控 API 和三页静态入口 | `/`、`/skills`、`/monitor`、`/api/*` | `.env`、SQLite、NGA、scheduler | `backend/tests`、HTTP smoke | 已实现 |
| `wolf-dashboard/backend/app/agent_service.py`、`agent_router.py` | Agent run 持久化、SSE、单活动 run、取消和脱敏 | `/api/v1/runs`、`/api/v1/agent/runs` | sidecar 内部 NDJSON、SQLite | `test_agent_api.py` | 已实现 |
| `wolf-dashboard/backend/app/market_data.py`、`market_store.py` | 证券身份、EastMoney A 股目录导入、腾讯报价/日线、指标、本地同步和覆盖率 | `/api/v1/symbols/*`、`/api/v1/quotes/*`、`/api/v1/indicators/*` | EastMoney clist（目录）+ Tencent（日线）+ SQLite | `test_market_mvp.py`、`test_eastmoney_universe.py`、router tests | 已实现，数据源有限制 |
| `wolf-dashboard/backend/app/market_router.py`、`screener.py` | 行情/研究 API、固定模式和白名单 DSL 筛选 | `/api/v1/research/*` | `MarketStore`、只读 provider | `test_market_router_mvp.py`、`test_screener_mvp.py` | 已实现 |
| `wolf-dashboard/backend/app/market_calendar.py` | 北京时间交易阶段、交易日历、最近完整交易日与回退原因 | `TradingCalendar`、`calendar_from_store` | 注入时钟；交易日优先取 SQLite 已观测日期，否则工作日规则 | `test_market_calendar.py`（固定时钟覆盖全部阶段） | 已实现 |
| `wolf-dashboard/backend/app/market_boards.py` | 板块模型、名称归一化、EastMoney 板块 Provider 与上游错误分类 | `EastMoneyBoardProvider`、`compute_breadth` | EastMoney `clist`（`m:90+t:1/2/3`、`b:BK*`）；限速、退避、结构校验 | `test_market_boards.py`（注入假 session，不联网） | 已实现，来源单一 |
| `wolf-dashboard/backend/app/board_store.py`、`board_service.py` | 板块身份/成分/快照持久化，缓存新鲜度、宽度计算与覆盖门槛 | `BoardStore`、`BoardService` | SQLite `market_boards`、`market_board_memberships`、`market_board_snapshots` | `test_board_store.py`、`test_board_router.py` | 已实现 |
| `wolf-dashboard/backend/app/board_router.py` | 市场会话与板块的 5 条固定只读路由 | `/api/v1/market/session`、`/api/v1/boards/*` | `BoardService`、`TradingCalendar` | `test_board_router.py`（含歧义、断线、覆盖不足） | 已实现 |
| `wolf-dashboard/backend/app/skills.py` | 内置/上传 skill 发现、归档安全、启停、卸载和内容读取 | `/api/v1/skills/*` | SQLite、`skills/`、`data/skills/` | `test_skills.py`、skill validator | 已实现 |
| `wolf-dashboard/agent-sidecar/src` | PI Agent 循环、OpenAI-compatible Provider、专用市场/板块工具契约、对象路由提示词、板块最小充分证据、预算与取消 | `:8790/healthz`、`/internal/v1/runs` | Node >=22、PI 0.82.1、FastAPI 固定端点映射 | typecheck、build、Vitest（`sidecar.test.ts`、`board-tools.test.ts`）、`npm run smoke:provider`（显式） | 已实现并通过真实 Provider smoke |
| `wolf-dashboard/frontend/agent.*` | Agent 工作台、事件轨迹、证据、市场时点与板块卡片、候选表、单标的图表自动加载和 SVG K 线 | `/` | 原生浏览器 API、FastAPI SSE、`agent-market.js` | `node --check`、桌面/移动 HTTP 与浏览器检查 | 已实现 |
| `wolf-dashboard/frontend/agent-market.js`、`frontend/tests/` | 图表标的发现优先级、canonical symbol 校验、按交易日合并真实 OHLCV 与均线的纯函数及其回归 | 浏览器全局 `WolfAgentMarket`；Node `require` | 无第三方依赖 | `node --test frontend/tests/*.test.mjs` | 已实现 |
| `wolf-dashboard/frontend/skills.*` | skill 上传、启停、卸载和内容查看 | `/skills` | FormData、Skill API | HTTP 与浏览器检查 | 已实现 |
| `wolf-dashboard/frontend/index.html`、`app.js`、`styles.css` | 原有发言监控、行情和策略页 | `/monitor` | 旧 `/api/*`、NGA 数据 | API 回归与浏览器检查 | 已迁移 |
| `wolf-dashboard/scripts/start.ps1` | 检查前置条件、按白名单加载 Provider 环境并启动/监控/清理 FastAPI 与 sidecar | Windows PowerShell | `.env` 中 4 个 `OPENAI_*` 变量、venv、Node/npm、built sidecar | PowerShell parser、双进程健康检查、真实 Provider smoke | 已实现 |
| `wolf-dashboard/scripts/initialize-market.py` | 显式 symbol 恢复或 EastMoney 全 A 普通股目录导入后同步腾讯前复权日线与派生特征 | CLI `--help`、`--dry-run`、`--max-symbols`、`--history-limit` | `EastMoneyUniverseProvider`、`MarketStore`、`MarketSyncService`、`TencentProvider` | help/dry-run、导入器 fixtures、安全失败检查 | 已实现，启动不自动执行 |

## 数据流和运行约束

```text
Browser
  │ HTTP + SSE
  ▼
FastAPI :8787 ── SQLite (唯一持久化所有者)
  ├─ `/`、`/skills`、`/monitor`
  ├─ Agent run、事件、证据和 artifacts
  ├─ 行情、指标、股票池覆盖率和 screener
  ├─ 市场会话/交易日历与板块身份、快照、宽度、成分
  └─ 受校验的 skill 管理
       │ internal NDJSON / cancellation
       ▼
PI sidecar :8790 ── OpenAI-compatible Provider
  └─ 只能通过按业务语义拆分的专用工具访问 FastAPI `/api/v1/` 固定端点

EastMoney ── paginated security catalog ──> explicit initialize-market CLI
EastMoney ── board catalog/quote/members ─> FastAPI board layer (限速、分类失败)
Tencent ─── realtime/history ────────────> FastAPI market layer / initialize-market CLI
NGA ─────── posts/strategy ───────────────> FastAPI legacy monitor layer
```

Agent 对象路由：相对日期先经 `get_market_session_context` 解析为绝对有效交易日；股票/指数/ETF 走 `resolve_symbol`，行业/概念/主题/地域走 `resolve_board`。板块核心工具（会话、解析、快照、宽度、成分）属于市场基础能力，`skill_mode=none` 下同样注册，不依赖任何 skill。后端板块错误码按白名单透传给模型作为路由依据；上游断线、限流和畸形响应不会退化成“板块不存在”或空数据。板块问题的最小充分证据由 sidecar 机械校验：run 中出现成功 `resolve_board` 后，`completed` 提交必须引用成功的 `get_board_snapshot` 与 `get_board_breadth` 的 `tool_call_id`。

单标的图表数据流：`agent_service._project_public_tool_data()` 是事件、证据和 artifact 的唯一工具结果投影入口；唯一且无歧义的 `resolve_symbol` 结果会被规范化出顶层 `symbol/code/name/asset_type/exchange`，模糊结果最多保留 8 个仅含身份字段的候选且不生成顶层 symbol，完整 `bars`/`points` 始终不进入公开记录。`market_evidence` artifact 额外记录受控工具名，浏览器按「日线/指标 → 实时报价 → 唯一解析 → 已持久化证据或带白名单工具名的 artifact」的优先级确定唯一 canonical 标的；同一优先级出现多个证券时不自动选择。页面用 `run_id + symbol` 幂等键最多自动请求一次 `/api/v1/quotes/history/{symbol}` 与 `/api/v1/indicators/technical/{symbol}`；K 线只使用 `history.bars` 的真实开高低收，指标点仅按交易日叠加均线。候选表只消费筛选工具与 `candidate_table` artifact；用户点击候选后进入 manual 模式，后续事件不再改写图表标的。

FastAPI 启动会初始化 SQLite、读取本地种子并启动 scheduler；`start.ps1` 不调用市场初始化 CLI。启动脚本只在对应进程环境尚未设置时，从 `wolf-dashboard/.env` 或仓库根 `.env` 补充 4 个 Provider `OPENAI_*` 变量，不向 sidecar 导入 Cookie 等无关配置。Agent sidecar 不访问 SQLite、任意文件、Shell 或外部行情接口。sidecar 不可用时 Agent 创建请求返回 503，`/monitor` 和普通行情 API 仍可用。

市场 CLI 无显式 symbol 时通过 EastMoney `push2/api/qt/clist/get` 分页导入沪深和当前北交所 920xxx 普通 A 股；导入复用单一 session、串行请求并在分页间至少等待 1 秒加抖动，连接/429/5xx 退避重试，403、畸形 JSON、空或不完整响应明确失败。显式 `sh/sz/bj` symbol 或文本文件仍用于受控恢复。导入排除 ETF、指数、B 股及旧北交所 43/83/87 代码；`default_catalog()` 仍只是 fixture，`/api/v1/symbols/resolve` 使用本地已导入目录而不宣称远程搜索。同步使用 upsert，可通过 `/api/v1/research/universes/summary` 和 `/members` 检查覆盖率，失败后重跑受影响标的。

## 依赖和验证命令

- Python：在 `backend/.venv` 安装 `backend/requirements.txt`，`$env:PYTHONPATH` 指向 `backend` 后运行 `python -m pytest -q`。
- Node：Node.js >=22；在 `agent-sidecar` 运行 `npm.cmd ci`、`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`。
- 前端：`node --check wolf-dashboard/frontend/agent.js`、`node --check wolf-dashboard/frontend/agent-market.js`、`node --test wolf-dashboard/frontend/tests/*.test.mjs`（Node 内置测试，无第三方依赖）。
- 真实 Provider 验收（不进 CI，需显式执行）：FastAPI 与 sidecar 已启动、A 股目录已初始化、无其他活动 run 时，在 `agent-sidecar` 运行 `npm.cmd run smoke:provider`；结果必须与普通测试分开记录。
- 启动：先安装 Python 依赖并构建 sidecar，再运行 `scripts/start.ps1`；脚本会探测 FastAPI/Uvicorn，要求 `node_modules`、PI 依赖目录和 `dist/main.js` 均存在，并按白名单把本地 Provider 配置传给 sidecar。
- CLI：`backend/.venv/Scripts/python.exe scripts/initialize-market.py --help`；显式 symbol 的 `--dry-run` 不联网、不写库，全量 `--dry-run` 只读取 EastMoney 目录、不写 SQLite、不调用 Tencent 历史。全量历史同步应使用 `--max-symbols`/`--history-limit` 做 smoke 或恢复边界。
- 完成前：运行 `git diff --check`、文档链接/路径检查、敏感文件扫描和 `git status --short`；不要提交 `node_modules`、`dist`、缓存、SQLite、日志或 `data/skills`。

## 文档同步规则

以下变化必须同步更新本图和相关 README：新增/删除/移动模块、脚本、入口或测试；运行时依赖、环境变量、外部服务或持久化介质变化；数据流、启动方式、部署约束、用户页面或测试命令变化。只调整措辞且不改变结构时不必更新本图，但 README、规范和代码事实必须一致。

`docs/improvement-plans/` 是计划索引，保留其计划态说明。每个提交仍须按 `AGENTS.md` 更新 `COMMIT_LOG.md`；`feat`/`fix` 还须更新 `CHANGELOG.md`。本任务未授权提交或推送。

## Agent skill data flow

`wolf-dashboard/agent-sidecar/src/tools.ts` keeps the initial skill descriptors bounded to metadata. `load_skill` and `read_skill_reference` fetch the selected enabled skill content through the fixed local FastAPI skill endpoints (`/api/v1/skills/{skill_id}/SKILL.md` and `/reference?path=...`); no arbitrary URL or filesystem access is added.

`skills/wolf-sector-research` documents board trend method, breadth interpretation, coverage limits, and the board field contract. It is an enhancement only: the board tools themselves are registered in every skill mode, so disabling the skill loses method and wording, never data access.

## 板块数据来源与口径

板块目录、快照和成分来自东方财富 `push2/api/qt/clist/get`（`m:90+t:2` 行业、`m:90+t:3` 概念、`m:90+t:1` 地域、`b:BK*` 成分），默认启用。请求复用单一 session、串行分页并限速；连接被断开、429、5xx、403、畸形 JSON 和空页分别映射为 `UPSTREAM_UNAVAILABLE`、`UPSTREAM_RATE_LIMITED` 和 `UPSTREAM_INVALID_RESPONSE`，不会伪装成空数据或“板块不存在”。`board_id` 是 `sha256(provider:code)` 前缀派生的内部不透明 ID，模型和前端都不接触来源板块代码。

上游未发布涨跌家数时，宽度由同一时点的有效成分与成分行情计算，并持久化 `breadth_basis`、`algorithm_version`、`covered_members`/`total_members`/`coverage_pct`；不同日期或不同来源的成分与行情不会静默混合。成分按 `valid_from` 分版本写入，同一日期的重新导入整批替换，避免留下两个版本的混合。交易日历优先使用 `market_daily_bars`/`market_board_snapshots` 已观测到的交易日；无历史数据时退回工作日规则并把 `calendar_basis` 标为 `weekday_only`，明确未核验节假日。

尚未实现：板块资金流与受控新闻催化（计划书 P1 剩余项与 P2）。
