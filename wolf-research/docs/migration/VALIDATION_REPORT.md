# wolf-dashboard -> wolf-research 重构验证报告

验证日期：2026-09-06（含 2026-09-05 重构实施证据）
验证主机：Windows 本地工作站
验证范围：研究工作台 `/`、研究会话 `/{project_id}/chat`、评测中心 `/eval-platform` 及运行详情
`/eval-platform/runs/{runId}`

## 1. 最终结论

**重构切片完成（2026-09-05）。** `wolf-dashboard` 的研究与评测能力已在父级 WolfBot 仓库中
形成可独立运行的 `wolf-research` 目标目录。研究工作台真实 HTTP 主流程、评测中心页面和本地
Windows preview 均有通过记录；使用目标自己的 DeepSeek 官方 Key 执行的 live-model E2E 为
**4/4**，四个用例均有真实 Agent execution、`agentExecuted=true`、100 分和通过的 release
attestation。

本报告区分历史重构验证与当前独立复核，不把 contract/mock 结果冒充真实模型成功。历史报告文件为
`data/eval-reports/report-1788617772549-ef645d8b.json` 和
`data/eval-reports/report-1788618463276-0d61b951.json`；这些本地验证产物不纳入提交。
`Eval schedule` 仍是明确的非核心 `BLOCKED` 项。

### 1.1 独立复核结论

重构实现和历史核心流程验证已完成，但当前工作区的独立验收不应被重新表述为全部通过：

- 直接执行 `npm.cmd run benchmark:quant:contract` 当前为 4/16 通过、12/16 失败；失败主要是
  contract runner 未自动编排 market fixture，导致 `dashboard-data.json`、`sources.json` 和
  `data_quality.json` 缺失。
- Eval queue 没有独立 worker 的启动恢复路径，Web 进程重启后 queued 任务可能长期停留。
- build trace、评测报告错误响应和文件编辑冲突保护仍有 P1 风险，详见独立审查记录。

因此本文件支持“重构已落地”的项目叙事，但不能据此宣称当前工作区满足全部强制验收门槛。

## 2. 已重构范围

- Next.js 页面、根布局、主题和目标导航。
- 研究工作台输入、项目创建、query rewrite、行情预取、run plan、PostgreSQL durable queue、
  PI Agent Mission、看板 artifact、validation、repair、预览和实时恢复。
- 研究所需独立 FastAPI 市场服务：symbols、quotes、history、technical indicators、financials、
  announcements、backtest 和 screener 的目标调用闭包。
- 评测页面、case/set 管理、evaluator、queue、cancel、report detail、scoring、attestation、
  contract benchmark 和 E2E runner。
- 目标内部 Prompt、PI Agent skill registry/lock、公开 benchmark fixtures、Prisma schema 和
  前向约束 migration。
- Auth、quota、Memory、Knowledge 为显式 disabled facade；ClickHouse、Shadow Replay、自动
  schedule 和非目标平台导航未迁移。
- Preview 固定为 Windows 本地生成；`WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE=1`
  才能启用 `windows-unsandboxed`，默认拒绝，不能描述为安全沙箱或 Linux 隔离。

## 3. 分批结果

| 批次 | 结果 | 证据 |
| --- | --- | --- |
| 0 基线 | 通过 | 目标父仓库仍为 `main`；源为 `2015ecdc8f3d891f81ff0a5a8d42a2d2f2dd0a5c`/`main`，dirty snapshot 仍为 35 项；未修改源项目 |
| 1 骨架与配置 | 通过 | 独立 Next、Prisma、FastAPI、preflight、`.env.example` 和目标 lock 可用 |
| 2 共享闭包 | 通过 | skill registry/lock、动态入口、PI runtime、Auth/Memory/Knowledge disabled、路径安全和 singleton 检查通过 |
| 3 研究工作台 | 通过 | `validation-http-20260905-009` 完成 query rewrite、真实行情、durable queue、PI Agent、artifact、validation、Windows preview；桌面/移动检查通过 |
| 4 评测 contract | 历史通过；当前入口失败 | 使用独立 contract market fixture 的历史运行曾实跑 16/16、平均分 95；当前直接入口实跑为 4/16，原因和编排缺口见独立复核结论 |
| 5 评测 E2E | 通过 | product-control 1/1；4 个 DeepSeek live-model 用例 4/4，真实 Agent execution 和 release attestation 通过 |
| 6 清理 | 通过 | 运行时代码无源项目或 `wolf-dashboard` 依赖；生成物清理后复核 |
| 7 文档 | 通过 | README、`.env.example`、根 `PROJECT_MAP.md`、重构方案文档和本报告已同步；本次已获授权提交，更新 `COMMIT_LOG.md` |

