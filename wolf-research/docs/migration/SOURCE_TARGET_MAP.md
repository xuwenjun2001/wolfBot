# wolf-dashboard 重构源文件与目标文件映射

调查日期：2026-09-04

## 1. 映射约定

- 历史参考源路径均相对于只读源根 `D:\QuantPilot`。
- 重构目标路径均相对于 `D:\job\EzWin\wolfBot\wolf-research`。
- `same path` 表示保留源项目相对目录，降低 import 和路径合同变化。
- 状态“已确认”表示源文件已存在且在调用链中，并已由目标 import graph、构建或运行验证；
  “推测”表示目标拆分位置仍是方案建议；“BLOCKED”表示当前明确不进入核心范围且仍需产品/部署决策。
- 本文先作为阶段三的重构文件边界；阶段三/四实施后的实际目录偏差见下方“新增 Port/Adapter 映射”和
  `MIGRATION_PLAN.md` 的实施偏差记录。当前可执行映射已完成复核，未确认项仅保留 Eval schedule
  和其关联的自动调度决策。

## 2. 目标目录草图

```text
wolf-research/
├── package.json
├── package-lock.json
├── next.config.js
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── eslint.config.mjs
├── vitest.config.ts
├── .env.example
├── README.md
├── config/
├── prisma/
├── public/
├── .pi/
├── benchmarks/
├── scripts/
├── services/
│   └── market-data/
└── src/
    ├── app/
    ├── components/
    ├── contexts/
    ├── hooks/
    ├── lib/
    │   ├── agent/
    │   ├── domains/finance/
    │   ├── eval/
    │   ├── ports/
    │   ├── quant/
    │   └── services/
    └── types/
```

目标实际建立 `ports/` 作为边界合同；没有建立独立的 `adapters/` 目录，具体实现位于现有
`services/`、`server/`、`security/`、`agent/providers/` 和 `services/market-data/` 中。业务域文件
优先保持原路径。

## 3. 根配置映射

| 源 | 目标 | 处理 | 分类 | 状态 |
| --- | --- | --- | --- | --- |
| `package.json` | `package.json` | 按最小 import 闭包重建；不迁移写 `.env*` 的 `postinstall`；runner 保留时直接声明 `jiti`、`tsconfig-paths` | `ADAPT` | 已确认 |
| `package-lock.json` | `package-lock.json` | 在目标安装时生成并纳入父仓库 | `ADAPT` | 已确认 |
| `next.config.js` | `next.config.js` | 删除非目标 redirect；保留 external packages、security headers、trace 规则 | `ADAPT` | 已确认 |
| `tsconfig.json` | `tsconfig.json` | 保留 `@/*` 和 react-icons stub aliases | `MIGRATE` | 已确认 |
| `tsconfig.typecheck.json` | `tsconfig.typecheck.json` | 保留专项 type-check 范围 | `MIGRATE` | 已确认 |
| `tailwind.config.ts` | `tailwind.config.ts` | 保留 content 和 token | `MIGRATE` | 已确认 |
| `postcss.config.js` | `postcss.config.js` | 原样迁移 | `MIGRATE` | 已确认 |
| `eslint.config.mjs` | `eslint.config.mjs` | 移除不存在目录的 ignore 也可保留 | `ADAPT` | 已确认 |
| `vitest.config.ts` | `vitest.config.ts` | 保留 alias 和 Node test environment | `MIGRATE` | 已确认 |
| `components.json` | `components.json` | 保留目标 UI primitives 使用的 shadcn 配置 | `MIGRATE` | 已确认 |
| `.env.example` | `.env.example` | 只保留目标变量名和空值/安全示例，不复制源值；生产本机 eval mutation 需显式 loopback 开关，admin token 不入浏览器 | `ADAPT` | 已确认 |
| `docker-compose.yml` | `docker-compose.yml` | 仅 PostgreSQL/TimescaleDB、Redis；首版不含 ClickHouse | `ADAPT` | 已确认 |
| `README.md` | `README.md` | 新写目标启动、架构和限制 | `ADAPT` | 已确认 |
| `LICENSE` | `LICENSE` 或 `THIRD_PARTY_NOTICE.md` | 保留 QuantPilot MIT 许可证和迁移来源说明 | `ADAPT` | 已确认 |
| `scripts/dev/setup-env.js` | 不迁移 | 禁止安装阶段写环境文件或生成 secret | `REMOVE` | 已确认 |
| `scripts/dev/run-web.js`、`run-full.js` | `scripts/dev/**` 等价入口 | 重写为显式 startup coordinator；不含 Auth/quota bootstrap 和隐式 degradation 恢复 | `ADAPT` | 已确认 |

## 4. 路由和页面映射

