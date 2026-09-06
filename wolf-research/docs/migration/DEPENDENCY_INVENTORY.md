# 重构依赖清单与处置分类

调查日期：2026-09-04

## 1. 分类定义

| 分类 | 定义 |
| --- | --- |
| `MIGRATE` | 目标功能运行所必需，按既有行为重构保留 |
| `SHARED` | 研究工作台和评测中心共同使用，只保留一个目标实现 |
| `ADAPT` | 语义保留，但路径、进程、部署、协议或环境需要适配 |
| `FACADE` | 对外提供兼容接口，内部通过 Port/Adapter 实现 |
| `STUB` | 仅开发或测试可用，必须由显式开关启用 |
| `REMOVE` | 与两个目标功能无关，迁移时删除引用和 UI 入口 |
| `BLOCKED` | 当前无法安全确认范围或实现方式 |

事实状态使用“已确认 / 推测 / 待验证”。本表中的“建议分类”是重构方案分类；阶段三/四的实际
执行结果和偏差见 `MIGRATION_PLAN.md` 与 `VALIDATION_REPORT.md`。历史 contract benchmark 为
16/16，DeepSeek 官方 live-model E2E 为 4/4；当前直接 contract 入口仍需补齐 fixture 编排，
Eval schedule 自动调度继续为非核心 `BLOCKED`。

## 2. 应用壳与前端

| 依赖 | 源证据 | 使用方 | 建议分类 | 处理方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| Next App Router 根布局 | `src/app/layout.tsx#RootLayout` | 两者 | `ADAPT` | 保留 Theme、最小 Settings 和 Motion；移除 `AuthUserMenu` 静态闭包，接 local-system context | 已确认 |
| `/` 首页 | `src/app/page.tsx#HomePage` | 研究 | `MIGRATE` | 保持主要 UI 和提交语义，移除非目标导航 | 已确认 |
| `/{project_id}/chat` | `src/app/[project_id]/chat/page.tsx#ChatPage` | 研究 | `MIGRATE` | 作为 `/` 完整流程的必需后续路由 | 已确认 |
| `/eval-platform` | `src/app/eval-platform/page.tsx#EvalPlatformPage` | 评测 | `MIGRATE` | 保持 dashboard 行为 | 已确认 |
| `/eval-platform/runs/{runId}` | `src/app/eval-platform/runs/[runId]/page.tsx#EvalRunPage` | 评测 | `MIGRATE` | 保持结果明细和锚点导航 | 已确认 |
| UI primitives | `src/components/ui/**` | 两者 | `SHARED` | 只迁移实际 import 闭包 | 已确认 |
| 页面布局组件 | `src/components/layout/PageHeader.tsx`、`PlatformSwitcher.tsx` | 两者 | `SHARED` | 菜单收敛到两个目标入口 | 已确认 |
| Theme context | `src/contexts/ThemeContext.tsx` | 两者 | `SHARED` | 保持主题语义 | 已确认 |
| 源 Auth context/menu | `AuthContext.tsx`、`AuthUserMenu.tsx`、`PageHeader.tsx` | 两者 | `ADAPT` | 不原样迁移；重写为无 Better Auth import 的 local-system context，并修改 layout/PageHeader | 已确认 |
| Global Settings context | `src/contexts/GlobalSettingsContext.tsx` | 两者 | `ADAPT` | 保留模型设置；读取失败必须显式显示 unavailable/degraded | 已确认 |
| framer-motion | `package.json`、页面 import | 两者 | `SHARED` | 保持动画语义 | 已确认 |
| recharts | `src/components/quant/eval-*.tsx` | 评测 | `MIGRATE` | 保持指标图表 | 已确认 |
| react-icons stubs | `tsconfig.json#paths` | 研究聊天页 | `ADAPT` | 优先保留现有别名，后续再决定是否直接依赖真实包 | 已确认 |
| TypeScript aliases | `tsconfig.json#compilerOptions.paths` | 两者/runner | `MIGRATE` | 保留 `@/*`、四组 `@/types/*` 和 react-icons stub 映射 | 已确认 |
| 首页动态组件 | `page.tsx#dynamic` | 研究 | `MIGRATE` | 将 `GlobalSettings`、`TaskDrawer` 计入编译图外 manifest 和 E2E | 已确认 |
| 首页研究动画资源 | `src/assets/home-anime-quant-researcher-v3.webp` | 研究 | `MIGRATE` | 复制静态资源，不重新生成 | 已确认 |
| 等待动画资源 | `src/assets/dashboard-generation-anime-v1.webp` | 研究 | `MIGRATE` | 复制静态资源 | 已确认 |
| QuantPilot 品牌资源 | `public/**`、`layout.tsx#metadata` | 两者 | `ADAPT` | 可复用资源按 Wolf Research 展示；保留 MIT 来源归因 | 已确认 |
| 非目标平台导航 | `PlatformSwitcher`、首页多个 router link | 两者 | `REMOVE` | 删除 skills、ops、reports、admin、account 等入口 | 已确认 |
| 源 `postinstall` | `package.json#postinstall`、`setup-env.js` | 安装 | `REMOVE` | 安装阶段不得写 `.env*` 或生成 secret | 已确认 |
| Web/full 启动脚本 | `scripts/dev/run-web.js`、`run-full.js` | 两者 | `ADAPT` | 建立显式 startup coordinator；移除 Auth/quota bootstrap 和自动 degradation 恢复 | 已确认 |
| `jiti`、`tsconfig-paths` | benchmark/check scripts、lockfile | 评测 | `MIGRATE` | 若保留 runner，必须作为直接依赖固定版本，不能依赖传递安装 | 已确认 |
| 模块级 singleton/注册 | data-agent、preview、stream、websocket 模块 | 研究/E2E eval | `ADAPT` | 定义进程所有权、幂等初始化、HMR 和 timer/listener 清理 | 已确认 |

