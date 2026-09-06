# wolf-dashboard 研究能力重构调查报告

调查日期：2026-09-04

## 1. 范围与证据基线

- 历史参考源：`D:\QuantPilot`，只读调查；不属于目标运行时依赖。
- 重构目标：`D:\job\EzWin\wolfBot\wolf-research`，承接 `wolf-dashboard` 的研究与评测能力。
- Git 仓库根目录：`D:\job\EzWin\wolfBot`。
- 源提交：`2015ecdc8f3d891f81ff0a5a8d42a2d2f2dd0a5c`，分支 `main`。
- 目标仓库分支：`main`，跟踪 `origin/main`。
- 调查开始时目标仓库工作区干净，`wolf-research` 不存在。
- WolfBot 根目录没有 npm、pnpm、Python 或其他 workspace 聚合配置，`wolf-research` 需要作为父 Git 仓库中的独立应用目录建立。
- 源项目采用 MIT License；已确认重构代码保留 MIT 许可证和来源归因。

实施复核（2026-09-05）：阶段三/四已按本报告边界建立重构目标实现。研究工作台 HTTP 主流程、
评测 contract 和 DeepSeek 官方 live-model E2E 均有通过记录；目标动态入口、路径别名、singleton、
市场端点和 Windows 本地 preview 已通过构建、单元/市场测试、边界检查及页面/HTTP smoke 复核。
自动 Eval schedule 仍没有可确认的主动触发拓扑，因此继续标记为非核心 `BLOCKED`。

独立复核（2026-09-06）确认运行时代码未依赖 `D:\QuantPilot` 或 `wolf-dashboard`，同时发现
contract 直接入口、Eval queue 重启恢复和构建产物敏感文件追踪仍需后续修复；这些问题不改变
本报告对重构边界的描述，但会影响最终验收结论。

状态标记：

- **已确认**：由当前源工作区文件、符号或配置直接确认。
- **推测**：根据调用关系推导，实施前应通过测试或运行确认。
- **待验证**：缺少部署环境、外部服务或产品决策，当前不能定论。

> **已确认**：源工作区当前有 35 个未提交项，其中包括研究链关键文件
> `src/app/[project_id]/chat/page.tsx`、`src/lib/domains/finance/query-rewrite*.ts`、
> `src/lib/quant/data-prefetch.ts`、`src/lib/quant/finance-act-preparation.ts`、
> `src/lib/agent/skills/compiler.ts` 和市场数据服务文件。本文描述的是
> “提交 `2015ecdc...` 加当前工作区修改”的实际代码，而不是纯净提交内容。
> 用户已确认以该 dirty snapshot 作为迁移基线。阶段三批次 0 必须只读记录候选文件
> SHA-256、dirty 标志和清单，以便后续复核；源文件发生变化时停止当前批次并重新核对。

## 2. 技术栈与启动方式

| 层 | 已确认技术 | 证据 |
| --- | --- | --- |
| Web | Next.js `16.2.12`、React `19.2.6`、TypeScript `6.0.3` | `package.json` |
| UI | Tailwind CSS `3.4.19`、Radix UI、lucide-react、framer-motion、recharts | `package.json`、`tailwind.config.ts` |
| Web 测试 | Vitest `4.1.10`、Playwright `1.60.0`、ESLint `9.39.4` | `package.json`、`vitest.config.ts` |
| Agent | `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai` `0.82.1` | `package.json` |
| Web 数据库 | Prisma `6.19.3`、PostgreSQL/TimescaleDB | `package.json`、`prisma/schema.prisma` |
| 缓存 | Redis，可选文件缓存 | `docker-compose.yml`、`services/market-data/src/quantpilot_market_data/cache.py` |
| 实时通道 | WebSocket，SSE 回退，最终轮询 | `src/hooks/useWebSocket.ts`、`src/components/chat/ChatLog.tsx` |
| 市场服务 | Python `>=3.14`、FastAPI、Pydantic、psycopg、httpx、uv | `services/market-data/pyproject.toml` |
| 市场 Provider | EastMoney；历史链含 Tencent 回退；可选 BaoStock、AkShare | `services/market-data/src/quantpilot_market_data/providers/`、`services/kline_gateway.py` |
| 进程执行 | Node child process、独立 generation worker、独立 benchmark runner、每项目 Next.js preview | `scripts/workers/generation-worker.ts`、`src/lib/eval/runtime.ts`、`src/lib/services/preview.ts` |

源项目命令，均来自 `package.json`，本阶段未执行：

```text
npm run dev
npm run dev:web
npm run dev:market
npm run build
npm run lint
npm run type-check
npm run test:unit
npm run test:backend
npm run worker:generation
npm run benchmark:quant:contract
npm run benchmark:quant:e2e
```

关键构建约束：

| 结论 | 状态 | 证据 |
| --- | --- | --- |
| Node 版本要求 `>=22.19.0`，npm `>=10.0.0` | 已确认 | `package.json#engines` |
| Python 版本要求 `>=3.14` | 已确认 | `services/market-data/pyproject.toml` |
| TypeScript 使用 `@/* -> ./src/*` 等路径别名 | 已确认 | `tsconfig.json#compilerOptions.paths` |
| Prisma、`ws` 被保留为服务端外部包 | 已确认 | `next.config.js#serverExternalPackages` |
| Next standalone 构建、路由 trace 和安全响应头由环境开关控制 | 已确认 | `next.config.js` |
| 源目录已有 `.next`、`node_modules`、`.ruff_cache` 等生成物，本阶段未读取其内容作为迁移基准 | 已确认 | 源根目录清单 |

### 2.1 启动与安装的隐式副作用