| 源 | 目标 | 关键符号 | 处理 | 状态 |
| --- | --- | --- | --- | --- |
| `src/app/layout.tsx` | same path | `RootLayout` | 保留 Theme/Settings/Motion，改接 local-system context；删除 `AuthUserMenu` 静态 import | 已确认 |
| `src/app/globals.css` | same path | 全局 token 和平台 class | 迁移页面实际使用部分，先完整保留以降低视觉偏差 | 已确认 |
| `src/app/page.tsx` | same path | `HomePage`、`handleSubmit` | 移除非目标导航和 admin/account/report UI | 已确认 |
| `src/app/[project_id]/chat/page.tsx` | same path | `ChatPage`、`runAct`、`pauseAgent` | 保留研究工作区；删除发布集成 | 已确认 |
| `src/app/[project_id]/chat/preview-reconciliation.ts` | same path | `planPreviewReconciliation` | 保留 preview 恢复逻辑 | 已确认 |
| `src/app/eval-platform/page.tsx` | same path | `EvalPlatformPage` | 原路由 | 已确认 |
| `src/app/eval-platform/loading.tsx` | same path | loading UI | 原路由 loading | 已确认 |
| `src/app/eval-platform/EvalsDashboardClient.tsx` | same path | `EvalsDashboardClient` | 保留 3 秒 active queue polling | 已确认 |
| `src/app/eval-platform/runs/[runId]/page.tsx` | same path | `EvalRunPage` | 原路由 | 已确认 |
| `src/app/eval-platform/runs/[runId]/EvalRunDetailClient.tsx` | same path | `EvalRunDetailClient` | 原结果展示 | 已确认 |
| `src/app/login/**` | 不迁移 | login routes | 首版不需要登录页面 | 已确认 |
| `src/app/forbidden/**` | 不迁移 | forbidden routes | 首版 disabled auth 不需要拒绝页面 | 已确认 |

## 5. 前端组件映射

### 5.1 研究工作台

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `src/components/task/CreateTaskForm.tsx` | same path | 迁移 | 已确认 |
| `src/components/task/TaskDrawer.tsx` | same path | 迁移项目列表功能，移除非目标链接 | 已确认 |
| `src/components/chat/ChatInput.tsx` | same path | 迁移输入、图片和提交状态；删除 `PersonalMemoryComposer` import/render | 已确认 |
| `src/components/chat/ChatLog.tsx` | same path | 迁移 WS/SSE/polling 和恢复 | 已确认 |
| `src/components/chat/ChatLogView.tsx` | same path | 迁移；删除 Personal Memory/Governed Knowledge 反馈 import/render 分支 | 已确认 |
| `src/components/chat/DashboardGenerationWaiting.tsx` | same path | 迁移 | 已确认 |
| `src/components/chat/ToolApprovalPanel.tsx` | same path | 迁移 durable approval UI | 已确认 |
| `src/components/chat/ToolMessage.tsx` | same path | 迁移 | 已确认 |
| `src/components/chat/ToolResultItem.tsx` | same path | 迁移 | 已确认 |
| `src/components/chat/ThinkingSection.tsx` | same path | 迁移 | 已确认 |
| `src/components/chat/TurnMetricsFooter.tsx` | same path | 迁移 | 已确认 |
| `src/components/chat/LightMarkdown.tsx` | same path | 迁移 | 已确认 |
| `src/components/chat/question-composer.ts` | same path | 迁移 | 已确认 |
| `src/components/chat/PersonalMemory*.tsx` | 不迁移 | 首版 Memory disabled，不展示反馈 UI | 已确认 |
| `src/components/chat/GovernedKnowledgeFeedback.tsx` | 不迁移 | 首版 Knowledge disabled，不展示反馈 UI | 已确认 |
| `src/components/settings/ProjectSettings.tsx` | same path | 只保留模型和研究相关设置 | 已确认 |
| `src/components/ErrorBoundary.tsx` | same path | 迁移 | 已确认 |

### 5.2 评测中心

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `src/components/quant/eval-cases-view.tsx` | same path | 迁移 | 已确认 |
| `src/components/quant/eval-console-primitives.tsx` | same path | 迁移 | 已确认 |
| `src/components/quant/eval-evaluator-view.tsx` | same path | 迁移 | 已确认 |
| `src/components/quant/eval-overview-view.tsx` | same path | 迁移 | 已确认 |
| `src/components/quant/eval-queue-view.tsx` | same path | 迁移 | 已确认 |
| `src/components/quant/eval-sets-view.tsx` | same path | 迁移 | 已确认 |
| `src/components/quant/console-primitives.tsx` | same path | 迁移实际格式化 helper | 已确认 |