## 3. 研究 API 与应用服务

| 依赖 | 源证据 | 建议分类 | 处理方式 | 状态 |
| --- | --- | --- | --- | --- |
| 项目 CRUD API | `src/app/api/projects/route.ts`、`[project_id]/route.ts` | `MIGRATE` | 保持请求、响应和幂等语义 | 已确认 |
| 项目服务层 | `src/lib/services/project.ts` | `MIGRATE` | 通过 `ProjectRepository` 与 `WorkspaceStoragePort` 解耦 | 已确认 |
| 图片上传/读取 | `src/app/api/assets/[project_id]/**` | `MIGRATE` | 使用 `AssetStoragePort`，保留大小、MIME、路径校验 | 已确认 |
| Chat act | `src/app/api/chat/[project_id]/act/route.ts#POST` | `MIGRATE` | 保持 `requestId`、状态码、排队响应 | 已确认 |
| Chat act schema | `src/lib/quant/chat-act-contract.ts` | `SHARED` | API 和 UI 共用 Zod 合同 | 已确认 |
| 消息 API | `src/app/api/chat/[project_id]/messages/route.ts` | `MIGRATE` | 保持游标/分页/创建/删除语义 | 已确认 |
| 活动请求 API | `src/app/api/chat/[project_id]/requests/active/route.ts` | `MIGRATE` | 不得把查询失败解释为无活动请求 | 已确认 |
| 暂停 API | `src/app/api/chat/[project_id]/pause/route.ts` | `MIGRATE` | 协调 request、mission、queue、preview | 已确认 |
| generation status | `src/app/api/projects/[project_id]/generation/status/route.ts` | `MIGRATE` | 作为恢复和轮询的权威接口 | 已确认 |
| retry initialization | `src/app/api/projects/[project_id]/retry-initialization/route.ts` | `MIGRATE` | 保持明确失败和实时事件 | 已确认 |
| validation API | `src/app/api/projects/[project_id]/quant/validation/route.ts` | `MIGRATE` | 保持 Mission 验收门禁 | 已确认 |
| preview API | `src/app/api/projects/[project_id]/preview/**` | `MIGRATE` | 通过 `PreviewRuntimePort` | 已确认 |
| 文件树和文件编辑 | `src/app/api/repo/[project_id]/**` | `MIGRATE` | 保持路径策略；文件写入需要 source.write 权限 | 已确认 |
| settings API | `src/app/api/settings/**`、聊天页调用 | `FACADE` | 提供仅模型/CLI 所需的兼容响应 | 已确认 |
| install-dependencies API | `src/app/api/projects/[project_id]/install-dependencies/route.ts` | `ADAPT` | 交给受控 `ProcessSupervisorPort`，生产可禁用手工触发 | 已确认 |
| tool approval API | `src/app/api/projects/[project_id]/agent/approvals/**` | `MIGRATE` | 保留 durable approval 和 actor 审计 | 已确认 |
| Memory/Knowledge 宿主组件 | `ChatInput.tsx`、`ChatLogView.tsx` | `ADAPT` | 删除未迁移反馈组件的静态 import 和 render 分支 | 已确认 |
| project services API | `src/app/api/projects/[project_id]/services/**` | `REMOVE` | 与 GitHub/Vercel/Supabase 一并移除 | 已确认 |
| GitHub API/UI | `src/app/api/projects/[project_id]/github/**`、`ChatPage` | `REMOVE` | 删除发布按钮、状态和请求 | 已确认 |
| Vercel API/UI | `src/app/api/projects/[project_id]/vercel/**`、`ChatPage` | `REMOVE` | 删除发布按钮、轮询和部署状态 | 已确认 |
| Supabase API/UI | `src/app/api/supabase/**`、project service files | `REMOVE` | 不进入目标 | 已确认 |