| 结论 | 状态 | 证据 |
| --- | --- | --- |
| `package.json#postinstall` 会执行 `scripts/dev/setup-env.js` | 已确认 | `package.json#scripts.postinstall` |
| `setup-env.js#ensureEnvironment` 会写入 `.env`、`.env.local`，填充数据库、Redis、ClickHouse、工作区等默认值，并可能生成 Auth secret | 已确认 | `scripts/dev/setup-env.js#ensureEnvironment` |
| `run-web.js#startWebDevServer` 会再次执行环境生成、stable CSS 构建、degradation 自动恢复、Prisma migrate deploy、Auth/quota policy bootstrap，以及 Next 缓存和锁清理 | 已确认 | `scripts/dev/run-web.js#startWebDevServer`、`ensureDatabaseSynced`、`restoreRecoveredDegradationComponents` |
| `run-full.js#main` 会启动或复用 market service，并按配置启动 generation worker，再启动 Web | 已确认 | `scripts/dev/run-full.js#main`、`startMarketApiIfNeeded`、`startGenerationWorkerIfNeeded` |

这些行为不能随 `package.json` 原样迁移。目标不得在依赖安装时写本地配置或生成 secret；数据库迁移、
市场服务、Web、worker 和预览进程必须由显式 startup coordinator 管理，Auth/quota bootstrap
从首版启动链删除。启动失败必须指出具体步骤，不得通过 degradation 自动恢复把 required 服务故障
改写成半可用成功。

### 2.2 路径别名、动态加载与模块初始化

`tsconfig.json#compilerOptions.paths` 已确认包含：

- `@/* -> ./src/*`
- `@/types/{shared,client,server,backend}` 及其子路径
- `react-icons/{fa,si,vsc}` 到 `src/stubs/react-icons-*.tsx`

编译图外依赖：

| 依赖 | 调用位置 | 状态 |
| --- | --- | --- |
| 首页动态加载 `GlobalSettings`、`TaskDrawer` | `src/app/page.tsx#dynamic` | 已确认 |
| Query rewrite LLM adapter | `src/lib/domains/finance/query-rewrite.ts#rewriteQuantQuery` | 已确认 |
| PI Agent core 和生成执行器 | `src/lib/agent/pi/run-engine.ts`、`src/lib/quant/finance-generation-executor.ts` | 已确认 |
| validation、scaffold、preview | `chat-act-support.ts`、`generation-validation.ts`、`generation-preview.ts`、preview/validation API routes | 已确认 |
| Playwright Chromium | `src/lib/quant/visual-validation.ts`、`scripts/evals/run-quant-benchmarks.js` | 已确认 |
| Benchmark runner 动态加载 chat act route | `scripts/evals/run-quant-benchmarks.js` | 已确认 |
| `tsconfig-paths/register` + `jiti` 加载 TypeScript | benchmark 和多个 eval/check scripts | 已确认 |

`jiti` 和 `tsconfig-paths` 只在源 lockfile 的传递依赖中出现，没有列入源 `package.json` 的直接依赖。
目标若继续使用这些 runner，必须直接声明固定版本；也可以改成目标已有的显式 TS runtime，但不能依赖
传递安装偶然可用。

模块加载还会产生以下初始化：

- `src/lib/quant/data-agent-application.ts` 在模块加载时注册 finance application adapter。
- `src/lib/db/client.ts` 用 `global` 复用 Prisma client，但其
  `PRISMA_CLIENT_CONTRACT` 当前夹带 `access-quota-management` 和
  `governed-knowledge-growth` 版本标签。
- `src/lib/services/preview.ts` 在 `globalThis` 保存 `PreviewManager`。
- `src/lib/services/stream.ts` 在 `globalThis` 保存 `StreamManager`。
- `src/lib/server/websocket-manager.ts` 创建全局 manager，并由 `ensureHeartbeat` 安装 heartbeat timer。
- `src/pages/api/ws/[projectId].ts#handler` 在底层 HTTP server 上一次性安装 upgrade listener。

目标已为注册、singleton、timer 和 listener 定义幂等初始化与清理测试，覆盖 Next HMR、重复 route
加载、Web/worker 进程边界和正常退出；具体执行结果见 `VALIDATION_REPORT.md`。

## 3. 全局页面壳与横切依赖

### 3.1 根布局

调用链：

```text
src/app/layout.tsx#RootLayout
  -> src/app/globals.css
  -> src/contexts/ThemeContext.tsx#ThemeProvider
  -> src/contexts/AuthContext.tsx#AuthProvider
  -> src/contexts/GlobalSettingsContext.tsx#GlobalSettingsProvider
  -> framer-motion#MotionConfig
  -> src/components/auth/AuthUserMenu.tsx#AuthUserMenu
```

| 结论 | 状态 | 证据 |
| --- | --- | --- |
| 两个目标页面均依赖根布局的主题、认证、全局模型设置和 motion 配置 | 已确认 | `src/app/layout.tsx#RootLayout` |
| 鉴权默认模式来自 `config/auth.json`，源码默认允许 `disabled` 本地系统管理员模式 | 已确认 | `src/lib/config/auth.ts#getProjectAuthConfig`、`src/lib/auth/action.ts#requireAction` |
| `AuthContext.tsx` 即使运行于 disabled 模式，仍静态导入 `src/lib/auth/client.ts#authClient`，从而把 Better Auth 拉入编译闭包 | 已确认 | `src/contexts/AuthContext.tsx` |
| `layout.tsx` 和 `PageHeader.tsx` 静态导入 `AuthUserMenu`；该组件包含账户、管理和退出入口 | 已确认 | `src/app/layout.tsx#RootLayout`、`src/components/layout/PageHeader.tsx#PageHeader` |
| `GlobalSettingsProvider#refresh` 读取失败时只记录 warning 并继续使用默认值 | 已确认 | `src/contexts/GlobalSettingsContext.tsx#refresh` |
| 目标首版只能保留正式 disabled local-system facade；源 `AuthProvider`、`AuthUserMenu` 和 `src/proxy.ts` 不能原样迁移 | 已确认 | 用户决策和上述静态 import 闭包 |
| projects route、project service 和 user request service 静态导入 quota reservation/reconciliation/capacity | 已确认 | `src/app/api/projects/route.ts`、`src/lib/services/project.ts`、`src/lib/services/user-requests.ts` |