## 4. 已执行命令

以下命令均在 `D:\job\EzWin\wolfBot\wolf-research` 或目标市场服务目录执行；没有在
`D:\QuantPilot` 安装依赖、构建或生成缓存。

| 命令 | 结果 |
| --- | --- |
| `npm.cmd ci --ignore-scripts` | 通过 |
| `npm.cmd run prisma:generate` | 通过 |
| `npm.cmd run prisma:deploy` | 未显式注入 `DATABASE_URL` 时按设计失败 `P1012`；Prisma CLI 不读取 `.env.local`，不进入应用半启动状态 |
| `DATABASE_URL=<target-local-validation-db>; npm.cmd run prisma:deploy` | 通过，3 个 migration，无待应用项 |
| `npm.cmd run type-check` | 通过 |
| `npm.cmd run lint` | 通过 |
| `npm.cmd run test:unit` | 通过，73 个文件、540 个测试；历史报告中的 68/504 已由当前测试规模修正 |
| `npm.cmd run build` | 通过 |
| `uv sync --project services/market-data --group dev` | 通过 |
| `npm.cmd run market:test` | 通过，11 个测试；有 2 条依赖弃用警告 |
| `npm.cmd run check:skills` | 通过 |
| `npm.cmd run check:eval-datasets` | 通过 |
| `npm.cmd run check:eval-judge-calibration` | 通过 |
| `npm.cmd run check:eval-mutations` | 通过 |
| `npm.cmd run check:module-boundaries` | 通过 |
| `npm.cmd run check:ai-provider-boundary` | 通过 |
| `npm.cmd run benchmark:quant:contract` | 当前失败，4/16；历史上手动先启动 `run-contract-market-fixture.js` 后为 16/16，package script 未自动编排 fixture |
| `npm.cmd run preflight` | 通过；Windows unsandboxed preview 和 loopback mutation 均由显式配置启用 |
| `npm.cmd run benchmark:quant:e2e -- --model=deepseek-v4-flash --concurrency=1` | 通过，4/4；`provider=deepseek`、`model=deepseek-v4-flash`，每项 `agentExecuted=true`，release attestation 通过 |
| `npm.cmd run start:checked -- --hostname 127.0.0.1 --port 3012` + `Invoke-WebRequest` HTTP smoke | 通过；`/`、`/eval-platform`、`/api/health`、`/api/projects`、`/api/evals` 和市场 `/ready` 均为非空 200；不存在的 run 为 404；停止后 3012 端口已释放 |

专项检查还通过了 dataset、skill lock、judge calibration、mutation、AI provider boundary、
module boundary、PI Agent deterministic tool plan、数据库 schema readiness 和目标页面的桌面/移动
断言。评测 flow simulation 还确认命令包含 `--model=deepseek-v4-flash`，runtime 为
`provider=deepseek` 对应的官方直连注册模型。

## 5. E2E 结果

### 5.1 研究工作台 HTTP 主流程

运行 `validation-http-20260905-009` 的目标链路为：

```text
POST project
  -> query rewrite
  -> market prefetch
  -> PostgreSQL durable generation queue
  -> PI Agent Mission
  -> apply_dashboard_spec / submit_result
  -> workspace artifact
  -> validation
  -> explicit Windows unsandboxed preview
```

该流程通过，且验证了生成看板可访问、数据绑定和桌面/移动布局。研究页面和评测页面的移动
视口也通过加载检查；不存在的评测运行详情返回 404，malformed eval action 返回 400。

独立生产启动 smoke 使用目标自己的 `next start`，没有启动源项目或 `wolf-dashboard`；目标首页、
评测页面、核心 API 和独立市场 `/ready` 均返回非空成功响应，停止时只释放目标端口。

### 5.2 评测中心 live-model E2E

最终执行命令为：

```powershell
npm.cmd run benchmark:quant:e2e -- --model=deepseek-v4-flash --concurrency=1
```

结果为 **4/4**：

- `stock-fundamental-maotai`
- `index-technical-hs300`
- `portfolio-risk-adjustment`
- `stock-diagnosis-citic-custom-no-cards`

每个结果均为 `passed=true`、`agentExecuted=true`、`score=100`；报告中的
`provider=deepseek`、`model=deepseek-v4-flash`、工具执行、Mission acceptance、validation、
preview 和 release attestation 均通过。目标自己的 Key 只通过目标环境注入，未从源项目读取或复制。