## 4. 研究编排、Agent 和验证

| 依赖 | 源证据 | 使用方 | 建议分类 | 处理方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| Finance act preparation | `src/lib/quant/finance-act-preparation.ts` | 研究/E2E eval | `SHARED` | 原语义迁移 | 已确认 |
| Query rewrite | `src/lib/domains/finance/query-rewrite*.ts` | 研究/contract eval | `SHARED` | 统一使用 Model 和 Market ports | 已确认 |
| Run plan/workspace contract | `src/lib/domains/finance/workspace*.ts` | 两者 | `SHARED` | 保持 JSON schema 和 artifact 名称 | 已确认 |
| Intent continuation | `src/lib/domains/finance/intent.ts` | 研究/eval | `SHARED` | 保持澄清继续行为 | 已确认 |
| Data prefetch | `src/lib/quant/data-prefetch.ts` | 研究/eval | `SHARED` | 改由 `MarketDataPort` 调用 | 已确认 |
| Generation runtime | `src/lib/quant/generation-runtime.ts` | 研究/E2E eval | `SHARED` | 依赖注入 queue/storage/model/preview | 已确认 |
| Generation executor | `src/lib/quant/finance-generation-executor.ts` | 研究/E2E eval | `SHARED` | 原执行 envelope 迁移 | 已确认 |
| Mission compiler/definition | `src/lib/agent/mission/**`、`mission-definition.ts` | 研究/E2E eval | `SHARED` | 保持 evidence verification | 已确认 |
| Mission stores/control | `src/lib/services/pi-agent-mission-*.ts` | 研究/E2E eval | `MIGRATE` | PostgreSQL repository | 已确认 |
| PI run engine | `src/lib/agent/pi/run-engine.ts` | 研究/E2E eval | `SHARED` | 保持工具和中止语义 | 已确认 |
| PI CLI service | `src/lib/services/cli/pi-agent.ts` | 研究/E2E eval | `SHARED` | 模型和工作区依赖封口 | 已确认 |
| Prompts | `src/lib/services/pi-agent-prompts.ts` | 研究/E2E eval | `SHARED` | 保持原 Prompt 结构和安全边界 | 已确认 |
| Agent tools | `src/lib/domains/finance/agent-tools/**` | 研究/E2E eval | `SHARED` | 迁移最小 finance tool 集 | 已确认 |
| Agent core/providers/context/tools | `src/lib/agent/**` import 闭包 | 研究/E2E eval | `SHARED` | 不按整个目录盲拷；先设 Auth/Memory/Knowledge/发布适配断点，再按最终 import graph 迁移文件 | 已确认 |
| Generation state | `src/lib/quant/generation-state.ts` | 研究/eval | `SHARED` | 保持 workspace artifact 与 DB 状态一致性 | 已确认 |
| Validation | `src/lib/quant/validation.ts` | 两者 | `SHARED` | 保持数据、代码和安全校验 | 已确认 |
| Visual validation | `src/lib/quant/visual-validation.ts` | 研究/E2E eval | `SHARED` | 需要 Playwright 和 preview | 已确认 |
| Validation repair | `generation-validation.ts`、`benchmark-repair.ts` | 两者 | `SHARED` | 保持有界修复次数 | 已确认 |
| Scaffold | `src/lib/utils/scaffold.ts` | 两者 | `SHARED` | 路径和 node_modules 共享方式需适配 | 已确认 |
| Skills compiler | `src/lib/agent/skills/**` | 研究/eval | `SHARED` | 保留 hash/lock/capsule 校验 | 已确认 |
| 11 个 finance skills | `.pi/skills/**` | 研究/eval | `MIGRATE` | 迁移源目录、注册表和 lock；不复制历史 tgz 版本全集 | 已确认 |
| `platform-ui-product-design` skill | `data-agent-application.ts#provisionProject`、`.pi/skills.registry.json` | 研究/E2E eval | `MIGRATE` | provisioning 通过 `additionalSkillIds` 明确安装；删除需另做生成质量对比 | 已确认 |
| skill 管理页面/API | `src/app/skills/**`、`src/app/api/skills/**` | 非目标 | `REMOVE` | 保留只读编译能力，不迁移管理 UI | 已确认 |

