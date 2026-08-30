# WolfBot

WolfBot 是一个本地优先的研究与监控项目。`wolf-dashboard` 由 FastAPI/SQLite 后端、原生 HTML/CSS/JS 前端和本地 TypeScript PI Agent sidecar 组成。服务默认只绑定回环地址，不提供自动交易、账户连接或投资收益承诺。

## 文档入口

- [AGENTS.md](AGENTS.md)：仓库级工程约定。
- [项目全景图](docs/PROJECT_MAP.md)：文件、模块、数据流和验证命令索引。
- [WolfBot Agent MVP 计划](docs/improvement-plans/wolfbot-agent-mvp.md)：产品边界与验收矩阵。
- [wolf-dashboard 运行说明](wolf-dashboard/README.md)：完整的本地启动、配置、市场初始化和恢复步骤。
- [第三方归因](THIRD_PARTY_NOTICES.md)：QuantPilot MIT 改编范围。
- [CONTRIBUTING.md](CONTRIBUTING.md)：分支、验证、提交和评审流程。

## MVP 页面

- `/`：Agent 工作台。提交独立研究问题，选择自动、指定或不使用 skill，查看公开工具轨迹、证据、回答、候选表和本地 SVG K 线。
- `/skills`：本地 skill 注册表。可以上传 ZIP/TGZ/TAR.GZ，启用或停用 skill，查看内容；内置 skill 不能卸载。
- `/monitor`：原有 NGA 发言、引用、行情快照、watchlist 和策略总结仪表盘。

浏览器只访问 FastAPI；Agent sidecar 不直接接触 SQLite、浏览器或外部行情源。Agent 的唯一市场访问路径是 FastAPI 的只读 `/api/v1/` allowlist。

## 前置条件

- Windows PowerShell。
- Python 3.10 或更高版本。
- Node.js 22 或更高版本及 npm。
- 可访问腾讯行情接口的网络；NGA 抓取还需要有效的 `NGA_COOKIE`。
- Agent 研究需要 OpenAI-compatible Provider 的 `OPENAI_API_KEY`；没有 key 时会得到明确的 `needs_configuration`，不会生成无来源结论。

## 启动

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

启动脚本会检查 venv 中的 FastAPI/Uvicorn、Node/npm、sidecar 依赖和 `dist/main.js`，然后以前台方式管理两个进程：FastAPI `127.0.0.1:8787` 与 sidecar `127.0.0.1:8790`。任一进程异常退出时会停止另一进程并返回非零码；Ctrl+C 也会清理两个进程。启动不会执行全市场初始化。

打开 <http://127.0.0.1:8787/>。登录后启动任务可执行：

```powershell
.\scripts\install-task.ps1
```

## API 概览

Agent 浏览器 API 位于 `/api/v1/runs`，包括创建、查询、SSE `/api/v1/runs/{run_id}/events` 和取消 `/api/v1/runs/{run_id}/cancel`；`/api/v1/agent/runs` 是兼容别名。Skill API 位于 `/api/v1/skills`。行情和研究 API 包括证券解析、实时行情、前复权日 K、技术指标、股票池摘要/成员和固定或白名单 DSL 筛选器，详见 [wolf-dashboard/README.md](wolf-dashboard/README.md)。

原有接口仍保留：`/api/status`、`/api/posts`、`/api/strategies`、`/api/watchlist`、`/api/aliases`、`/api/tasks/crawl`、`/api/tasks/strategy` 和 `/api/events`（SSE）。

## 市场初始化

市场初始化是显式命令，不属于服务启动流程。无参数时 CLI 通过 EastMoney `push2/api/qt/clist/get` 导入当前沪深和北交所 920xxx A 股普通股目录，再通过 Tencent `MarketSyncService` 拉取前复权日线；显式 symbol/文件模式保留用于小范围恢复，不会把 fixture 冒充全市场：

```powershell
cd wolf-dashboard
backend/.venv/Scripts/python.exe .\scripts\initialize-market.py --symbol sh600519 --symbol sz300750 --dry-run
backend/.venv/Scripts/python.exe .\scripts\initialize-market.py --symbol sh600519 --symbol sz300750
```

也可用 UTF-8 文本文件（每行一个 `sh`/`sz`/`bj` canonical symbol）：

```powershell
backend/.venv/Scripts/python.exe .\scripts\initialize-market.py --symbols-file .\symbols.txt
```

不提供 `--symbol` 或 `--symbols-file` 时执行全 A 股目录导入。首次全量历史同步通常需要数十分钟到数小时，耗时取决于 Tencent 响应和证券数量；可先用 `--max-symbols 20 --history-limit 120 --dry-run` 检查目录，或用 `--max-symbols` 做受控 smoke run。`--dry-run` 只读取 EastMoney 目录并打印计划，不打开 SQLite、不调用 Tencent；显式 symbol 的 dry-run 完全不联网。

EastMoney 目录请求复用一个 HTTP session，分页请求串行执行，页间至少等待 1 秒并带少量抖动；连接错误、429 和 5xx 会退避重试，403、畸形 JSON、空目录和不完整分页会明确失败。目录导入不会按 symbol 逐个访问 EastMoney。每个标的执行一次腾讯前复权日线请求，默认最多 800 条；命令输出 JSON 的覆盖率和错误，部分失败返回非零码。重复运行是恢复方式：数据库使用 upsert，不要删除 SQLite；用下面的接口检查覆盖率和最近交易日：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/v1/research/universes/summary?universe_id=a-share
Invoke-RestMethod http://127.0.0.1:8787/api/v1/research/universes/a-share/members
```

网络或单标的失败时，重新运行失败标的即可。覆盖率不足时，Agent 必须显示警告，不能声称全 A 股没有候选。

## 测试

```powershell
cd wolf-dashboard/backend
$env:PYTHONPATH=(Get-Location).Path
python -m pytest -q

cd ..\agent-sidecar
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

启动/CLI 的无副作用检查：

```powershell
python ..\scripts\initialize-market.py --help
python ..\scripts\initialize-market.py --symbol sh600519 --dry-run
$null=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path ..\scripts\start.ps1),[ref]$null,[ref]$null)
```

## 已知限制

MVP 只使用腾讯报价/日线和本地 SQLite；EastMoney 仅用于一次性的 A 股目录和名称导入，`/api/v1/symbols/resolve` 使用本地已导入目录，不提供每次查询的远程证券搜索。导入器只保留沪深普通股和当前北交所 920xxx，排除 ETF、指数、B 股及旧北交所 43/83/87 代码。财务、估值、行业、资金、新闻和公告数据不在当前证据范围内。Agent 只有在终端工具提交 `completed` 或 `insufficient_evidence` 后才展示结论；Provider 未配置、sidecar 离线、覆盖不足、超时、取消和无终端提交均会显示明确状态。

NGA 抓取需要 cookie，外部接口可能限流或字段变化。行情和抓取失败会保留错误/待核验状态，不用模型记忆补造数据。页面和本地数据库均不应写入密钥、Cookie、原始敏感导出或生成物。