### 5.3 共享 UI 和布局

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `src/components/ui/**` 的实际 import 闭包 | same path | 通过 `rg`、type-check、build 和页面 smoke 锁定，不盲拷全集 | 已确认 |
| `src/components/layout/PageHeader.tsx` | same path | 删除 `AuthUserMenu` import，保留主题/页面动作 | 已确认 |
| `src/components/layout/PlatformSwitcher.tsx` | same path | 菜单改为 `/`、`/eval-platform` | 已确认 |
| `src/components/auth/AuthUserMenu.tsx` | 不迁移 | 首版固定 disabled local-system 模式 | 已确认 |
| `src/contexts/ThemeContext.tsx` | same path | 迁移 | 已确认 |
| `src/contexts/GlobalSettingsContext.tsx` | same path | 迁移最小模型设置 | 已确认 |
| `src/contexts/AuthContext.tsx` | same path | 重写为最小 local-system context，不静态导入 `authClient`/Better Auth | 已确认 |
| `src/hooks/useWebSocket.ts` | same path | 迁移并通过 realtime facade 适配 | 已确认 |
| `src/hooks/useUserRequests.ts` | same path | 修改失败语义，不再把 endpoint 故障当无请求 | 已确认 |
| `src/hooks/useCLI.ts` | same path | 适配最小 settings facade | 已确认 |
| `src/lib/motion.ts` | same path | 迁移 | 已确认 |
| `src/lib/utils.ts` | same path | 迁移 `cn` 等 helper | 已确认 |

## 6. API 路由映射

### 6.1 研究核心 API

| 源 | 目标 | 关键方法 | 状态 |
| --- | --- | --- | --- |
| `src/app/api/projects/route.ts` | same path | `GET`、`POST`；删除 quota imports，项目幂等改用独立 operation repository | 已确认 |
| `src/app/api/projects/[project_id]/route.ts` | same path | `GET`、`PUT`、`DELETE` | 已确认 |
| `src/app/api/assets/[project_id]/upload/route.ts` | same path | `POST` | 已确认 |
| `src/app/api/assets/[project_id]/[filename]/route.ts` | same path | `GET` | 已确认 |
| `src/app/api/chat/[project_id]/act/route.ts` | same path | `POST` | 已确认 |
| `src/app/api/chat/[project_id]/messages/route.ts` | same path | `GET`、`POST`、`DELETE` | 已确认 |
| `src/app/api/chat/[project_id]/requests/active/route.ts` | same path | `GET` | 已确认 |
| `src/app/api/chat/[project_id]/pause/route.ts` | same path | `POST` | 已确认 |
| `src/app/api/chat/[project_id]/stream/route.ts` | same path | `GET` SSE | 已确认 |
| `src/pages/api/ws/[projectId].ts` | same path | `handler` upgrade | 已确认 |
| `src/app/api/projects/[project_id]/generation/status/route.ts` | same path | `GET` | 已确认 |
| `src/app/api/projects/[project_id]/retry-initialization/route.ts` | same path | `POST` | 已确认 |
| `src/app/api/projects/[project_id]/quant/validation/route.ts` | same path | `GET`、`POST` | 已确认 |
| `src/app/api/projects/[project_id]/preview/start/route.ts` | same path | `POST` | 已确认 |
| `src/app/api/projects/[project_id]/preview/stop/route.ts` | same path | `POST` | 已确认 |
| `src/app/api/projects/[project_id]/preview/status/route.ts` | same path | `GET` compatibility/status 恢复 | 已确认 |
| `src/app/api/repo/[project_id]/tree/route.ts` | same path | `GET` | 已确认 |
| `src/app/api/repo/[project_id]/file/route.ts` | same path | `GET`、`PUT` | 已确认 |
| `src/app/api/projects/[project_id]/files/route.ts` | same path | `GET` compatibility facade | 已确认 |
| `src/app/api/projects/[project_id]/files/content/route.ts` | same path | `GET`、`PUT` compatibility facade | 已确认 |
| `src/app/api/projects/[project_id]/agent/approvals/route.ts` | same path | `GET` | 已确认 |
| `src/app/api/projects/[project_id]/agent/approvals/[approval_id]/route.ts` | same path | `POST` | 已确认 |
| `src/app/api/settings/cli-status/route.ts` | same path | `GET` compatibility facade | 已确认 |
| `src/app/api/settings/global/route.ts` | same path | `GET` compatibility facade | 已确认 |
| `src/app/api/settings/route.ts` | same path | 最小 `GET/PUT` compatibility facade | 已确认 |

`src/app/api/projects/[project_id]/files/**` 与 `src/app/api/repo/[project_id]/**` 功能重叠。
目标仍保留 `files/route.ts` 和 `files/content/route.ts` 作为兼容的受保护文件 facade；`ChatPage`
的主链使用 repo API，两个入口都复用同一目标文件服务和路径策略。该共存关系已由目标文件、
type-check、边界测试和 HTTP smoke 确认，不表示复制了两套存储实现。

### 6.2 评测 API