## 5. 持久化与并发

| 依赖 | 源证据 | 建议分类 | 处理方式 | 状态 |
| --- | --- | --- | --- | --- |
| Prisma client | `src/lib/db/client.ts` | `ADAPT` | 保留单例，但重写夹带 auth/quota/knowledge 版本的 `PRISMA_CLIENT_CONTRACT` | 已确认 |
| PostgreSQL | `prisma/schema.prisma` | `FACADE` | Repository ports，不允许业务层直接散落查询 | 已确认 |
| 核心项目/消息/请求模型 | `Project`、`Message`、`UserRequest` | `MIGRATE` | 最小 schema | 已确认 |
| Agent run/event/checkpoint/tool 模型 | `Agent*` | `MIGRATE` | E2E 正确性和可追溯性所需 | 已确认 |
| Mission/evidence 模型 | `AgentMission*`、`AgentEvidenceReceipt` | `MIGRATE` | 验收门禁所需 | 已确认 |
| Lease/fencing/outbox/worker 模型 | `Agent*Lease`、`AgentGeneration*`、`AgentWorker*` | `MIGRATE` | worker 模式完整迁移 | 已确认 |
| Auth/permission/quota 模型 | `Auth*`、permission、quota | `REMOVE`/`FACADE` | 首版不迁移登录和 quota 模型；保留 disabled local-system Authorization facade | 已确认 |
| Quota 宿主静态耦合 | projects route、`project.ts`、`user-requests.ts` | `ADAPT` | 删除 reserve/settle/reconciliation/capacity import，项目幂等改用独立 operation repository | 已确认 |
| Eval 核心模型 | `EvalRun`、`EvalQueueItem`、`EvalRepairTicket` | `MIGRATE` | 目标以数据库为权威 | 已确认 |
| Eval JSON 状态文件 | `src/lib/eval/paths.ts`、`tmp/**` | `ADAPT` | 报告/日志可留文件；queue/repair 改为 DB 权威，schedule 另列阻塞 | 已确认 |
| Eval case/eval-set catalog | `benchmarks/quantpilot/*.json`、`cases.ts#create*` | `ADAPT` | JSON 仅作只读 seed；用户创建 case/set 以 PostgreSQL 为权威 | 已确认；已实施 |
| Workspace filesystem | `data/projects/**` | `FACADE` | `WorkspaceStoragePort`，根目录必须在目标内或显式配置 | 已确认 |
| Asset filesystem | `assets/**`、`public/uploads/**` | `FACADE` | `AssetStoragePort`，禁止目录穿越 | 已确认 |
| Redis | `REDIS_URL`、market cache | `ADAPT` | 首版仅作为可选市场缓存；realtime 采用 in-process + durable polling，不要求 Redis fan-out | 已确认 |
| Screener ClickHouse 静态耦合 | `repositories/screener.py` 顶层 import | `ADAPT` | 移除 ClickHouse import/sync 分支，固定 TimescaleDB 数据路径并保持响应合同 | 已确认 |
| ClickHouse runtime/routes/package | `clickhouse.py`、analytics router/repository、`clickhouse-connect` | `REMOVE` | 首版不迁移；无 ClickHouse 集成测试必须通过 | 已确认 |

## 6. 队列和后台任务