目标根布局应使用 Theme、最小 Global Settings、Motion 和不依赖 Better Auth 的 local-system context。
`PageHeader` 的账户区域需要改为主题切换或本地模式指示；`src/proxy.ts` 若保留 same-origin 防护，必须
重写为不导入 `auth/access`、`auth/audit` 或 Better Auth 的最小边界。
项目创建、删除和 request claim 也必须改写为不导入 `src/lib/quota/**` 的目标实现。

### 3.2 样式、图标和静态资源

必须评估的资源：

- `src/app/globals.css`
- `tailwind.config.ts`
- `postcss.config.js`
- `components.json`
- `src/components/ui/**`
- `src/components/layout/PageHeader.tsx`
- `src/components/layout/PlatformSwitcher.tsx`
- `src/assets/home-anime-quant-researcher-v3.webp`
- `src/assets/dashboard-generation-anime-v1.webp`
- `public/quantpilot-mark.svg`、favicon、manifest 中实际被目标页面引用的品牌资源
- `src/stubs/react-icons-*.tsx`，因为 `tsconfig.json` 将三个 `react-icons` 子路径映射到本地 stub

`PlatformSwitcher` 当前链接到多个非目标平台。目标中应保留视觉组件，但菜单只暴露 `/` 和
`/eval-platform`，或为已移除入口提供明确的“不可用”状态，不能留下 404 导航。

## 4. 研究工作台实际边界

### 4.1 路由边界

| 路由 | 作用 | 状态 | 证据 |
| --- | --- | --- | --- |
| `/` | 创建研究项目并提交首轮问题 | 已确认 | `src/app/page.tsx#HomePage` |
| `/{project_id}/chat` | 研究执行、进度、消息、看板预览、文件检查和后续追问 | 已确认 | `src/app/[project_id]/chat/page.tsx#ChatPage` |
| `/api/projects/**` | 项目创建、读取、更新、删除及运行状态 | 已确认 | `src/app/api/projects/**` |
| `/api/chat/{project_id}/**` | act、消息、活动请求、暂停、SSE | 已确认 | `src/app/api/chat/[project_id]/**` |
| `/api/ws/{projectId}` | WebSocket warm-up 和 HTTP upgrade | 已确认 | `src/pages/api/ws/[projectId].ts#handler` |
| `/api/assets/{project_id}/**` | 图片上传和读取 | 已确认 | `src/app/api/assets/[project_id]/**` |
| `/api/repo/{project_id}/**` | 工作区文件树、读取和编辑 | 已确认 | `src/app/api/repo/[project_id]/**` |
| `/api/projects/{project_id}/quant/validation` | 手动读取或重跑验证 | 已确认 | `src/app/api/projects/[project_id]/quant/validation/route.ts` |
| `/api/projects/{project_id}/preview/**` | 预览启动、停止和状态 | 已确认 | `src/app/api/projects/[project_id]/preview/**` |
| `/api/projects/{project_id}/agent/approvals/**` | 高风险工具审批 | 已确认 | `src/app/api/projects/[project_id]/agent/approvals/**` |

> **已确认**：用户要求的“路由为 `/` 的研究工作台”并不是单页功能。
> `HomePage#handleSubmit` 成功后强制跳转到 `/{project_id}/chat`。不迁移该动态路由及其后端链，
> `/` 只能创建记录，不能完成研究和生成看板。

### 4.2 首页提交链

`src/app/page.tsx#HomePage.handleSubmit` 的顺序：

```text
用户问题、模型、能力、图片
  -> POST /api/projects
     -> src/lib/services/project.ts#createProject
     -> 数据库创建 Project
     -> staging workspace
     -> data-agent application provision + skills install
     -> staging rename 为最终 workspace
     -> Project.status 更新为 idle
  -> 对每个附件 POST /api/assets/{projectId}/upload
  -> POST /api/chat/{projectId}/act
  -> router.push("/{projectId}/chat?cli=...&model=...&mode=...")
```

请求契约的关键符号：

- 项目创建：`src/app/api/projects/route.ts#createProjectRequestSchema`
- 研究请求：`src/lib/quant/chat-act-contract.ts#chatActRequestSchema`
- 图片附件：`src/lib/quant/chat-act-contract.ts#chatActImageAttachmentSchema`
- 项目服务：`src/lib/services/project.ts#createProject`
- 研究请求 claim：`src/lib/services/user-requests.ts#claimUserRequest`

源首页没有发送 `Idempotency-Key`，项目创建 API 只在存在 Auth session 时把该 header 用于 quota
reservation；disabled 模式不能据此宣称已有完整项目创建幂等。源首页也没有发送 `requestId`，
chat act route 会生成 request ID 后再执行 `claimUserRequest`。目标应保留服务端 claim 语义，并由
首页为项目创建和 chat act 显式生成、复用操作 ID，覆盖网络重试不重复创建项目或执行研究。

### 4.3 聊天工作区前端链

关键组件和状态：

```text
src/app/[project_id]/chat/page.tsx#ChatPage
  -> src/components/chat/ChatInput.tsx
  -> src/components/chat/ChatLog.tsx
  -> src/components/chat/ChatLogView.tsx
  -> src/components/chat/DashboardGenerationWaiting.tsx
  -> src/components/chat/ToolApprovalPanel.tsx
  -> src/components/settings/ProjectSettings.tsx
  -> src/hooks/useUserRequests.ts
  -> src/hooks/useWebSocket.ts
  -> 本地 preview iframe 和文件树状态
```

