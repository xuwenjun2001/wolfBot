# Wolf Dashboard

`wolf-dashboard` 是 WolfBot 的本地研究、Agent 和发言监控服务。FastAPI 默认只监听 `127.0.0.1:8787`，TypeScript PI Agent sidecar 默认只监听 `127.0.0.1:8790`；SQLite 默认写入 `data/wolf.sqlite3`。数据库、上传 skill、依赖和构建产物均不应提交。

## 前置条件

- Windows PowerShell。
- Python 3.10 或更高版本。
- Node.js 22 或更高版本及 npm。
- 能访问腾讯行情接口的网络；NGA 抓取需要有效 `NGA_COOKIE`。
- Agent 模型需要 OpenAI-compatible Provider 的 `OPENAI_API_KEY`。缺少 key 时，Agent 运行会返回 `needs_configuration`，不会伪造答案；旧的策略总结接口也会保留待配置版本。

## 安装与启动

```powershell
cd wolf-dashboard
Copy-Item .env.example .env

python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt

Push-Location agent-sidecar
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
Pop-Location

.\scripts\start.ps1
```

`start.ps1` 会验证 `backend/.venv/Scripts/python.exe` 及其中的 FastAPI/Uvicorn、Node/npm 版本、sidecar `package.json`/`package-lock.json`、PI 依赖目录和 `dist/main.js`。它只在当前进程尚未设置对应变量时，从 `wolf-dashboard/.env` 或仓库根 `.env` 补充 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 和 `OPENAI_REASONING_EFFORT`，不会把 Cookie 等无关配置传给 sidecar。脚本直接管理 FastAPI 和已构建的 sidecar 两个前台进程；任一进程异常退出时停止另一进程并返回非零码，Ctrl+C 同样清理两个进程。脚本不会在启动时联网初始化全市场数据。

打开 <http://127.0.0.1:8787/>。Windows 登录后启动任务：

```powershell
.\scripts\install-task.ps1
```

如果启动检查失败，按错误信息补齐 Python venv、`pip install`、`npm ci` 或 `npm run build`；不要把 `dist` 或 `node_modules` 加入版本库。

## 三个页面

### `/`

Agent 工作台。每次提问都是独立 run，可选择自动选择 skill、指定一个已启用 skill 或不使用 skill。页面展示运行状态、预算、公开工具轨迹、证据、终端回答、候选表和本地 SVG 前复权 K 线；候选行可切换图表。SSE 断线后按最后 event ID 重新连接，避免重复展示。

### `/skills`

Skill 注册表。列出内置和本地上传 skill 的版本、来源、SHA-256、安装时间及启用状态；支持 ZIP、TGZ、TAR.GZ 上传、启停和查看 `SKILL.md`。内置 `skills/wolf-investing` 可以停用但不能卸载；上传 skill 存放在 `data/skills`，安装校验会拒绝路径穿越、链接和不支持的归档。

### `/monitor`

原有 NGA 发言和策略仪表盘入口，保留发言增量采集、引用内容、游标、手工采集、行情快照、watchlist 和策略任务。页面“最新发言”在桌面端限制为约 520px 高度并独立滚动，窄屏限制为视口高度的 60%；回复带有引用时，会在正文上方完整显示引用内容和被引用 PID。

## API

Agent API：

- `POST /api/v1/runs` 创建 run；同一时间只允许一个活动 run。
- `GET /api/v1/runs`、`GET /api/v1/runs/{run_id}` 查询 run、事件、证据和 artifacts。
- `GET /api/v1/runs/{run_id}/events` 以 SSE 返回事件，支持 `after` 和 `Last-Event-ID` 恢复。
- `POST /api/v1/runs/{run_id}/cancel` 取消 run。
- `/api/v1/agent/runs` 是相同服务的兼容前缀。

市场/研究 API：

- `GET /api/v1/symbols/resolve?query=...` 解析带市场前缀的股票、指数和 ETF；裸 `000001` 保持沪深歧义。
- `GET /api/v1/quotes/realtime/{symbol}`、`GET /api/v1/quotes/history/{symbol}`、`GET /api/v1/indicators/technical/{symbol}` 获取腾讯报价、日线和确定性指标。
- `GET /api/v1/research/universes/summary`、`GET /api/v1/research/universes/{universe_id}/members` 查看本地股票池覆盖率。
- `GET /api/v1/research/screeners/a-share/short-term-candidates` 执行固定筛选模式。
- `POST /api/v1/research/screeners/a-share/query` 执行白名单条件 DSL；不接受 SQL、脚本、公式或任意表达式。

Skill API：`GET /api/v1/skills`、`POST /api/v1/skills/install`、`PATCH /api/v1/skills/{skill_id}`、`DELETE /api/v1/skills/{skill_id}`，以及受治理的内容读取端点。

原有 API 仍可用：`/api/status`、`/api/posts`、`/api/strategies`、`/api/watchlist`（含删除）、`/api/aliases`、`/api/tasks/crawl`、`/api/tasks/strategy` 和 `/api/events`（SSE）。

## NGA 与旧策略行为