| 依赖 | 源证据 | 建议分类 | 处理方式 | 状态 |
| --- | --- | --- | --- | --- |
| Generation queue | `src/lib/quant/generation-queue.ts` | `FACADE` | `GenerationQueuePort`，支持 inline 和 durable worker adapter | 已确认 |
| Generation worker | `scripts/workers/generation-worker.ts` | `MIGRATE` | durable 模式必需 | 已确认 |
| Worker registry/capacity | `pi-agent-worker-*.ts` | `MIGRATE` | 保持 slot lease 和 global concurrency | 已确认 |
| Eval queue | `src/lib/eval/runtime.ts` | `FACADE` | `EvalQueuePort`，不使用进程内 Map 作为权威 | 已确认 |
| Benchmark child process | `runBenchmarkQueueItem` | `ADAPT` | `ProcessSupervisorPort` 管理启动、日志、取消和退出码 | 已确认 |
| Queue/report 关联 | `latestReportAfter` | `ADAPT` | runner 接收预分配 `queueId/reportId`；禁止按 mtime + mode 猜测报告 | 已确认 |
| Eval schedule | `EvalSchedule`、`checkQuantEvalSchedule` | `BLOCKED` | 当前仅被动 check API，无 UI 调用和主动 scheduler；不列入首版核心完成条件 | BLOCKED（非核心） |
| Process-local runningChildren | `src/lib/eval/runtime.ts#runningChildren` | `REMOVE` | 只可作为 adapter 内缓存，不能作为持久状态 | 已确认 |

## 7. AI、市场和第三方服务

| 依赖 | 源证据 | 建议分类 | 处理方式 | 状态 |
| --- | --- | --- | --- | --- |
| Model definitions | `src/lib/constants/models.ts` | `SHARED` | 模型 ID 和展示名保持兼容 | 已确认 |
| DeepSeek provider | `src/lib/agent/providers/deepseek.ts` | `FACADE` | `ModelProviderPort` adapter | 已确认 |
| OpenAI-compatible provider | `openai-compatible.ts` | `FACADE` | 本地 Qwen/ModelPort adapter | 已确认 |
| Deterministic tool-plan provider | `deterministic-tool-plan.ts` | `STUB` | 仅 contract/test，明确 `EVAL_MODE=contract` | 已确认 |
| Market HTTP client | `data-prefetch.ts`、`quant-api.ts` | `FACADE` | `MarketDataPort`，固定允许端点 | 已确认 |
| Market FastAPI 子集 | `services/market-data/**` | `MIGRATE` | 只迁移目标端点 import 闭包 | 已确认 |
| EastMoney/Tencent | Python providers | `ADAPT` | 超时、重试、限流和数据质量显式化 | 已确认 |
| BaoStock/AkShare | optional dependencies | `STUB`/`ADAPT` | 默认不启用；若生产启用则成为 adapter | 已确认 |
| Memory | `src/lib/platform/memory/**` | `FACADE` | 首版只实现正式 disabled adapter；HTTP adapter 和反馈 UI 暂不迁移 | 已确认 |
| Knowledge | `src/lib/platform/knowledge/**` | `FACADE` | 首版只实现正式 disabled adapter；HTTP adapter 和反馈 UI 暂不迁移 | 已确认 |
| Notification webhooks | `.env.example` 中 webhook 变量 | `REMOVE` | 不属于目标闭环 | 已确认 |
| Observability stack | Loki/Grafana/Alloy | `REMOVE`/`ADAPT` | 不迁移平台 UI；保留结构化日志接口 | 已确认 |

外部依赖必须采用下列一致策略：