`ChatInput.tsx` 静态导入并渲染 `PersonalMemoryComposer`；`ChatLogView.tsx` 静态导入
`PersonalMemoryCandidateCard`、`PersonalMemoryFeedback` 和 `GovernedKnowledgeFeedback`。
首版不迁移反馈 UI 时，必须修改这两个宿主组件的 import 和 render 分支；只关闭 Memory/Knowledge
运行时开关不能消除编译依赖。

前端实际访问的核心接口：

- `GET/PUT /api/projects/{projectId}`
- `POST /api/chat/{projectId}/act`
- `GET/POST/DELETE /api/chat/{projectId}/messages`
- `GET /api/chat/{projectId}/requests/active`
- `POST /api/chat/{projectId}/pause`
- `GET /api/projects/{projectId}/generation/status`
- `GET/POST /api/projects/{projectId}/quant/validation`
- `POST /api/projects/{projectId}/preview/start`
- `POST /api/projects/{projectId}/preview/stop`
- `POST /api/projects/{projectId}/retry-initialization`
- `GET/PUT /api/repo/{projectId}/file`
- `GET /api/repo/{projectId}/tree`
- `POST/GET /api/assets/{projectId}/**`
- `GET/POST /api/projects/{projectId}/agent/approvals/**`
- `GET /api/settings/cli-status`
- `GET /api/settings/global`、`GET /api/settings`

当前页面还调用 GitHub、Vercel 和 project service 接口。它们属于发布旁支，不属于“问题到研究看板”
的核心链，方案分类为 `REMOVE`。删除这些入口时必须同时删除 UI 状态和请求，不能保留失效按钮。

### 4.4 实时状态链

```text
服务端业务代码
  -> src/lib/services/stream.ts#StreamManager.publish
     -> src/lib/server/websocket-manager.ts#websocketManager.broadcast
     -> 当前进程内 SSE controllers

浏览器
  -> src/hooks/useWebSocket.ts#useWebSocket
     -> /api/ws/{projectId}
  -> 连接失败后 src/components/chat/ChatLog.tsx 启用 EventSource
     -> /api/chat/{projectId}/stream
  -> WebSocket 和 SSE 都不可用时轮询 messages/status
```

| 结论 | 状态 | 证据 |
| --- | --- | --- |
| WebSocket 使用 Pages Router API，并在底层 HTTP server 上注册 upgrade listener | 已确认 | `src/pages/api/ws/[projectId].ts#handler` |
| WS warm-up 和真实 upgrade 都执行项目授权，upgrade 还验证 Origin | 已确认 | `handler`、`isAllowedWebSocketOrigin` |
| SSE 连接保存在进程内 `Map`，WebSocket manager 也是进程本地单例 | 已确认 | `src/lib/services/stream.ts`、`src/lib/server/websocket-manager.ts` |
| 首版 Windows 单机可保留 Web 进程内 WS/SSE，并以持久化 messages/status polling 作为跨 worker 和断线恢复；Redis fan-out 不作为首版强制条件 | 已确认 | 用户部署决策和当前 durable 状态读取链 |
| 若未来改为多 Web 实例，当前内存广播不足，需要 Redis pub/sub 或 durable event adapter | 推测 | 当前没有跨进程 fan-out |

### 4.5 后端执行主链

```text
POST /api/chat/{project_id}/act
  src/app/api/chat/[project_id]/act/route.ts#POST
  -> requireAction("agent.run")
  -> parseChatActRequest
  -> claimUserRequest
  -> normalizeDataAgentImageAttachment
  -> ensureProjectLlmConfiguration
  -> recallPersonalization / governed knowledge lookup
  -> prepareFinanceActGeneration
     src/lib/quant/finance-act-preparation.ts
     -> rewriteQuantQuery
        src/lib/domains/finance/query-rewrite.ts
        -> rewriteQuantQuerySemanticsWithConfiguredProvider
           src/lib/domains/finance/query-rewrite-llm.ts
        -> symbols/resolve
     -> writeInitialRunPlan
        src/lib/domains/finance/workspace.ts
     -> prefetchQuantDataForRunPlan
        src/lib/quant/data-prefetch.ts
     -> create/refresh Mission
        src/lib/services/pi-agent-mission-control.ts
        src/lib/services/pi-agent-mission-store.ts
  -> enqueueQuantGeneration 或 startQuantGenerationQueued
     src/lib/quant/generation-queue.ts
  -> createFinanceGenerationEnvelope
     src/lib/quant/finance-generation-executor.ts
  -> createApplicationGenerationRuntime
     src/lib/quant/generation-runtime.ts
  -> executePiAgent
     src/lib/services/cli/pi-agent.ts
     -> PiAgentRunEngine
        src/lib/agent/pi/run-engine.ts
     -> Finance tools
        src/lib/domains/finance/agent-tools/factory.ts
  -> generation validation and repair
     src/lib/quant/generation-validation.ts
     src/lib/quant/validation.ts
     src/lib/quant/visual-validation.ts
  -> Mission evidence verification and candidate sealing
  -> startPersistentValidatedPreview
     src/lib/quant/generation-preview.ts
     -> src/lib/services/preview.ts#PreviewManager
```

队列模式：

- `PI_AGENT_DISPATCH_MODE=worker` 时，`enqueueQuantGeneration` 写入 PostgreSQL durable dispatch；
  `scripts/workers/generation-worker.ts` 领取任务。
- 非 worker 模式通过 `startQuantGenerationQueued` 在应用进程内开始执行。
- lease、fencing、outbox、worker slot 和 workspace lock 是一致性保证，不是可随意删除的“实现细节”。

### 4.6 Prompt、Agent 和 Skills

