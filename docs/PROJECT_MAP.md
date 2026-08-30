# WolfBot 项目全景图

状态：Wolf Dashboard Agent MVP 实现已进入工作区，最终端到端验收待完成（2026-08-29）。

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
│       └── wolfbot-agent-mvp.md        # Agent MVP 计划与验收矩阵
├── skills/
│   └── wolf-investing/                # 公开、脱敏的内置 skill
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
    │   ├── package.json                # Node 脚本与固定依赖
    │   ├── package-lock.json           # npm 锁文件
    │   └── THIRD_PARTY_NOTICE.md       # sidecar 局部 QuantPilot 归因
    ├── frontend/
    │   ├── agent.{html,css,js}         # `/` Agent 工作台
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
| `wolf-dashboard/backend/app/skills.py` | 内置/上传 skill 发现、归档安全、启停、卸载和内容读取 | `/api/v1/skills/*` | SQLite、`skills/`、`data/skills/` | `test_skills.py`、skill validator | 已实现 |
| `wolf-dashboard/agent-sidecar/src` | PI Agent 循环、OpenAI-compatible Provider、五工具边界和取消 | `:8790/healthz`、`/internal/v1/runs` | Node >=22、PI 0.82.1、FastAPI 只读 allowlist | typecheck、build、Vitest | 已实现 |
| `wolf-dashboard/frontend/agent.*` | Agent 工作台、事件轨迹、证据、候选和 SVG K 线 | `/` | 原生浏览器 API、FastAPI SSE | 桌面/移动 HTTP 与浏览器检查 | 已实现 |
| `wolf-dashboard/frontend/skills.*` | skill 上传、启停、卸载和内容查看 | `/skills` | FormData、Skill API | HTTP 与浏览器检查 | 已实现 |
| `wolf-dashboard/frontend/index.html`、`app.js`、`styles.css` | 原有发言监控、行情和策略页 | `/monitor` | 旧 `/api/*`、NGA 数据 | API 回归与浏览器检查 | 已迁移 |
| `wolf-dashboard/scripts/start.ps1` | 检查前置条件、启动/监控/清理 FastAPI 与 sidecar | Windows PowerShell | venv、Node/npm、built sidecar | PowerShell parser、手工双进程检查 | 已实现 |
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
  └─ 受校验的 skill 管理
       │ internal NDJSON / cancellation
       ▼
PI sidecar :8790 ── OpenAI-compatible Provider
  └─ 只能通过受控五工具访问 FastAPI `/api/v1/`

EastMoney ── paginated security catalog ──> explicit initialize-market CLI
Tencent ─── realtime/history ────────────> FastAPI market layer / initialize-market CLI
NGA ─────── posts/strategy ───────────────> FastAPI legacy monitor layer
```

FastAPI 启动会初始化 SQLite、读取本地种子并启动 scheduler；`start.ps1` 不调用市场初始化 CLI。Agent sidecar 不访问 SQLite、任意文件、Shell 或外部行情接口。sidecar 不可用时 Agent 创建请求返回 503，`/monitor` 和普通行情 API 仍可用。

市场 CLI 无显式 symbol 时通过 EastMoney `push2/api/qt/clist/get` 分页导入沪深和当前北交所 920xxx 普通 A 股；导入复用单一 session、串行请求并在分页间至少等待 1 秒加抖动，连接/429/5xx 退避重试，403、畸形 JSON、空或不完整响应明确失败。显式 `sh/sz/bj` symbol 或文本文件仍用于受控恢复。导入排除 ETF、指数、B 股及旧北交所 43/83/87 代码；`default_catalog()` 仍只是 fixture，`/api/v1/symbols/resolve` 使用本地已导入目录而不宣称远程搜索。同步使用 upsert，可通过 `/api/v1/research/universes/summary` 和 `/members` 检查覆盖率，失败后重跑受影响标的。

## 依赖和验证命令

- Python：在 `backend/.venv` 安装 `backend/requirements.txt`，`$env:PYTHONPATH` 指向 `backend` 后运行 `python -m pytest -q`。
- Node：Node.js >=22；在 `agent-sidecar` 运行 `npm.cmd ci`、`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`。
- 启动：先安装 Python 依赖并构建 sidecar，再运行 `scripts/start.ps1`；脚本会探测 FastAPI/Uvicorn，并要求 `node_modules`、PI 依赖目录和 `dist/main.js` 均存在。
- CLI：`backend/.venv/Scripts/python.exe scripts/initialize-market.py --help`；显式 symbol 的 `--dry-run` 不联网、不写库，全量 `--dry-run` 只读取 EastMoney 目录、不写 SQLite、不调用 Tencent 历史。全量历史同步应使用 `--max-symbols`/`--history-limit` 做 smoke 或恢复边界。
- 完成前：运行 `git diff --check`、文档链接/路径检查、敏感文件扫描和 `git status --short`；不要提交 `node_modules`、`dist`、缓存、SQLite、日志或 `data/skills`。

## 文档同步规则

以下变化必须同步更新本图和相关 README：新增/删除/移动模块、脚本、入口或测试；运行时依赖、环境变量、外部服务或持久化介质变化；数据流、启动方式、部署约束、用户页面或测试命令变化。只调整措辞且不改变结构时不必更新本图，但 README、规范和代码事实必须一致。

`docs/improvement-plans/` 是计划索引，保留其计划态说明。每个提交仍须按 `AGENTS.md` 更新 `COMMIT_LOG.md`；`feat`/`fix` 还须更新 `CHANGELOG.md`。本任务未授权提交或推送。