| 外部依赖 | Adapter/Facade | 失败与重试 | 认证/环境 | 强制测试 |
| --- | --- | --- | --- | --- |
| PostgreSQL/TimescaleDB | Prisma repositories、Python DB repository | required 时启动或请求明确失败；只重试 deadlock/serialization | server-only connection string | schema preflight、断线、事务冲突、重启恢复 |
| Workspace/asset/report filesystem | Storage ports | IO、越界和 partial write 返回 typed error；不盲重试非幂等写 | 根路径必须解析到目标目录或显式目标数据根 | traversal、junction/symlink、磁盘失败、原子写 |
| 模型 Provider | `ModelProviderPort` | network/429/5xx 有界重试；401/403/schema 错误不重试 | server-only credential、host allowlist | 正常、缺凭据、401、429、5xx、timeout、invalid stream |
| Market FastAPI | `MarketDataPort` | partial 带 issues；全部核心数据失败则整体失败 | 固定内部 base URL；admin token 不入浏览器/preview | endpoint contract、timeout、stale、partial/all-failed |
| EastMoney/Tencent | Python provider adapters | 限流/网络有界退避；畸形响应不缓存 | 无浏览器直连；来源和 as-of 可追踪 | fixture、429、5xx、invalid JSON、fallback |
| BaoStock/AkShare | 默认关闭的可选 provider adapter | 显式启用后 import/调用失败返回 typed unavailable，不冒充 fallback 成功 | Python extra + 服务端配置 | disabled 不加载、enabled 缺依赖、provider failure |
| Redis | market cache adapter | optional 时显式 cache degraded；required 时失败 | server-only URL；首版不承担 realtime 正确性 | enabled/disabled/unavailable/required |
| Preview/benchmark 子进程 | `ProcessSupervisorPort` | 非零退出、超时、orphan 明确失败；按身份终止 | allowlist command、cwd 和 env | spawn、timeout、cancel、PID reuse、日志限额 |
| Playwright Chromium | visual validation adapter | required E2E 缺浏览器即失败；不得把 skip 当通过 | 仅目标安装 | browser missing、空白截图、console/page error |
| Memory/Knowledge | 正式 disabled adapters | 返回 disabled metadata，不发 HTTP、不伪造 use/feedback | 首版无 token | 零网络、零回执写入、宿主无静态反馈 import |
| Auth/quota | local-system facade | 公开 disabled；不创建 session、不 reserve quota；生产本机 mutation 需显式 loopback 开关或 server-only token | 显式 `WOLF_RESEARCH_AUTH_MODE=disabled`、`WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS`；admin token 不入浏览器 | 无 Better Auth import/session/Cookie/用户表依赖；loopback、跨站、token 优先级回归 |
| 已移除集成 | GitHub/Vercel/Supabase/ClickHouse/observability facades 不注册 | 端点为 404/明确 disabled，不尝试网络 | 无目标环境变量或凭据 | import、route、dependency、network allowlist 零引用 |

## 8. 预览与进程安全

| 依赖 | 源证据 | 建议分类 | 处理方式 | 状态 |
| --- | --- | --- | --- | --- |
| PreviewManager | `src/lib/services/preview.ts` | `FACADE` | `PreviewRuntimePort` | 已确认 |
| 生成代码执行边界 | `src/lib/security/generated-project-sandbox.ts` | `ADAPT` | 首版实现 Windows local unsandboxed adapter，默认拒绝并要求显式开关 | 已确认 |
| sandbox shell script | `scripts/security/run-generated-project-sandbox.sh` | `REMOVE` | 首版 Windows 部署不迁移；未来 hardened deployment 再评审 | 已确认 |
| Windows unsandboxed override | `QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE` | `ADAPT` | 改为 `WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE`；启用后 UI/API/日志必须可见 | 已确认 |
| 包管理器探测和安装 | `preview.ts` | `ADAPT` | 固定允许命令、超时、无脚本安装和日志 | 已确认 |
| preview 端口池 | `PREVIEW_PORT_START/END` | `ADAPT` | Port allocator + ownership fencing | 已确认 |
| preview market access | `preview.ts` | `ADAPT` | Windows 本地仅允许固定 loopback 市场地址和只读路径，不携带凭据 | 已确认 |

## 9. 评测中心