| 能力 | 文件和关键符号 | 状态 |
| --- | --- | --- |
| 主 Prompt 组装 | `src/lib/services/pi-agent-prompts.ts` | 已确认 |
| PI 调度 | `src/lib/services/cli/pi-agent.ts#executePiAgent` | 已确认 |
| PI run engine | `src/lib/agent/pi/run-engine.ts#PiAgentRunEngine` | 已确认 |
| 工具注册 | `src/lib/domains/finance/agent-tools/factory.ts` | 已确认 |
| 看板合同 | `dashboard-spec.ts`、`dashboard-contract.ts` | 已确认 |
| 行情工具 | `quant-api.ts#createQuantApiGetTool` | 已确认 |
| 图片提取 | `image-extraction.ts` | 已确认 |
| Skill 编译 | `src/lib/agent/skills/compiler.ts#compilePiAgentSkills` | 已确认 |
| Skill 注册和完整性 | `.pi/skills.registry.json`、`.pi/skills.lock.json`、`config/pi-agent-skill-capsules.json` | 已确认 |

研究链使用的核心 skill 集合包括：

`run-planner`、`query-rewrite`、`quant-data-registry`、`quant-symbol-resolver`、
`image-extraction`、`quant-market-data`、`quant-fundamentals`、`quant-indicators`、
`quant-backtest`、`data-quality`、`dashboard-visualization`。

registry 中共有 12 个 stable skills。除上述 11 个研究 skills 外，
`src/lib/quant/data-agent-application.ts#provisionProject` 还通过
`additionalSkillIds: ['platform-ui-product-design']` 将 `platform-ui-product-design` 安装到生成
workspace。它是已确认的 provisioning 依赖，首版分类为 `MIGRATE`；只有阶段三建立替代 Prompt/skill
并通过看板生成质量对比后，才可另行改为 `REMOVE`。

### 4.7 工作区与数据存储

工作区根由 `PROJECTS_DIR` 控制，默认 `./data/projects`。每个项目包含：

```text
.data-agent/workspace.json
.data-agent/profile.json
.data-agent/task.json
.data-agent/plan.json
.data-agent/finance-query-rewrite.json
.data-agent/finance-run-plan.json
.data-agent/events.jsonl
.data-agent/generation-state.json
.data-agent/validation.json
.data-agent/validation-repair-plan.json
.data-agent/visual-validation.json
.data-agent/generation-queue.json
assets/**
data_file/raw/**
data_file/final/dashboard-data.json
evidence/sources.json
evidence/data_quality.json
app/page.tsx
app/globals.css
```

路径和写入边界由以下模块控制：

- `src/lib/data-agent/workspace-layout.ts`
- `src/lib/data-agent/workspace-path.ts`
- `src/lib/data-agent/workspace-files.ts`
- `src/lib/agent/tools/path-policy.ts`
- `src/lib/agent/runtime/workspace-resource-lock.ts`
- `src/lib/agent/runtime/workspace-mutation-journal.ts`
- `src/lib/server/file-browser.ts`
- `src/lib/server/image-assets.ts`

### 4.8 数据库模型

研究核心持久化模型：

- `Project`、`Message`、`UserRequest`
- `AgentRun`、`AgentEvent`、`AgentCheckpoint`
- `AgentToolExecution`、`AgentToolApproval`
- `AgentMission`、`AgentMissionNode`、`AgentEvidenceReceipt`
- `AgentWorkspaceLease`、`AgentGenerationLease`
- `AgentGenerationJob`、`AgentGenerationOutboxEvent`
- `AgentWorkerSlot`、`AgentWorkerInstance`

启用本地鉴权和配额时还需要：

- `AuthUser`、`AuthSession`、`AuthAccount`、`AuthVerification`、`AuthRateLimit`
- `ProjectMembership`、`AuthAuditEvent`
- `PermissionProfile`、`PermissionProfileGrant`、`UserPermissionOverride`
- `QuotaProfile`、`QuotaRule`、`UserQuotaOverride`
- `UsageBucket`、`QuotaReservation`、`UsageEvent`、`ApiIdempotencyOperation`

Memory 和 Knowledge 只把外部引用、反馈和使用凭据写入本地数据库：

- `ExternalMemoryUse`
- `PersonalMemoryFeedbackReceipt`
- `PersonalMemoryControl`
- `GovernedKnowledgeUse`

### 4.9 AI 模型

`src/lib/constants/models.ts` 定义：

- 默认本地 `local_qwen:qwen3.5-9b-q5km`，OpenAI-compatible endpoint
  `http://127.0.0.1:38082/v1`
- ModelPort 转发的 `deepseek:deepseek-v4-flash`
- 可选 DeepSeek 官方直连 `deepseek-v4-flash`

实际 Provider 位于：

- `src/lib/agent/providers/deepseek.ts`
- `src/lib/agent/providers/openai-compatible.ts`
- `src/lib/agent/providers/deterministic-tool-plan.ts`

`query-rewrite-llm.ts` 与 `pi-agent.ts` 都会读取模型配置和凭据。目标必须通过统一
`ModelProviderPort` 供两条链使用，避免问题改写与生成阶段选择不同模型或认证方式。

### 4.10 市场数据链

Next 侧固定使用的最小端点：

- `GET /api/v1/symbols/resolve`
- `GET /api/v1/quotes/realtime/{symbol}`
- `POST /api/v1/quotes/realtime`
- `GET /api/v1/quotes/history/{symbol}`
- `GET /api/v1/indicators/technical/{symbol}`
- `GET /api/v1/indicators/fundamental/{symbol}`
- `GET /api/v1/fundamentals/financials/{symbol}`
- `GET /api/v1/events/announcements/{symbol}`
- `GET /api/v1/backtests/ma-crossover/{symbol}`
- `GET /api/v1/research/bars/{symbol}`
- `GET /api/v1/research/screeners/a-share/short-term-candidates`
- 与 skill 数据注册相关的 registry、coverage 和 universe 只读端点