填写 `NGA_COOKIE` 后，后台按 5 分钟间隔从作者过滤页的 `last_page - 1` 开始重叠扫描，并以 `(tid,pid)` 去重。请求固定带有 `authorid` 和 `opt=262144`，因此 `crawl_cursor.last_page` 表示作者过滤分页的页码，而不是普通帖子页码。没有新发言时游标也会推进到本轮成功扫描的最高页；检测到旧版普通帖子页游标时，首次会从 `NGA_INITIAL_PAGE`（默认 29）重扫 28～31 一带并在成功后标记迁移完成。NGA `lite=js` 响应沿用了 nga-mofish 的必要兼容逻辑：GBK/GB18030 解码、`window.script_muti_get_var_store` 包装剥离、`signature`/`alterinfo` 清理、JSON5 和截断响应修复，以及 `__PAGE`/`__R`/作者字段提取；没有依赖 VS Code runtime 或插件私有状态。

行情快照使用腾讯报价和日线接口：报价保存当前值与昨收，盘前快照额外保存最近一个已完成交易日的 OHLCV；接口失败会把错误写入快照并在页面标成待核验。旧策略接口使用 OpenAI-compatible `/chat/completions`，可通过 `OPENAI_REASONING_EFFORT` 传递兼容模型的思考强度（例如 `max`），并通过 `OPENAI_REQUEST_TIMEOUT` 配置 AI 独立超时（最大 1200 秒）。每条策略必须通过服务端校验，至少包含一个已存在的作者 PID 和一个已存在的规则 ID。

## 市场初始化

初始化不会由 FastAPI lifespan 或 `start.ps1` 自动执行。无参数时显式 CLI 使用 `EastMoneyUniverseProvider` 调用 `push2/api/qt/clist/get`，导入沪深和当前北交所 920xxx A 股普通股目录，然后使用 `TencentProvider`/`MarketSyncService` 拉取历史；`--symbol`/`--symbols-file` 仍用于小范围恢复，不会把 `default_catalog()` fixture 冒充全市场：

```powershell
cd wolf-dashboard
backend/.venv/Scripts/python.exe .\scripts\initialize-market.py --symbol sh600519 --symbol sz300750 --dry-run
backend/.venv/Scripts/python.exe .\scripts\initialize-market.py --symbol sh600519 --symbol sz300750
```

可用 UTF-8 文件提供一行一个 `sh`、`sz` 或 `bj` canonical symbol：

```powershell
backend/.venv/Scripts/python.exe .\scripts\initialize-market.py --symbols-file .\symbols.txt
```

无显式 symbol 时，EastMoney 目录请求复用一个 session 并串行分页，页间至少等待 1 秒加抖动；连接错误、429 和 5xx 退避重试，403、畸形 JSON、空目录和不完整分页明确失败，不进行 EastMoney 按 symbol 请求。实际运行对每个标的请求腾讯前复权日线（默认最多 800 条），写入 `market_symbols`、`market_daily_bars`、`market_daily_features` 和 `market_sync_runs`，并输出 JSON；同步期间 stderr 输出逐标的进度和错误。`--history-limit N` 控制每个标的历史条数，`--max-symbols N` 用于 smoke/recovery，`--eastmoney-page-size N` 控制目录页大小。首次全量历史同步预计数十分钟到数小时，取决于证券数量和 Tencent 响应速度。

`--dry-run` 不打开 SQLite、不调用 Tencent 历史：全量模式会读取 EastMoney 目录并输出目录计划，显式 symbol 模式完全不联网。目录或历史部分失败会返回非零码并保留同步错误；重复运行使用 upsert，先修复网络或标的后重跑失败项即可。`/api/v1/symbols/resolve` 使用本地导入的 code/name/exchange 目录，不宣称提供远程证券搜索。

覆盖检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/v1/research/universes/summary?universe_id=a-share
Invoke-RestMethod http://127.0.0.1:8787/api/v1/research/universes/a-share/members
```

部分失败时 CLI 返回非零码，错误保存在同步记录中；修复网络或标的后重跑失败标的即可。写入使用 upsert，不要删除数据库来“恢复”。覆盖率不足、数据陈旧或零候选必须按返回的 `data_quality`/覆盖字段解释，不能声称全 A 股结论。

## 配置

从 `.env.example` 复制 `.env`，只在未跟踪的 `.env` 写入真实值：

| 变量 | 默认值/用途 |
| --- | --- |
| `NGA_COOKIE`、`NGA_BASE_URL`、`NGA_TID`、`NGA_AUTHOR_ID`、`NGA_INITIAL_PAGE`、`CRAWL_INTERVAL_MINUTES` | NGA 监控与游标迁移 |
| `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_REASONING_EFFORT` | OpenAI-compatible Provider |
| `OPENAI_REQUEST_TIMEOUT` | 旧策略 AI 请求超时，1 到 1200 秒 |
| `AI_ENABLED` | 旧策略 AI 开关 |
| `WOLFBOT_SIDECAR_URL` | FastAPI 到 sidecar 的内部 URL，默认 `http://127.0.0.1:8790` |
| `AGENT_MAX_TURNS`、`AGENT_MAX_TOTAL_TOOL_CALLS`、`AGENT_MAX_MARKET_REQUESTS` | Agent 轮次、总工具调用和市场请求预算 |
| `AGENT_MAX_OUTPUT_TOKENS`、`AGENT_TIMEOUT_SECONDS` | Agent 输出 token 与整体超时预算 |
| `WOLF_DATABASE` | SQLite 路径，默认 `./data/wolf.sqlite3`（相对 `wolf-dashboard`） |
| `SCHEDULER_ENABLED`、`REQUEST_TIMEOUT` | 调度开关和普通外部请求超时 |