| 依赖 | 源证据 | 建议分类 | 处理方式 | 状态 |
| --- | --- | --- | --- | --- |
| Eval UI components | `src/components/quant/eval-*.tsx` | `MIGRATE` | 原 UI 和指标语义 | 已确认 |
| Eval API | `src/app/api/evals/**` | `MIGRATE` | 保持 action 兼容，内部调 ports | 已确认 |
| Eval runtime facade | `src/lib/eval/index.ts` | `SHARED` | 保留公共导出面 | 已确认 |
| Cases/eval sets | `src/lib/eval/cases.ts` | `MIGRATE` | 读取错误必须显式失败 | 已确认 |
| Evaluators/scoring/oracles | `src/lib/eval/{evaluators,scoring,oracles}.ts` | `MIGRATE` | 纯领域逻辑 | 已确认 |
| Statistics/regression/diagnostics | `statistics.ts`、`regression.ts`、`trace-diagnostics.ts` | `MIGRATE` | 结果展示和门禁需要 | 已确认 |
| Snapshot/dataset contracts | `snapshot-contract.ts`、`dataset-contract.ts` | `MIGRATE` | contract 模式需要 | 已确认 |
| Attestation/calibration/mutations | 对应 `src/lib/eval/**` | `MIGRATE` | CI 和可信报告需要 | 已确认 |
| Agent reviewer/repair | `agent-reviewer.ts`、`benchmark-repair.ts` | `MIGRATE` | E2E 与修复单需要 | 已确认 |
| Shadow replay | `shadow-replay.ts`、prepare script | `REMOVE` | 首版不迁移，不复制 private/production replay 数据 | 已确认 |
| Benchmark runner | `scripts/evals/run-quant-benchmarks.js` | `MIGRATE` | contract/E2E 共同入口 | 已确认 |
| Contract market fixture | `scripts/evals/run-contract-market-fixture.js` | `MIGRATE` | contract 测试使用 | 已确认 |
| Eval check scripts | dataset/calibration/mutation/CI/visual checks | `MIGRATE` | 迁移首版核心验收脚本；排除 schedule/shadow checks | 已确认 |
| Benchmark resources | `benchmarks/quantpilot/**`、`config/evals/**` | `MIGRATE` | 保留内部 `quantpilot` 目录名以兼容脚本和报告；数据必须公开、脱敏、版本化 | 已确认 |

## 10. 最小迁移集合

### 10.1 最小可启动产品集合

1. Next.js 应用壳、`/`、`/{project_id}/chat`、`/eval-platform` 和 run detail。
2. 目标页面实际 import 的 UI、contexts、hooks、styles 和图片。
3. 项目、消息、request、generation status、asset、repo file、validation、preview、approval API。
4. Finance query rewrite、run plan、prefetch、generation、mission、PI Agent、validation、preview 运行链。
5. PostgreSQL 最小 schema、Prisma client、migration。
6. Workspace 和 asset storage。
7. Generation queue 的 durable worker adapter；inline 仅保留给明确的测试/开发路径。
8. 目标市场端点及其 Python import 闭包；screener 固定 TimescaleDB adapter。
9. 模型 Provider facade 和至少一个可用正式 adapter。
10. Eval UI、API、领域模块、公开 benchmark 资源、contract runner，以及 queueId/reportId 强关联。
11. E2E eval 对研究 runtime 的复用。
12. `.env.example`、启动脚本、README 和测试命令。

### 10.2 不进入最小集合

- GitHub、Vercel、Supabase。
- skills 管理、策略平台、研究报告中心、业务知识、运维和可观测性页面。
- Electron/desktop packaging。
- 通知 webhook。
- 历史 skill tgz 版本全集。
- ClickHouse runtime、analytics routes 和 package。
- Better Auth 登录、用户 session、quota 模型和计量链。
- Memory/Knowledge HTTP provider、反馈 UI 和使用回执存储。
- Shadow Replay 代码、脚本及 private/production replay 数据。
- hidden/production replay 数据本体；只保留读取 Port 和“未配置”明确错误。
- Eval 自动 schedule；当前只保留阻塞说明，不把被动 check API 伪装为自动调度。

## 11. 已确认决策与待验证项

1. `已确认`：以当前 QuantPilot dirty snapshot 作为迁移基线，阶段三先生成只读 hash manifest。
2. `已确认`：首版 Windows 本地生成和预览；显式启用 unsandboxed adapter，不采用 Linux 容器。
3. `已确认`：首版 Auth 为 disabled local-system 模式，不迁移登录和 quota。
4. `已确认`：Memory、Knowledge 使用正式 disabled adapter。
5. `已确认`：Shadow Replay 和 ClickHouse runtime 不进入首版；screener 适配为明确 TimescaleDB 路径。
6. `已确认`：用户可见品牌为 Wolf Research，保留 MIT 归因和内部 `benchmarks/quantpilot/` 路径。
7. `已确认`：单机 Windows 首版 realtime 为 Web 进程内 WS/SSE + durable polling。
8. `BLOCKED（非核心）`：Eval schedule 缺少 UI 和主动 scheduler 拓扑，需后续确认进程所有权、
   lease、时钟和恢复策略。