Python 调用链：

```text
services/market-data/src/quantpilot_market_data/api.py#create_app
  -> routers/quotes.py
  -> routers/indicators.py
  -> routers/fundamentals.py
  -> routers/events.py
  -> routers/backtests.py
  -> routers/research.py
  -> services/{quotes,indicators,fundamentals,events,backtests,research}.py
  -> services/kline_gateway.py#get_kline_local_first
  -> repositories/**
  -> database_core.py
  -> cache.py#MarketDataCache / RedisJsonCache
  -> providers/eastmoney.py 及可选 provider
```

外部 Provider 不可用时，目标不得返回空成功。`data-prefetch.ts` 当前允许部分端点失败并写入
warning，但当所有标的失败时会抛错。目标适配器需要保留“部分数据可用”的业务语义，同时将
每个失败映射为结构化、可追踪的错误。

`repositories/screener.py` 顶层静态导入 ClickHouse helper 和 analytics sync，但
`screen_short_term_candidates` 在 ClickHouse 未启用、查询失败或数据日期不一致时已有明确
TimescaleDB 路径。由此可静态确认：首版 screener 需要 `ADAPT` 为不导入 ClickHouse 的
TimescaleDB 实现；`clickhouse.py`、analytics routes、sync repository 和 `clickhouse-connect`
运行依赖可以 `REMOVE`。目标已用无 ClickHouse 的市场服务测试和 screener contract 验证返回字段及
`data_basis`；ClickHouse runtime 不进入首版。

### 4.11 预览和生成代码安全

| 结论 | 状态 | 证据 |
| --- | --- | --- |
| 预览会检测包管理器、安装依赖、启动每项目 Next.js 进程并探测 readiness | 已确认 | `src/lib/services/preview.ts#PreviewManager` |
| 生成项目环境只传递白名单环境变量 | 已确认 | `src/lib/security/generated-project-sandbox.ts#buildGeneratedProjectEnv` |
| 强隔离只实现于 Linux `unshare` sandbox | 已确认 | `wrapGeneratedProjectCommand` |
| 非 Linux 默认拒绝执行生成代码；只有 `QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE=1` 才放行 | 已确认 | 同上 |
| 首版继续在 Windows 本地生成和预览，通过明确配置启用非沙箱执行 | 已确认 | 用户决策；默认关闭并在 UI、API 和日志标记 `sandboxMode=windows-unsandboxed` |
| Linux namespace sandbox 不进入首版最小集合 | 已确认 | 当前部署决策；未来对外或多用户部署需重新评审 |

## 5. 评测中心实际边界

### 5.1 路由与页面

| 路由 | 页面/符号 | 状态 |
| --- | --- | --- |
| `/eval-platform` | `src/app/eval-platform/page.tsx#EvalPlatformPage` | 已确认 |
| `/eval-platform/runs/{runId}` | `src/app/eval-platform/runs/[runId]/page.tsx#EvalRunPage` | 已确认 |
| `/api/evals` | `src/app/api/evals/route.ts#GET/#POST` | 已确认 |
| `/api/evals/runs/{runId}` | `src/app/api/evals/runs/[runId]/route.ts#GET` | 已确认 |

页面组件：

- `EvalsDashboardClient`
- `EvalOverviewView`
- `EvalCasesView`
- `EvalSetsView`
- `EvalQueueView`
- `EvalEvaluatorView`
- `eval-console-primitives.tsx`
- `EvalRunDetailClient`

`EvalsDashboardClient` 在队列存在 `queued` 或 `running` 项时每 3 秒调用 `GET /api/evals`。
评测页面没有 WebSocket 或 SSE。

### 5.2 API 动作

`POST /api/evals` 支持：

- `start-benchmark`
- `create-case`
- `create-eval-set`
- `simulate-flow`
- `cancel-benchmark`
- `update-schedule`
- `check-schedule`

读取要求能力 `platform.observability.read`，写入要求 `platform.settings.manage`，且写操作通过
`src/lib/server/privileged-request.ts#assertPrivilegedMutation` 校验本机或受信请求。

### 5.3 运行时链

```text
EvalPlatformPage
  -> src/lib/eval/runtime.ts#getQuantEvalDashboardData
  -> cases + eval sets + runs + queue + repair tickets + schedule

POST start-benchmark
  -> startQuantEvalRun
  -> writeQueue / EvalQueueItem
  -> processEvalQueue
  -> runBenchmarkQueueItem
  -> child_process.spawn(process.execPath,
       ["scripts/evals/run-quant-benchmarks.js", ...])
  -> benchmark report JSON
  -> EvalRun + queue report link + repair tickets

cancel-benchmark
  -> runningChildren Map 或持久化 pid
  -> SIGTERM
```

`scripts/evals/run-quant-benchmarks.js` 通过 `jiti` 直接加载研究域模块，包括：

- `src/lib/utils/scaffold.ts`
- `src/lib/domains/finance/workspace.ts`
- `src/lib/domains/finance/query-rewrite.ts`
- `src/lib/domains/finance/visualization-templates.ts`
- `src/lib/domains/finance/agent-tools/dashboard-spec.ts`
- `src/lib/quant/data-prefetch.ts`
- `src/lib/quant/generation-state.ts`
- `src/lib/quant/validation.ts`
- `src/lib/services/preview.ts`
- `src/lib/services/project.ts`
- `src/lib/services/cli/pi-agent.ts`
- `src/lib/eval/**`

因此：

- **已确认**：contract 模式仍依赖研究域的计划、模板、预取、校验、脚手架和 skill lock。
- **已确认**：E2E 模式进一步执行真实 PI Agent、数据库、市场数据、工作区和预览链。
- **已确认**：评测 UI、contract runner 和 DeepSeek live-model runner 已形成可验证里程碑，但
  仍通过共享研究域的计划、预取、Agent、validation 和 preview 闭包运行，不能将其误实现为与
  研究域完全无关的子系统。