sidecar 的 host/port 是代码固定的本机地址；不要通过环境变量把它暴露到公网。Agent sidecar 的 Provider 读取同一组 `OPENAI_*` 变量。

## 测试与检查

```powershell
cd wolf-dashboard/backend
$env:PYTHONPATH=(Get-Location).Path
python -m pytest -q

cd ..\agent-sidecar
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

安全的启动/CLI 检查：

```powershell
python ..\scripts\initialize-market.py --help
python ..\scripts\initialize-market.py --symbol sh600519 --dry-run
$null=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path ..\scripts\start.ps1),[ref]$null,[ref]$null)
```

sidecar 运行时依赖固定为 `@earendil-works/pi-agent-core@0.82.1` 和 `@earendil-works/pi-ai@0.82.1`；`npm ci` 应使用锁文件安装，`dist` 为本地构建产物，不提交。

## Agent 工具契约

模型看到的是按业务语义拆分的专用工具，每个工具由 sidecar 固定映射到一个 FastAPI 端点；模型不能传 URL、路径、HTTP 方法或 query key，通用 `quant_api_get` 已从新运行中移除（历史 run 事件仍可读）。

| 工具 | 模型输入 | 固定请求 |
| --- | --- | --- |
| `resolve_symbol` | `query` | `GET /api/v1/symbols/resolve` |
| `get_realtime_quote` | `symbol` | `GET /api/v1/quotes/realtime/{symbol}` |
| `get_price_history` | `symbol`、`adjustment?`、`limit?` | `GET /api/v1/quotes/history/{symbol}` |
| `get_technical_indicators` | `symbol`、`adjustment?`、`limit?` | `GET /api/v1/indicators/technical/{symbol}` |
| `get_universe_summary` | 空对象 | `GET /api/v1/research/universes/summary` |
| `get_universe_members` | `page?`、`page_size?` | `GET /api/v1/research/universes/a-share/members` |
| `get_preset_candidates` | `mode`、`as_of?`、`limit?` | `GET /api/v1/research/screeners/a-share/short-term-candidates` |
| `screen_stocks` | `conditions`、`sort`、`as_of?`、`limit?` | `POST /api/v1/research/screeners/a-share/query` |
| `submit_analysis` | 结构化终态 | sidecar 本地终端工具 |

`symbol` 必须匹配 `^(?:sh|sz|bj)[0-9]{6}$`，名称问题必须先调用 `resolve_symbol`。`load_skill`、`read_skill_reference` 只在本次 run 确实有可用已启用 skill 时注册；`skill_mode=none` 或自动模式无已启用 skill 时模型看不到这两个工具。`load_skill` 返回精确的 `available_references`，其他引用路径一律拒绝。

单轮最多接纳 3 个工具调用，超出的批次整批以 `TOOL_BATCH_LIMIT` 拒绝且不消耗预算；参数校验在预算之前执行，失败返回 `INVALID_TOOL_INPUT`；连续 3 个工具轮全部失败以 `REPEATED_TOOL_FAILURE` 结束。每个调用恰好产生一条 `tool_started` 和一条 `tool_completed`/`tool_failed`。成功结果会向模型返回精确 `tool_call_id`，`submit_analysis.evidence` 必须原样复制该值，不能使用工具名或 `functions.<name>`；Schema 拒绝消息不会持久化完整原始参数。

真实 Provider 验收不进 CI，需在 FastAPI、sidecar 已启动、A 股目录能把“药明康德”解析为 `sh603259` 且无其他活动 run 时显式执行 `npm.cmd run smoke:provider`。脚本要求 run 为 `completed`、必需工具成功、生命周期成对、终端证据引用成功 call ID，并只输出 run ID、状态、工具名、错误码、计数和数据时点。

## 已知限制与故障恢复

MVP 只允许一个活动 Agent run，sidecar 不可用时创建 run 返回 HTTP 503；Provider 未配置返回 `needs_configuration`；超时、取消、无终端提交、工具协议错误和数据源失败均保留可审计错误，不拼接半截模型文本。sidecar 运行期间 `/monitor` 和普通行情 API 仍由 FastAPI 提供。

当前未接入财务三表、估值、行业、主力资金、新闻、公告或自动交易。Tencent/EastMoney 接口可能限流或变更字段；EastMoney 导入只覆盖普通 A 股，不包含 ETF、指数、B 股和旧北交所代码，且不会为每次解析请求远程搜索。NGA 抓取需要 cookie 且可能受站点限制。不要用模型记忆补造行情，也不要把覆盖不足解释成“没有候选”。