| 源 | 目标 | 关键方法 | 状态 |
| --- | --- | --- | --- |
| `src/app/api/evals/route.ts` | same path | `GET`、`POST` action dispatch | 已确认 |
| `src/app/api/evals/runs/[runId]/route.ts` | same path | `GET` | 已确认 |

### 6.3 鉴权 API

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `src/app/api/auth/[...all]/route.ts` | 不迁移 | 首版无 Better Auth handler | 已确认 |
| `src/proxy.ts` | same path 或 route-local helper | 只保留 same-origin/安全边界；重写以删除 auth access/audit 静态依赖 | 已确认 |

### 6.4 动态加载和初始化映射

| 源依赖 | 目标处理 | 状态 |
| --- | --- | --- |
| `page.tsx` 动态 `GlobalSettings`、`TaskDrawer` | 计入文件 manifest、bundle 和 E2E | 已确认 |
| `query-rewrite.ts` 动态 LLM adapter | 保留并加入 provider-disabled/缺配置测试 | 已确认 |
| `run-engine.ts` 动态 PI packages | 保留；PI packages 必须是直接依赖 | 已确认 |
| `finance-generation-executor.ts` 动态 PI CLI runtime | 保留并计入 worker/runtime manifest | 已确认 |
| validation/scaffold/preview 动态 import | 保留；route、worker、runner 三种入口均做模块加载测试 | 已确认 |
| `visual-validation.ts` 动态 Playwright | 保留；required E2E 缺 Chromium 必须失败 | 已确认 |
| benchmark/check scripts 的 `jiti`、`tsconfig-paths/register` | 直接声明依赖或统一替换为显式 TS runtime | 已确认 |
| benchmark runner 动态 chat act route | 计入 E2E runner 闭包，不依赖 Next build 偶然包含 | 已确认 |
| data-agent application 模块注册 | 封装幂等 `registerApplications` 初始化 | 已确认 |
| Preview/Stream/WS global singleton、heartbeat、upgrade listener | 保留兼容行为并增加 HMR/重复加载/清理测试 | 已确认 |

## 7. 研究领域和应用服务映射

### 7.1 Finance domain

| 源 | 目标 | 关键符号 | 状态 |
| --- | --- | --- | --- |
| `src/lib/domains/finance/workspace.ts` | same path | `writeInitialRunPlan`、`readQuantRunPlan` | 已确认 |
| `src/lib/domains/finance/workspace-artifacts.ts` | same path | artifact paths/types | 已确认 |
| `src/lib/domains/finance/query-rewrite.ts` | same path | `rewriteQuantQuery` | 已确认 |
| `src/lib/domains/finance/query-rewrite-llm.ts` | same path | configured provider rewrite | 已确认 |
| `src/lib/domains/finance/intent.ts` | same path | `buildClarificationContinuation` | 已确认 |
| `src/lib/domains/finance/mission-definition.ts` | same path | finance mission | 已确认 |
| `src/lib/domains/finance/capabilities.ts` | same path | capability catalog | 已确认 |
| `src/lib/domains/finance/agent-profile.ts` | same path | skill capability descriptor | 已确认 |
| `src/lib/domains/finance/visualization-templates.ts` | same path | template serialization | 已确认 |
| `src/lib/domains/finance/image-attachment-context.ts` | same path | attachment context | 已确认 |
| `src/lib/domains/finance/data-identity.ts` | same path | source identity | 已确认 |
| `src/lib/domains/finance/data-agent-projection.ts` | same path | projection | 已确认 |
| `src/lib/domains/finance/agent-tools/**` | same path | finance tool factory/contracts | 已确认 |

### 7.2 Quant orchestration

| 源 | 目标 | 关键符号 | 状态 |
| --- | --- | --- | --- |
| `src/lib/quant/chat-act-contract.ts` | same path | request schema | 已确认 |
| `src/lib/quant/chat-act-support.ts` | same path | root/validation helpers | 已确认 |
| `src/lib/quant/finance-act-preparation.ts` | same path | preparation workflow | 已确认 |
| `src/lib/quant/data-prefetch.ts` | same path | `prefetchQuantDataForRunPlan` | 已确认 |
| `src/lib/quant/finance-generation-executor.ts` | same path | generation envelope/executor | 已确认 |
| `src/lib/quant/generation-runtime.ts` | same path | runtime factory | 已确认 |
| `src/lib/quant/generation-queue.ts` | same path | queue facade client | 已确认 |
| `src/lib/quant/generation-state.ts` | same path | workspace generation state | 已确认 |
| `src/lib/quant/generation-terminal.ts` | same path | terminal projection | 已确认 |
| `src/lib/quant/generation-validation.ts` | same path | validate/repair/preview orchestration | 已确认 |
| `src/lib/quant/generation-preview.ts` | same path | accepted preview | 已确认 |
| `src/lib/quant/validation.ts` | same path | core validation | 已确认 |
| `src/lib/quant/visual-validation.ts` | same path | browser validation | 已确认 |
| `src/lib/quant/workspace-progress.ts` | same path | five-stage projection | 已确认 |
| `src/lib/quant/workspace-response.ts` | same path | user-facing progress | 已确认 |
| `src/lib/quant/realtime-generation-status.ts` | same path | realtime status shape | 已确认 |
| `src/lib/quant/repair-convergence.ts` | same path | repair bounds | 已确认 |
| `src/lib/quant/evidence.ts` | same path | evidence helpers | 已确认 |