`EvalsDashboardClient` 实际提供 start、simulate、cancel、create case 和 create eval set；
有 active queue 时每 3 秒刷新。完成项通过 `EvalQueueItem.reportId` 链接
`/eval-platform/runs/{runId}`，服务端页面调用 `getQuantEvalRun` 读取报告并交给
`EvalRunDetailClient` 展示。

当前 `runtime.ts#latestReportAfter` 只按报告 `mtimeMs >= startedAt` 和 mode 猜测刚完成进程对应的
报告，没有使用 queue ID/run ID 强关联。这在并发同 mode benchmark 时可能把错误报告挂到 queue
item。目标 runner 必须接收 `queueId` 和预分配 `reportId`，报告内写入两者，Repository 只接受
身份一致且 hash 校验通过的 artifact。

### 5.4 评测数据

静态数据和合同：

- `benchmarks/quantpilot/cases.json`
- `benchmarks/quantpilot/datasets.json`
- `benchmarks/quantpilot/e2e-suite.json`
- `benchmarks/quantpilot/judge-calibration.contract.json`
- `benchmarks/quantpilot/mutation-catalog.json`
- `benchmarks/quantpilot/query-rewrite-fixtures.json`
- `benchmarks/quantpilot/snapshot-manifest.json`
- `benchmarks/quantpilot/snapshots/*.json`
- `config/evals/*.json`

运行时文件：

- `tmp/quantpilot-eval-queue/queue.json`
- `tmp/quantpilot-eval-queue/logs/**`
- `tmp/quantpilot-eval-queue/schedule.json`
- `tmp/quantpilot-eval-repairs/repairs.json`
- `tmp/quantpilot-benchmark-reports/**`
- `tmp/quantpilot-benchmark-screenshots/**`

数据库模型：

- `EvalRun`
- `EvalQueueItem`
- `EvalRepairTicket`
- `EvalSchedule`

### 5.5 当前持久化风险

`src/lib/eval/runtime.ts` 当前同时读写数据库和 JSON 文件：

- `readQueue`、`readRepairTickets`、`readScheduleConfig` 会捕获数据库读取错误并尝试文件数据。
- `writeQueue`、`writeRepairTickets`、`writeScheduleConfig` 对部分文件写入使用
  `catch(() => undefined)`。
- `getQuantEvalRuns` 对同步回数据库使用 `catch(() => undefined)`。
- `src/lib/eval/cases.ts` 对 case/eval-set 文件读取失败返回空数组。
- `createQuantEvalCase` 和 `createQuantEvalSet` 直接把用户创建内容写回
  `benchmarks/quantpilot/cases.json` 和自定义 eval-set JSON。

这与本迁移“不吞异常、不用静默降级掩盖数据错误”的约束冲突。目标应选择单一权威存储，
或明确标记 `healthy/degraded/unavailable`，不能把数据库故障展示为“当前没有记录”。
目标已将 benchmark JSON 作为只读、版本化 seed catalog，自定义 case/eval set 写 PostgreSQL；
运行时不修改仓库内 benchmark 资源。contract 报告 16/16，DeepSeek live-model 报告 4/4，
报告身份、hash 和 attestation 均已核验。

Schedule 源码只有 `update-schedule`、`check-schedule` action 和被动
`checkQuantEvalSchedule`，当前评测 UI 没有调用这两个 action，也没有发现定时器、worker cron
或外部 scheduler 主动触发它。是否提供自动调度、由哪个进程持有调度 lease 无法由代码确认，
标记为 `BLOCKED（非核心）`；首版核心评测闭环不以自动 schedule 为完成条件。

## 6. 两模块共享边界

| 共享能力 | 研究工作台 | 评测中心 | 状态 |
| --- | --- | --- | --- |
| Next 根布局、主题、UI primitives | 直接使用 | 直接使用 | 已确认 |
| Auth 和 permission catalog | 项目级能力 | 平台级能力 | 已确认 |
| Prisma client 和 PostgreSQL | 项目、Agent、队列 | 运行、队列、修复单；源调度模型首版 blocked | 已确认 |
| 模型注册和 Provider | query rewrite、生成 | E2E runner | 已确认 |
| 工作区路径和文件合同 | 核心 | contract/E2E fixtures 与生成项目 | 已确认 |
| finance run plan、模板、校验 | 核心 | contract/E2E runner | 已确认 |
| skill registry/lock/capsule | Agent 执行 | 报告元数据和 runner | 已确认 |
| preview/process supervisor | 看板展示 | visual/E2E 评测 | 已确认 |
| 市场数据 | 研究取数 | E2E 和部分 contract fixture | 已确认 |
| 时间、ID、hash、序列化工具 | 全链 | 全链 | 已确认 |

## 7. 鉴权、环境变量和外部服务

### 7.1 鉴权

正式模式：

- `disabled`：`requireAction` 使用 `LOCAL_SYSTEM_ADMIN_ID`，不创建用户 session。
- `local`：Better Auth + Prisma adapter + Argon2id + permission profile + project membership。

目标首版已确认只使用 `disabled` local-system 模式，不迁移登录 UI、Better Auth session
和 quota 执行链。API 层仍保留统一的 Authorization facade，避免后续接入鉴权时重写业务服务。

目标不得复制源 `.env`、`.env.local` 或数据库。只迁移无值的 `.env.example`。

### 7.2 关键环境变量名

以下只记录变量名，不包含任何源值：

