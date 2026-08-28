# WolfBot 项目全景图

状态：Wolf Dashboard 本地 MVP 已实现（2026-08-28）

## 当前范围

当前仓库包含维护规范、策略证据材料和 `wolf-dashboard` 可执行服务。后续结构变化仍需在本文件登记，不要把本地数据库、Cookie 或原始导出写入仓库。

## 当前文件树

```text
wolfBot/
├── .gitignore                 # 通用忽略规则
├── .gitmessage                # Git 提交正文模板
├── AGENTS.md                  # 仓库级代理与工程规范
├── CHANGELOG.md               # feat/fix 变更记录
├── CONTRIBUTING.md            # 贡献、提交与评审流程
├── README.md                  # 项目入口与当前状态
└── docs/
    └── PROJECT_MAP.md         # 本文件：全景、定位索引与维护规则
```

## 定位索引

| 需要查找 | 首先阅读 | 说明 |
| --- | --- | --- |
| 开始任务、判断影响范围 | `docs/PROJECT_MAP.md` | 当前树、模块登记和同步触发条件 |
| 代码质量、安全、测试要求 | `AGENTS.md` | 仓库级强制工作约定 |
| 开发和评审流程 | `CONTRIBUTING.md` | 分支、验证和提交步骤 |
| 项目状态和入口 | `README.md` | 面向维护者的概览 |
| feat/fix 原因与修改记录 | `CHANGELOG.md` | 按变更 ID 追溯；其他提交查 Git 历史 |
| 提交正文格式 | `.gitmessage` | 本地 commit template |

## 维护者工作流

```text
任务
  │
  ├─> 阅读 AGENTS.md + 本图，定位影响范围
  │
  ├─> 修改代码 / 测试 / 配置
  │
  ├─> 执行验证并记录真实结果
  │
  ├─> 结构或使用方式变化？──是──> 同提交更新本图 / README
  │
  ├─> feat 或 fix？──────────是──> 同提交更新 CHANGELOG.md
  │
  └─> Conventional Commit（Why / How / Validation）
```

## 未来模块登记表

只有模块实际进入仓库后才新增行。路径、入口和测试位置必须与代码一致。

| 路径 | 职责 | 公共入口 | 数据/依赖 | 测试位置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `wolf-dashboard/backend/app` | FastAPI 后端、NGA、行情、策略与调度 | `/api/*` | Python、SQLite、requests、APScheduler | `wolf-dashboard/backend/tests` | 已实现 |
| `wolf-dashboard/frontend` | 本地仪表盘界面 | `/` | 原生 HTML/CSS/JS | 手工 HTTP 检查 | 已实现 |
| `wolf-dashboard/scripts` | 启动与 Windows 登录任务 | `start.ps1`、`install-task.ps1` | PowerShell、Uvicorn | README 启动步骤 | 已实现 |

## 变更时的更新要求

以下变化必须在同一提交更新文件树、模块登记或数据流说明：

- 新增、删除、移动模块、脚本、公共入口或测试目录。
- 新增或升级运行时依赖、外部服务、配置项、环境变量或持久化介质。
- 改变输入、处理、输出之间的数据流，或改变启动、部署、迁移方式。
- 新增用户行为、兼容性约束、测试命令或人工操作步骤。

新增模块时至少补充：职责、入口、输入输出、依赖、错误边界、测试位置和维护状态。删除模块时移除对应登记，并在变更记录中说明迁移或替代关系。

## 完整性检查

每次提交前确认：

- 文件树与 `git ls-files` 一致，没有把缓存或本地文件写进图中。
- 索引链接仍然有效，命令和路径没有过期。
- 结构变化、依赖变化和用户可见变化已经在本图或 README 反映。
- 本图没有记录不在远端仓库中的私有数据内容。

## Wolf Dashboard 实现登记

仓库现在包含 `wolf-dashboard` 本地服务：FastAPI + SQLite 后端、静态仪表盘、NGA 增量采集、行情快照、策略版本和回归测试。原始 Excel/Markdown 仍只作为本地种子材料，不写入提交产物。NGA/AI 的阻塞请求通过线程池执行，长时间推理不会冻结状态和发言接口；AI 思考强度可由 `OPENAI_REASONING_EFFORT` 配置，独立超时由 `OPENAI_REQUEST_TIMEOUT` 控制且上限为 1200 秒。

管理接口还包括 `DELETE /api/watchlist/{code}` 和 `GET /api/aliases`；目录级运行说明见 `wolf-dashboard/README.md`。

```text
wolf-dashboard/
  backend/app/config.py       .env 与运行配置
  backend/app/db.py           SQLite schema、事件和事务
  backend/app/nga.py          NGA lite=js 解析、作者过滤分页与游标迁移
  backend/app/seed.py         Markdown 文章与 E25 规则导入
  backend/app/market.py       代码归一化与腾讯行情
  backend/app/strategy.py     AI JSON、引用校验与版本
  backend/app/scheduler.py    5 分钟、08:30 和盘中任务
  backend/app/main.py         FastAPI API、SSE 与静态页
  backend/tests/              解析、采集、策略和 API 回归测试
  frontend/                   本地仪表盘 HTML/CSS/JS
  scripts/                    启动与 Windows 登录任务脚本
```