### 7.3 Project, message and PI stores

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `src/lib/services/project.ts` | same path | Repository/Storage 注入；删除 quota allocation reconciliation import | 已确认 |
| `src/lib/services/message.ts` | same path | Repository 注入 | 已确认 |
| `src/lib/services/user-requests.ts` | same path | 保留 claim/idempotency；删除 structural quota capacity import | 已确认 |
| `src/lib/services/stream.ts` | same path | 改为 RealtimePort facade | 已确认 |
| `src/lib/services/preview.ts` | same path | 改为 PreviewRuntimePort facade/adapter | 已确认 |
| `src/lib/services/pi-agent-prompts.ts` | same path | 迁移 | 已确认 |
| `src/lib/services/pi-agent-*.ts` 的 mission/run/checkpoint/candidate/lease/dispatch/worker/approval 子集 | same path | 按 import graph 迁移 | 已确认 |
| `src/lib/services/cli/pi-agent.ts` | same path | Model/Storage/Realtime 注入 | 已确认 |
| `src/lib/services/cli/pi-agent-workspace.ts` | same path | 迁移 | 已确认 |
| `src/lib/serializers/chat.ts` | same path | 迁移 | 已确认 |

## 8. Agent 核心映射

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `src/lib/agent/pi/**` 的入口闭包 | same path | PI run engine | 已确认 |
| `src/lib/agent/core/**` 的实际闭包 | same path | phase graph、tool outcomes；不整体复制目录 | 已确认 |
| `src/lib/agent/mission/**` 的实际闭包 | same path | mission compiler/evidence verifier | 已确认 |
| `src/lib/agent/runtime/**` 的实际闭包 | same path | repository、events、locks、journal；排除非目标 runtime | 已确认 |
| `src/lib/agent/providers/deepseek.ts` | same path | provider adapter | 已确认 |
| `src/lib/agent/providers/openai-compatible.ts` | same path | provider adapter | 已确认 |
| `src/lib/agent/providers/deterministic-tool-plan.ts` | same path | contract/test adapter | 已确认 |
| `src/lib/agent/tools/**` | same path | 只迁移 finance tools 需要的通用框架；目标闭包已由 type-check、unit 和 E2E 验证 | 已确认 |
| `src/lib/agent/context/**` | same path | 只迁移 PI run engine import 闭包；目标闭包已由 type-check、unit 和 E2E 验证 | 已确认 |
| `src/lib/agent/skills/**` | same path | compiler、types、index | 已确认 |
| `src/lib/agent/framework-identity.ts` | same path | eval attestation 使用 | 已确认 |
| `src/lib/agent/input-policy.ts` | same path | act ingress 使用 | 已确认 |

只读 AST 调查显示，在未设置 Auth/Quota/Memory/Knowledge 适配断点时，研究入口可达 307 个本地文件，
评测入口可达 259 个本地文件；该数量包含大量横切平台代码，不能作为迁移清单。实施时必须先应用
适配断点，再生成 TypeScript import graph，并把动态 import、runner、JSON registry 和 child process
脚本合并到最终 manifest。

## 9. Data Agent、工作区和安全映射

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `src/lib/data-agent/**` 的 contracts、registry、workspace、image、generation 子集 | same path | 只迁移最终 import 闭包，不整体复制目录 | 已确认 |
| `src/lib/server/file-browser.ts` | same path | 文件 API | 已确认 |
| `src/lib/server/image-assets.ts` | same path | asset API | 已确认 |
| `src/lib/server/privileged-request.ts` | same path | eval mutation | 已确认 |
| `src/lib/server/websocket-upgrade.ts` | same path | WS origin boundary | 已确认 |
| `src/lib/server/websocket-manager.ts` | same path | realtime adapter | 已确认 |
| `src/lib/security/generated-project-sandbox.ts` | same path | 改为 Windows local execution gate；默认拒绝，显式开关放行 | 已确认 |
| `scripts/security/run-generated-project-sandbox.sh` | 不迁移 | 首版不采用 Linux namespace sandbox | 已确认 |
| `src/lib/utils/scaffold.ts` | same path | 适配目标根和共享 node_modules | 已确认 |
| `src/lib/utils/**` 实际 import 闭包 | same path | hash、JSON、path、scaffold 和 process helper；目标闭包已由 type-check、build 和 E2E 验证 | 已确认 |