| 领域 | 变量名 | 状态 |
| --- | --- | --- |
| 数据库 | `DATABASE_URL`、`QUANTPILOT_DATABASE_ENABLED`、`QUANTPILOT_DATABASE_REQUIRED` | 已确认 |
| Redis | `REDIS_URL`、`REDIS_NAMESPACE`、`QUANTPILOT_REDIS_CACHE_ENABLED`、`QUANTPILOT_REDIS_REQUIRED` | 已确认 |
| 工作区 | `PROJECTS_DIR`、`QUANTPILOT_WORKSPACE_ROOT` | 已确认 |
| 鉴权 | `QUANTPILOT_AUTH_MODE`、`QUANTPILOT_AUTH_SECRET`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`NEXT_PUBLIC_APP_URL`、`QUANTPILOT_AUTH_TRUSTED_ORIGINS` | 已确认；目标 disabled local-system，生产本机 eval mutation 改用 `WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS` 或 server-only `WOLF_RESEARCH_ADMIN_TOKEN` |
| Agent | `PI_AGENT_TIMEOUT_MS`、`PI_AGENT_DISPATCH_MODE`、`PI_AGENT_INSTANCE_ID`、`PI_AGENT_WORKSPACE_NAMESPACE`、各 lease/heartbeat/concurrency 变量 | 已确认 |
| 模型 | `DEEPSEEK_API_KEY`、`MODELPORT_API_KEY`、`QUANTPILOT_MODELPORT_URL`、`QUANTPILOT_LLM_AGENT_ENABLED`、`QUANTPILOT_LLM_QUERY_REWRITE_ENABLED` | 已确认 |
| 市场 | `QUANTPILOT_MARKET_API_URL`、`QUANTPILOT_MARKET_API_ENABLED`、`QUANTPILOT_MARKET_API_REQUIRED`、`QUANTPILOT_MARKET_ADMIN_TOKEN` | 已确认 |
| 预览 | `PREVIEW_PORT_START`、`PREVIEW_PORT_END`、`QUANTPILOT_GENERATED_SANDBOX`、`QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE` | 已确认；目标改用 `WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE` |
| 评测 | `QUANTPILOT_EVAL_MODE`、`QUANTPILOT_EVAL_MODEL`、`QUANTPILOT_EVAL_EVALUATOR`、`QUANTPILOT_EVAL_CONCURRENCY`、`QUANTPILOT_EVAL_REPEAT`、`QUANTPILOT_EVAL_DATASET_VISIBILITY`、各 case path 变量 | 已确认 |
| Memory | `QUANTPILOT_MEMORY_*` | 已确认 |
| Knowledge | `QUANTPILOT_KNOWLEDGE_*` | 已确认 |

完整迁移时使用 `WOLF_RESEARCH_*`。源变量名只作为迁移映射依据，不要求目标运行时兼容，
避免目标配置继续暴露 QuantPilot 品牌或形成隐式开关。

### 7.3 外部服务

| 服务 | 用途 | 当前行为 | 状态 |
| --- | --- | --- | --- |
| PostgreSQL/TimescaleDB | 业务、Agent、评测和市场历史 | 核心强依赖 | 已确认 |
| Redis | 市场缓存、未来可作实时事件总线 | 可选/按配置 required | 已确认 |
| EastMoney/Tencent | 证券解析、行情、财务、事件、历史 | 网络 Provider | 已确认 |
| BaoStock/AkShare | 可选历史补数 | Python extra | 已确认 |
| 本地 Qwen/ModelPort/DeepSeek | query rewrite 和 PI Agent | 按模型配置 | 已确认 |
| Memory provider | 个性化召回和反馈 | 首版使用显式 disabled adapter，不发起 HTTP 请求 | 已确认 |
| Knowledge provider | 治理知识召回和反馈 | 首版使用显式 disabled adapter，不发起 HTTP 请求 | 已确认 |
| GitHub/Vercel/Supabase | 发布和项目服务 | 非研究核心 | 已确认，建议移除 |
| ClickHouse | 可选筛选分析加速 | screener 已有 TimescaleDB fallback；首版移除 ClickHouse runtime，并适配静态 import | 已确认 |

## 8. 调查结论

1. **已确认**：研究工作台的实际产品边界是 `/`、`/{project_id}/chat`、完整研究执行后端、
   市场数据子集、生成工作区、验证和预览，不是只复制首页。
2. **已确认**：评测中心核心包含 dashboard、run detail、API、runner、fixtures、队列、
   修复单和持久化；contract 与 E2E 都复用研究域代码，只是复用深度不同。自动 schedule
   触发拓扑不在当前已确认核心边界。
3. **已确认**：数据库 lease/fencing/outbox、workspace lock、request idempotency 和 tool approval
   是行为契约的一部分。
4. **已确认**：首版在 Windows 本地执行生成项目的 build/preview；默认拒绝执行，只有
   `WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE=1` 才启用，并公开非沙箱状态。
5. **已确认**：基线采用当前 dirty snapshot；品牌为 Wolf Research；保留 MIT 归因和内部
   `benchmarks/quantpilot/` 目录；Auth/quota、Memory/Knowledge 真接入和 Shadow Replay 暂不进入本次重构。
6. **已确认**：首版 realtime 为单机 Web 进程内 WS/SSE 加 durable polling 恢复；ClickHouse
   不进入首版，screener 适配到明确 TimescaleDB 路径。
7. **BLOCKED（非核心）**：Eval schedule 没有 UI 调用和主动调度拓扑，需后续产品/部署决策后
   才能确定进程所有权、lease 和恢复语义。

相关方案文档：

- [依赖清单](./DEPENDENCY_INVENTORY.md)
- [源目标映射](./SOURCE_TARGET_MAP.md)
- [接口契约](./INTERFACE_CONTRACTS.md)
- [重构计划](./MIGRATION_PLAN.md)
- [风险登记](./RISK_REGISTER.md)
- [验收标准](./ACCEPTANCE_CRITERIA.md)