历史失败仍保留在 `MIGRATION_PLAN.md` 的实施偏差记录中，包括缺少模型凭据、
`MAX_TURNS`、市场回退契约、预算门禁、`semantic_edit` 契约和 Windows `EPERM`；这些记录说明
修正过程，不改变最新报告的最终结果。固定 query-rewrite stub 只用于早期研究 HTTP/query-rewrite
验证，不能替代真实模型，也没有被写入目标仓库。

### 5.3 未提供的独立测试入口

方案列出的以下入口在目标 `package.json` 中不存在，因此没有冒充执行：

- `test:pi-agent:postgres`
- `test:integration`
- `test:e2e`
- `eval:ci:e2e`
- `check:eval-platform-visual`

影响：现有 unit、HTTP、contract、浏览器 smoke 和 live-model runner 已覆盖本次目标核心流程；
缺失入口仍代表独立的测试编排能力，后续可补成显式 CI 门禁，但不把不存在的脚本冒充已执行。

## 6. 独立性与安全检查

- `D:\QuantPilot`：未修改，仍为原提交、原分支和 35 项 dirty snapshot；该 snapshot 是源项目的迁移基线。
- `wolf-dashboard`：未修改；目标运行时代码、配置、package 和业务启动脚本没有对其的 import、
  路径、process command 或 runtime URL 依赖。两个边界检查脚本只保留字面量来检测违规引用，
  不会加载或连接它；迁移文档中的历史来源文字也不属于运行时依赖。
- `wolf-research/.git`：不存在；未创建嵌套仓库或 submodule。
- `package.json`/lock：无 `file:` 或 `link:` 指向源项目、兄弟项目或 `wolf-dashboard`。
- 目标运行时源码、配置和业务脚本：无 `D:\QuantPilot`、`D:/QuantPilot`、兄弟目录 import 或源运行时
  资源引用；`check-module-boundaries.js` 和 `check-ai-provider-boundary.js` 的反向检查字面量除外。
- 最终机械检查：`git diff --check` 通过；目标候选文件尾随空白为 0；迁移文档、目标 README
  和根 `PROJECT_MAP.md` 的相对链接全部存在；目标敏感 key/token 模式为 0。
- `.env.example`：只含空凭据和安全占位符；未复制源 Cookie、数据库、用户数据或密钥。
- 当前工作区可能保留目标自己的 `node_modules`、`.next`、`data`、`tmp`、`tsconfig.tsbuildinfo` 和
  `services/market-data/.venv`；它们均被 `.gitignore` 排除，不属于迁移交付文件。contract runner
  已清理临时 benchmark 项目，最终报告 artifact 保留在 `data/eval-reports` 供审计；`.pi` 中受
  版本控制的 skill registry/lock/package 资源按目标运行时需要保留。
- 验证 model stub 已停止；目标市场服务和 PostgreSQL 仅作为显式本地基础设施保留时，均不属于目标提交物。
  目标 Next/benchmark runner 在验证结束后已退出；QuantPilot 原有服务未停止。

## 7. 计划偏差和剩余风险

- Port/Adapter：实际建立了 `src/lib/ports/*` 合同文件，但没有创建空的
  `src/lib/adapters/**` 目录；具体实现保留在重构后的 services/server/security/provider 闭包中，
  已在 `MIGRATION_PLAN.md` 和 `SOURCE_TARGET_MAP.md` 记录。
- E2E 模型：DeepSeek 官方 adapter、锁定 Base URL、队列/CLI 参数传递和报告 attestation 已实现并
  通过真实 4-case E2E；目标 Key 不进入仓库。缺失的专用 PostgreSQL/Playwright 编排脚本仍是
  工程化改进项，已有等价的 durable、HTTP、浏览器和 runner 证据，但不冒充这些脚本已执行。
- Eval schedule：没有 UI 调用和主动 scheduler 拓扑，仍是非核心 `BLOCKED`，不影响当前目标路由的
  contract 闭环，但不能描述为已重构自动调度。
- Windows preview：这是受信任本机的显式非沙箱执行，仅适用于当前首版边界；对外或多用户部署仍不在
  验收范围。

## 8. Git 交付状态

- 本次已授权创建重构提交；不推送、不切换分支。
- 当前预期工作区只包含用户授权范围内的 `docs/PROJECT_MAP.md` 和 `wolf-research/` 目标目录。
- `wolf-dashboard` 到 `wolf-research` 的重构切片已纳入本次提交；历史核心流程门槛有通过记录，当前独立复核发现的 contract 和可靠性阻断仍保留在本报告中；`Eval schedule` 作为非核心阻塞项保留。