## 10. 数据库与鉴权映射

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `prisma/schema.prisma` | same path | 提取研究、EvalRun/Queue/Repair 模型；不含 auth/quota/knowledge 或 blocked EvalSchedule | 已确认 |
| `prisma/migrations/**` | same path | 不直接全量复制；生成目标一致 migration，已通过 `prisma:deploy` 和 schema readiness | 已确认 |
| `src/lib/db/client.ts` | same path | 保留 Prisma singleton；重写 `PRISMA_CLIENT_CONTRACT`，移除 auth/quota/knowledge 版本标签 | 已确认 |
| `src/lib/db/pi-agent-schema-readiness.ts` | same path | worker/lease schema preflight | 已确认 |
| `src/lib/auth/action.ts` | same path | 收敛为 disabled local-system `requireAction` facade | 已确认 |
| `src/lib/auth/authorization.ts` | same path | 仅保留业务 action/project context 契约 | 已确认 |
| `src/lib/auth/permissions.ts` | 按 import 闭包迁移 | 保留 action 类型，不迁移账户角色管理 | 已确认 |
| `src/lib/auth/access.ts`、`http.ts`、`audit.ts` | 不迁移 | Better Auth/local user 路径不在首版范围 | 已确认 |
| `src/lib/auth/server.ts`、`client.ts`、`password.ts` | 不迁移 | 首版不使用 Better Auth | 已确认 |
| `src/lib/config/auth.ts` | same path | 固定并公开 disabled local-system 模式 | 已确认 |
| `config/auth.json` | 不迁移 | 首版 disabled local-system facade 不需要该登录配置 | 已确认 |
| `config/access-control.json` | 不迁移 | 首版不启用用户授权系统，action 类型由目标 facade 提供 | 已确认 |
| `src/lib/quota/**` | 不迁移 | 首版暂不需要配额和计量 | 已确认 |

## 11. 新增 Port/Adapter 映射

这些目标文件没有一一对应源文件，是封口设计。阶段三/四实施核对如下：

| 目标新文件 | 吸收的源耦合 | 状态 |
| --- | --- | --- |
| `src/lib/ports/auth.ts` | `auth/**`、`config/auth.ts` | 已确认（已建立） |
| `src/lib/ports/context.ts`、`errors.ts` | 统一操作上下文和结构化错误 | 已确认（已建立） |
| `src/lib/ports/eval-repository.ts` | `eval/runtime.ts` 的 catalog 持久化 | 已确认（已建立，含 Prisma 实现） |
| `src/lib/ports/knowledge.ts`、`memory.ts` | Knowledge/Memory disabled 行为 | 已确认（已建立） |
| `src/lib/ports/market-data.ts` | 市场服务调用合同 | 已确认（已建立；调用实现位于 finance tool/data-prefetch） |
| `src/lib/ports/preview-runtime.ts` | `PreviewManager` | 已确认（已建立；具体实现位于 `services/preview.ts`） |
| `src/lib/ports/startup.ts` | env preflight 和启动状态 | 已确认（已建立） |
| `src/lib/adapters/**` | 数据库、文件、进程、HTTP、实时具体 adapter | 已确认（未建立；由既有 services/server/security/providers 实现） |

未建立的原计划独立 Port（project repository、research-run repository、workspace/asset storage、
generation/eval queue、model/process/realtime、clock/id-generator）没有被空壳替代：实际实现分别
保留在 `services/project.ts`、`services/pi-agent-run-store.ts`、`data-agent/workspace-*`、
`quant/generation-queue.ts`、`agent/providers/*`、`services/preview.ts`、`services/stream.ts` 和
`server/websocket-manager.ts` 等已迁移闭包中。该事实是实施偏差，不表示这些能力被删除。

详细契约见 [INTERFACE_CONTRACTS.md](./INTERFACE_CONTRACTS.md)。

## 12. 评测领域映射

以下文件迁移到相同相对路径：

| 源文件 | 目标处理 | 状态 |
| --- | --- | --- |
| `src/lib/eval/index.ts` | 公共 facade | 已确认 |
| `src/lib/eval/types.ts` | 类型合同 | 已确认 |
| `src/lib/eval/constants.ts` | 常量/标签 | 已确认 |
| `src/lib/eval/paths.ts` | 改为配置注入，不直接把 `process.cwd()` 当唯一根 | 已确认 |
| `src/lib/eval/runtime.ts` | 拆出 Repository/Queue/Process adapters | 已确认 |
| `src/lib/eval/runtime-utils.ts` | JSON helper，读取失败不得默认空 | 已确认 |
| `src/lib/eval/runtime-mappers.ts` | DB/file mapper | 已确认 |
| `src/lib/eval/cases.ts` | seed JSON 只读 + `EvalCatalogRepository` 自定义 case/set；不写仓库资源 | 已确认（已实施） |
| `src/lib/eval/evaluators.ts` | evaluator registry | 已确认 |
| `src/lib/eval/scoring.ts` | scoring | 已确认 |
| `src/lib/eval/oracles.ts` | assertions | 已确认 |
| `src/lib/eval/statistics.ts` | stability/CI | 已确认 |
| `src/lib/eval/regression.ts` | regression | 已确认 |
| `src/lib/eval/trace-diagnostics.ts` | diagnostics | 已确认 |
| `src/lib/eval/snapshot-contract.ts` | snapshot hash/contract | 已确认 |
| `src/lib/eval/dataset-contract.ts` | dataset contract | 已确认 |
| `src/lib/eval/report-attestation.ts` | report attestation | 已确认 |
| `src/lib/eval/e2e-attestation.ts` | Agent E2E attestation | 已确认 |
| `src/lib/eval/judge-calibration.ts` | judge calibration | 已确认 |
| `src/lib/eval/mutations.ts` | mutation tests | 已确认 |
| `src/lib/eval/analysis.ts` | dashboard analysis | 已确认 |
| `src/lib/eval/agent-reviewer.ts` | workspace reviewer | 已确认 |
| `src/lib/eval/benchmark-repair.ts` | E2E repair loop | 已确认 |
| `src/lib/eval/schedule-defaults.ts` | `BLOCKED（非核心）`；保留被动错误，不接入自动 scheduler | BLOCKED（非核心） |
| `src/lib/eval/shadow-replay.ts` | 不迁移 | 已确认 |

对应测试 `src/lib/eval/*.test.ts` 随生产文件迁移，优先保持原相对路径。

## 13. Benchmark 和 skill 资源映射

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `scripts/evals/run-quant-benchmarks.js` | same path | 迁移并通过 ProcessSupervisor 启动 | 已确认 |
| `scripts/evals/run-contract-market-fixture.js` | same path | contract fixture | 已确认 |
| `scripts/evals/prepare-shadow-replay.js` | 不迁移 | Shadow Replay 不进入首版 | 已确认 |
| eval dataset/calibration/mutation/CI/visual check scripts | same path | 迁移首版核心检查；排除 schedule 和 shadow replay 检查 | 已确认 |
| `scripts/checks/check-quant-benchmark-coverage.js` | same path | 迁移 | 已确认 |
| `scripts/checks/quant-e2e-suite.js` | same path | 迁移 | 已确认 |
| `benchmarks/quantpilot/cases.json` | same path | 保留内部目录兼容，内容保持公开脱敏 | 已确认 |
| `benchmarks/quantpilot/datasets.json` | same path | 同上 | 已确认 |
| `benchmarks/quantpilot/e2e-suite.json` | same path | 同上 | 已确认 |
| `benchmarks/quantpilot/*.contract.json` | same path | 同上 | 已确认 |
| `benchmarks/quantpilot/query-rewrite-fixtures.json` | same path | 同上 | 已确认 |
| `benchmarks/quantpilot/snapshot-manifest.json` | same path | 同上 | 已确认 |
| `benchmarks/quantpilot/snapshots/*.json` | same path | 同上 | 已确认 |
| `config/evals/*.json` | same path | 迁移 | 已确认 |
| `.pi/skills.registry.json` | same path | 保留 12 个 stable skills，包括 provisioning 使用的 platform UI skill | 已确认 |
| `.pi/skills.lock.json` | same path | 由目标 skill 源重新生成，不能手改 hash；已通过 lock/package 检查 | 已确认 |
| `config/pi-agent-skill-capsules.json` | same path | 迁移研究 skill capsules | 已确认 |
| `.pi/skills/{finance-skill}/**` | same path | 迁移 11 个 finance skills | 已确认 |
| `.pi/skills/platform-ui-product-design/**` | same path | `provisionProject#additionalSkillIds` 的实际依赖 | 已确认 |
| `.pi/skill-packages/*.tgz` | same path | 只生成当前版本包，不复制历史版本目录；已通过 Windows 打包和 hash 检查 | 已确认 |

已确认保留内部 `benchmarks/quantpilot` 目录名，以减少 runner、报告 schema 和 snapshot
manifest 的无关改动；用户可见品牌仍统一为 Wolf Research。

## 14. 市场服务映射

### 14.1 服务配置

| 源 | 目标 | 处理 | 状态 |
| --- | --- | --- | --- |
| `services/market-data/pyproject.toml` | same path | 只保留实际依赖和 extras | 已确认 |
| `services/market-data/uv.lock` | same path | 目标安装后锁定 | 已确认 |
| `services/market-data/src/quantpilot_market_data/**` | same path | 首版保留内部 Python package 名以避免全量 import 重写；用户可见品牌改为 Wolf Research | 已确认（已实施） |
| `services/market-data/tests/**` | same path | 迁移目标端点测试 | 已确认 |

### 14.2 最小 Python 模块

| 源模块 | 目标处理 | 状态 |
| --- | --- | --- |
| `api.py`、`cli.py`、`models.py`、`security.py` | 迁移最小 app 和合同 | 已确认 |
| `cache.py`、`database_core.py` | 迁移 | 已确认 |
| `routers/quotes.py` | 迁移 | 已确认 |
| `routers/indicators.py` | 迁移 | 已确认 |
| `routers/fundamentals.py` | 迁移 | 已确认 |
| `routers/events.py` | 迁移 | 已确认 |
| `routers/backtests.py` | 迁移 | 已确认 |
| `routers/research.py` | 迁移目标 GET 端点；管理型 POST 端点移除 | 已确认 |
| `services/quotes.py`、`indicators.py`、`fundamentals.py`、`events.py`、`backtests.py`、`research.py` | 迁移 | 已确认 |
| `services/kline_gateway.py` | 本地优先历史链 | 已确认 |
| `repositories/**` 的上述 service import 闭包 | 迁移最终闭包，不复制管理/analytics 全集 | 已确认（已实施） |
| `providers/base.py`、`providers/eastmoney.py` | 迁移 | 已确认 |
| Tencent 历史 Provider 所在模块 | 迁移 | 已确认 |
| `providers/baostock.py`、`providers/akshare.py` | 默认不启用，可选 adapter | 已确认 |
| `repositories/screener.py` | 移除 ClickHouse 顶层 import/sync 分支，固定 TimescaleDB 路径 | 已确认 |
| `clickhouse.py`、`repositories/analytics.py`、`routers/analytics.py` | 不迁移 | 已确认 |
| ingestion 管理和 provider-candidate 管理模块 | 管理端点不进入目标；研究 Agent 对应的管理路径由量化 API allowlist 明确拒绝 | 已确认（未进入目标调用闭包） |

## 15. 明确不迁移的源范围

| 源范围 | 原因 | 状态 |
| --- | --- | --- |
| `src/app/skills/**`、`src/app/api/skills/**` | skill 管理平台不在目标范围 | 已确认 |
| `src/app/ops-platform/**`、observability 页面/API | 运维平台不在目标范围 | 已确认 |
| `src/app/business-knowledge/**` | 知识管理 UI 不在目标范围 | 已确认 |
| `src/app/strategy-platform/**`、strategies APIs | 策略中心不在目标范围 | 已确认 |
| `src/app/research-reports/**` | 成果中心不在目标范围 | 已确认 |
| GitHub/Vercel/Supabase 组件、API、service | 发布和外部项目集成不在目标范围 | 已确认 |
| `electron/**`、`index.js`、desktop build scripts | 桌面封装不在目标范围 | 已确认 |
| Loki/Grafana/Alloy UI 配置 | 目标不迁移平台 UI，仅保留结构化日志接口 | 已确认 |
| Better Auth、AuthUserMenu、auth API 和 auth bootstrap | 首版使用 local-system facade，避免静态/启动闭包 | 已确认 |
| Personal Memory/Governed Knowledge 反馈组件和 API | 首版 disabled；宿主组件删除静态 import/render | 已确认 |
| ClickHouse runtime、analytics routes、sync repository | screener 使用 TimescaleDB adapter | 已确认 |
| 源 `.env`、`.env.local` | 包含本地环境信息，禁止复制 | 已确认 |
| 源 `data/**`、`tmp/**` | 用户数据、运行数据、日志，禁止复制 | 已确认 |
| 源 `.next`、`node_modules`、`.ruff_cache`、Python venv | 构建物和缓存，禁止复制 | 已确认 |

## 16. 实施期映射检查

阶段三每批复制前后都应生成并审阅：

```powershell
rg --files wolf-research
rg -n "D:\\QuantPilot|D:/QuantPilot|wolf-dashboard" wolf-research
rg -n "@/[^\"']+" wolf-research/src
rg -n "better-auth|AuthUserMenu|PersonalMemoryComposer|GovernedKnowledgeFeedback" wolf-research/src
rg -n "import\\(|dynamic\\(|jiti|tsconfig-paths/register" wolf-research/src wolf-research/scripts
git status --short
git diff --check
```

上述 import、动态加载、边界和 Git 检查已在阶段三/四执行；结果为 type-check、build、unit、
contract/live E2E、页面 smoke、module-boundary 和 provider-boundary 均通过。最后一次全量结果
记录于 [VALIDATION_REPORT.md](./VALIDATION_REPORT.md)；`Eval schedule` 是唯一保留的非核心 `BLOCKED`
事项。
