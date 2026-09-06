# wolf-dashboard 重构可执行验收标准与测试矩阵

调查日期：2026-09-04

## 1. 使用方式

- 本文件定义阶段三、阶段四的完成门槛。
- “强制”项必须通过；环境不足时只能记录未通过，不能豁免后声明完成。
- 所有命令必须在 `wolf-research` 或明确的测试服务环境执行，禁止在源项目安装依赖或生成产物。
- 阶段三、阶段四的重构和验证已执行到最终收尾；完整结果见
  [VALIDATION_REPORT.md](./VALIDATION_REPORT.md)。目标核心流程有历史通过记录；当前独立复核
  仍保留 contract 入口和 Eval queue 恢复阻断，不能把历史结果等同于当前全部强制项通过。

## 1.1 当前执行状态（2026-09-06）

- 已通过：目标依赖安装、Prisma schema/deploy、TypeScript、lint、540 个单元测试（73 个文件）、Next
  production build、市场服务测试、skill/dataset/judge/mutation/module-boundary/provider-boundary
  检查、contract benchmark（16/16，平均 95）。
- 已通过：研究工作台真实 HTTP 主流程 `validation-http-20260905-009`，包括 query rewrite、
  行情预取、PostgreSQL durable queue、PI Agent、看板 artifact、validation 和显式
  Windows unsandboxed preview；桌面/移动页面检查也通过。
- 已通过：评测页面、空/错误详情、malformed eval action、product-control E2E（1/1）。
- 历史已通过：`npm.cmd run benchmark:quant:e2e -- --model=deepseek-v4-flash --concurrency=1` 的
  4 个 live-model 用例均通过；每项 `agentExecuted=true`、100 分，release attestation 通过。
  run plan 使用锁定的 `https://api.deepseek.com` 和目标环境中的 `DEEPSEEK_API_KEY`，未回退到
  Qwen 或 ModelPort。
- 已保留：早期无凭据和临时 stub 的 fail-closed 失败，以及预算、市场、编辑和 Windows 进程清理
  失败，均作为历史审计记录，不改写为成功。
- 未执行：`test:pi-agent:postgres`、`test:integration`、`test:e2e`、`eval:ci:e2e`、
  `check:eval-platform-visual` 在目标 `package.json` 没有对应入口；已有 unit、PostgreSQL
  deploy/readiness、HTTP、contract、Playwright smoke 和 live-model runner 证据，不把其他检查
  命名为这些脚本。
- 当前复核未通过：直接执行 `npm.cmd run benchmark:quant:contract` 为 4/16；Eval queue
  没有独立 worker 的启动恢复验证；构建 trace 和错误响应脱敏仍有待处理风险。

## 2. 阶段一和阶段二文档验收

| ID | 标准 | 检查方法 | 当前结果 |
| --- | --- | --- | --- |
| DOC-001 | 仅在 `wolf-research/docs/migration/` 写入调查文档 | `git status --short` | 阶段二通过；阶段三/四按批准范围加入目标代码和验证报告 |
| DOC-002 | 七份要求文档存在 | `Get-ChildItem wolf-research/docs/migration` | 阶段二七份文档通过；最终另有 `VALIDATION_REPORT.md` |
| DOC-003 | 两模块调用链覆盖 route 到 external service | 人工审阅 `RESEARCH_REPORT.md` | 通过 |
| DOC-004 | 依赖全部使用七类之一 | 人工审阅 `DEPENDENCY_INVENTORY.md` | 通过 |
| DOC-005 | 结论标记已确认/推测/待验证 | 文本检查 | 通过 |
| DOC-006 | 接口包含请求、响应、错误、超时、重试、认证和环境差异 | 人工审阅 `INTERFACE_CONTRACTS.md` | 通过 |
| DOC-007 | 未创建 commit、未 push、未切换分支 | Git 检查 | 通过，仍为 `main` 跟踪 `origin/main` |
| DOC-008 | 未修改源项目 | 对比源 `git status` 与调查前 35 项基线 | 通过，仍为相同 35 项、同一提交和分支 |
| DOC-009 | 动态 import、alias、Provider、startup 和 singleton 初始化已登记 | 跨文档与源码符号复核 | 通过 |
| DOC-010 | 公共模块未按整个目录误列为必迁 | import 闭包和适配断点复核 | 通过 |
| DOC-011 | 每个迁移批次有验证检查点和精确回退边界 | `MIGRATION_PLAN.md` 矩阵 | 通过 |
| DOC-012 | 无法由代码确认的事项标为 BLOCKED | schedule 调用拓扑复核 | 通过，1 个非核心阻塞项 |

本阶段实际执行的文档验证：

- `git diff --check`：通过。
- 新文档尾随空白扫描：0 项；七个文件均以换行结尾。
- Markdown 相对链接检查：通过。
- Markdown 代码围栏成对检查：通过。
- Markdown 表格列数检查：通过。
- 六份方案文档陈旧结论扫描：通过；未残留错误 motion 路径、platform skill REMOVE、
  ClickHouse 条件迁移、多实例 Redis 强制项或 schedule 已完成表述。
- 动态 import、alias、Provider、startup、singleton、queue/report 关联和回退矩阵必需事实扫描：通过。
- 私钥头、AWS access key、长 bearer token 和疑似 secret 赋值模式扫描：0 命中。
- `wolf-research/.git` 检查：不存在。
- 非 Markdown 文件检查：0 项。
- 未在源项目安装依赖、构建或运行测试；目标依赖、构建、类型、lint、单元、市场、HTTP、contract
  和 live-model 验证已在批准后的迁移/验证阶段执行，结果见本文件和 `VALIDATION_REPORT.md`。

## 3. 安装、构建和静态检查

| ID | 强制 | 操作 | 通过条件 |
| --- | --- | --- | --- |
| BUILD-001 | 是 | `npm.cmd ci` | 从目标 lock 安装成功，无 source/sibling path dependency |
| BUILD-002 | 是 | `npm.cmd run prisma:generate` | 目标 schema 生成成功 |
| BUILD-003 | 是 | `npm.cmd run type-check` | 0 TypeScript error |
| BUILD-004 | 是 | `npm.cmd run lint` | 0 error；warning 必须记录 |
| BUILD-005 | 是 | `npm.cmd run build` | Next production build 成功 |
| BUILD-006 | 是 | `npm.cmd run test:unit` | 全部单元测试通过 |
| BUILD-007 | 是 | `uv sync --project services/market-data --group dev` | 只在目标创建环境并成功锁定 |
| BUILD-008 | 是 | `uv run --project services/market-data pytest -q services/market-data/tests` | 全部 Python 测试通过 |
| BUILD-009 | 是 | `npm.cmd run check:skills` | registry、lock、package hash 一致 |
| BUILD-010 | 是 | `git diff --check` | 无空白错误 |
| BUILD-011 | 是 | runner 直接依赖检查 | `jiti`、`tsconfig-paths` 被直接声明，或源码已无引用 |
| BUILD-012 | 是 | 安装副作用检查 | `npm.cmd ci` 前后 `.env*` 清单/hash 不变，不生成 secret |
| BUILD-013 | 是 | 动态入口加载检查 | Web、worker、runner 的动态 import、alias 和 JSON resource 全部可解析 |

## 4. 独立启动

| ID | 强制 | 场景 | 通过条件 |
| --- | --- | --- | --- |
| START-001 | 是 | 只启动 `wolf-research` 所需 DB/Redis/market/web/worker | 不启动 `wolf-dashboard` 或源项目即可健康 |
| START-002 | 是 | Web health | Next 首页、eval 页面和 API health 可访问 |
| START-003 | 是 | Market health | 最小市场服务 health 和 registry 可访问 |
| START-004 | 是 | Worker health | durable 模式能注册 worker slot 并 heartbeat |
| START-005 | 是 | 缺少 required 配置 | 启动 preflight 失败并指出变量名，不进入半可用状态 |
| START-006 | 是 | Windows 本地启动 | unsandboxed preview 默认拒绝；显式开关启用后 health/API/UI 标记风险模式；生产 eval mutation 另需显式 loopback 开关 |
| START-007 | 是 | 嵌套仓库检查 | `wolf-research/.git` 不存在，不是 submodule |
| START-008 | 是 | 显式启动编排 | 不执行 Auth/quota bootstrap、ClickHouse init 或隐式 env 写入 |
| START-009 | 是 | 重复启动/退出 | singleton、heartbeat、upgrade listener 和 owned child process 不重复、不泄漏 |

建议 smoke：

```powershell
npm.cmd run dev
npm.cmd run worker:generation
npm.cmd run dev:market
```

实际脚本名以阶段三最终 `package.json` 为准，并记录到 README 和项目全景图。

## 5. 路由验收

| ID | 路由 | 场景 | 通过条件 |
| --- | --- | --- | --- |
| ROUTE-001 | `/` | 正常加载 | 原主要布局、输入、模型/能力选择、项目抽屉可用 |
| ROUTE-002 | `/` | loading | CLI/model/project 状态读取时无布局跳动，提交按钮状态正确 |
| ROUTE-003 | `/` | empty | 无历史项目时显示真实空状态 |
| ROUTE-004 | `/` | error | 项目列表或 settings 失败时显示可定位错误，不展示空成功 |
| ROUTE-005 | `/{project_id}/chat` | 正常加载 | 消息、进度、看板、文件视图可切换 |
| ROUTE-006 | `/{project_id}/chat` | 不存在项目 | 404 或明确 `PROJECT_NOT_FOUND` |
| ROUTE-007 | `/eval-platform` | 正常加载 | overview/cases/sets/queue/evaluator 视图可切换 |
| ROUTE-008 | `/eval-platform` | storage unavailable | 显示不可用状态，不能显示全空 dashboard |
| ROUTE-009 | `/eval-platform/runs/{runId}` | 正常 | 统计、case 结果、events、skills、artifacts 可查看 |
| ROUTE-010 | `/eval-platform/runs/{runId}` | 不存在/损坏 | 分别显示 404 和 artifact integrity 错误 |
| ROUTE-011 | 全部 | 非目标导航 | 页面不出现会跳到已移除 WolfBot/QuantPilot 平台的有效按钮 |
| ROUTE-012 | 全部 | responsive | 桌面和移动无不可解释重叠、横向溢出或截断 |

## 6. 研究主流程测试矩阵

| ID | 场景 | 前置/注入 | 预期 |
| --- | --- | --- | --- |
| RES-001 | 正常单标的研究 | 模型、市场、DB、preview 正常 | `/` 创建项目，跳 chat，生成并验证真实看板 |
| RES-002 | 多标的比较 | 两个以上可解析标的 | run plan 保持顺序，数据和页面不退化为单标的 |
| RES-003 | 财务/事件研究 | financials/announcements 可用 | 报告期、来源和缺失字段可见 |
| RES-004 | 回测 | 本地历史 bars 足够 | 参数、费用、样本、净值、回撤和限制可追溯 |
| RES-005 | 图片附件 | 合法图片 | 上传、hash、附件上下文和 image extraction 证据可追溯 |
| RES-006 | 不合法附件 | 非图片、过大、路径异常 | 400/413 typed error，不创建生成任务 |
| RES-007 | 需要澄清 | 同优先级歧义标的 | 停在 clarification，不取数、不启动 Agent |
| RES-008 | 可唯一解析中文名 | 名称唯一 | 不因缺代码追问，继续执行 |
| RES-009 | 保证收益请求 | 明确不允许意图 | query rewrite 返回 refused，不取数、不生成 |
| RES-010 | Query rewrite 无模型 | 缺凭据/服务不可用 | `MODEL_CREDENTIAL_MISSING` 或 `MODEL_UNAVAILABLE`，失败关闭 |
| RES-011 | Query rewrite timeout | Provider 延迟超过 deadline | `MODEL_TIMEOUT`，不进入 run plan/prefetch |
| RES-012 | 市场部分失败 | 一个非核心 endpoint 失败 | 继续但 data quality/issues 和页面限制明确 |
| RES-013 | 市场全部失败 | 所有目标取数失败 | 整体失败，不生成静态/mock 看板 |
| RES-014 | 模型生成失败 | Provider 5xx/stream invalid | 有界重试后 failed，错误可定位 |
| RES-015 | validation 首轮失败可修复 | 注入已知 failure | 在上限内定向修复，再验证 |
| RES-016 | validation 不可修复 | 持续失败 | 到达修复上限后 failed，不启动 accepted preview |
| RES-017 | preview 启动成功 | Windows local 开关明确启用 | readiness 通过后发布 preview ready，并返回 `sandboxMode=windows-unsandboxed` |
| RES-018 | preview timeout | dev server 不响应 | `PREVIEW_TIMEOUT`，终止所属进程并可重试 |
| RES-019 | 非沙箱开关未启用 | Windows local 默认配置 | `PREVIEW_UNSANDBOXED_NOT_ENABLED`，不执行生成代码 |
| RES-020 | 页面刷新恢复 | generation 正在运行 | 从 durable status/messages 恢复，不重复 act |
| RES-021 | 后续追问 | 已有 run plan | 无新标的的页面修改继承原 symbols/time range/template |
| RES-022 | 文件浏览 | accepted workspace | 只能列出项目根内允许文件 |
| RES-023 | 文件编辑 | source.write 权限 | expected hash 匹配才写入；冲突返回 409 |
| RES-024 | 工具审批 | 高风险 write tool | pending UI、approve/reject/edit、过期均正确 |
| RES-025 | 项目 provision | 注入 staging/skill/rename 故障 | DB/workspace 不留下不可解释半成品，可按状态重试 |
| RES-026 | stable skills | 创建新项目 | workspace 安装 12 个 stable skills，含 `platform-ui-product-design` |
| RES-027 | 首页创建网络重试 | 首次响应丢失 | 复用 Idempotency-Key，返回同一项目，不创建第二个 |
| RES-028 | 首页 act 网络重试 | 首次响应丢失 | 复用 requestId，不启动第二个 generation |
| RES-029 | Memory/Knowledge disabled | 首版生产配置 | 不发网络、不写回执、前端无反馈组件静态 import |

## 7. 幂等、并发、取消和重试

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| CON-001 | 重复项目创建 Idempotency-Key | 返回原操作冲突/结果，不创建第二项目 |
| CON-002 | 重复 chat `requestId` | 返回 `REQUEST_ID_ALREADY_EXISTS`，不执行第二次 |
| CON-003 | requestId 跨项目 | 409 mismatch，不泄露其他项目数据 |
| CON-004 | 两个 generation 同项目 | 只有一个持有有效 lease；另一个 busy |
| CON-005 | worker lease 丢失 | 旧 worker 后续写入被 fencing 拒绝 |
| CON-006 | queued cancel | 不被 worker 领取，terminal 状态一致 |
| CON-007 | running cancel | signal 传播到 Provider/tool/process，最终 cancelled |
| CON-008 | cancel 后迟到结果 | 不能覆盖 cancelled 或新 generation |
| CON-009 | retryable market/model error | 不超过配置次数和总 deadline，事件记录 attempt |
| CON-010 | non-retryable input/schema error | 0 自动重试 |
| CON-011 | worker 崩溃 | orphan grace 后可恢复或明确 failed |
| CON-012 | 应用重启 | queue/request/mission 状态仍可恢复 |

## 8. 实时通道

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| RT-001 | WebSocket 正常 | 通过 origin 和项目授权后收到 status/message |
| RT-002 | WebSocket 未认证 | upgrade 被 401/403 拒绝 |
| RT-003 | WebSocket 断开 | 客户端指数退避，不创建并行重复 socket |
| RT-004 | SSE fallback | WS 不可用后连接 `/stream` 并补拉遗漏消息 |
| RT-005 | WS/SSE 都失败 | polling 恢复消息和 generation status |
| RT-006 | 事件重复 | 客户端按 event/request/message identity 去重 |
| RT-007 | publish 失败 | durable 状态仍正确，UI 经 polling 恢复；系统记录 degraded |
| RT-008 | worker 与 Web 分进程 | worker 更新持久状态后，浏览器通过 polling 恢复，不依赖跨进程内存 publish |
| RT-009 | heartbeat | 空闲连接保持，断开后清理 controller/socket |
| RT-010 | HMR/重复 route 加载 | manager、heartbeat 和 upgrade listener 各只有一个有效实例 |

## 9. 研究 API 合同

| ID | 端点 | 检查 |
| --- | --- | --- |
| API-001 | `POST /api/projects` | camelCase schema、201、400、409、429、503 |
| API-002 | `GET /api/projects` | auth scope、真实空列表、DB unavailable |
| API-003 | `POST /api/assets/{id}/upload` | MIME/signature/size/path |
| API-004 | `GET /api/assets/{id}/{filename}` | auth、404、413、content type |
| API-005 | `POST /api/chat/{id}/act` | schema、request idempotency、queued receipt |
| API-006 | `GET /api/chat/{id}/messages` | offset 和 after cursor 不丢不重 |
| API-007 | `GET /api/chat/{id}/requests/active` | false 与 unavailable 明确区分 |
| API-008 | `POST /api/chat/{id}/pause` | request-specific 和 all-active |
| API-009 | `GET /generation/status` | terminal snapshot 与 DB/workspace 一致 |
| API-010 | `GET/POST /quant/validation` | Mission state conflict、repair、accepted |
| API-011 | `POST /preview/start` | accepted gate、sandbox、single-flight |
| API-012 | `POST /preview/stop` | 幂等停止和 owner 校验 |
| API-013 | repo tree/file | traversal、symlink、size、hash conflict |
| API-014 | approvals | list、decision、actor、expiry、idempotency |
| API-015 | settings facade | 只返回目标模型/CLI 配置，不引用已移除模块 |

所有 contract test 检查：

- HTTP status。
- stable error code。
- `correlationId`。
- `retryable`。
- 响应不含 stack、secret、Cookie、connection string 或完整内部路径。

## 10. 市场数据测试矩阵

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| MKT-001 | symbols resolve 唯一 | canonical code、market、asset type |
| MKT-002 | symbols resolve 无结果 | `SYMBOL_NOT_FOUND` |
| MKT-003 | symbols resolve 歧义 | `SYMBOL_AMBIGUOUS` 和受限候选 |
| MKT-004 | realtime | source/asOf/fetchedAt/dataQuality 存在 |
| MKT-005 | batch realtime | 输入上限、部分失败 issues |
| MKT-006 | local-first history | 本地覆盖足够时不调用外部历史 |
| MKT-007 | history fallback | 记录实际 provider 和 fallback 原因 |
| MKT-008 | timeout | `MARKET_TIMEOUT`，可重试次数受限 |
| MKT-009 | 429 | `MARKET_RATE_LIMITED`，尊重 Retry-After |
| MKT-010 | invalid JSON/schema | `MARKET_INVALID_RESPONSE`，不缓存 |
| MKT-011 | stale data | data quality 标记，不冒充最新 |
| MKT-012 | screener 无 ClickHouse | 使用 TimescaleDB 返回合同兼容结果，`data_basis` 不冒充 ClickHouse |
| MKT-013 | Redis 不可用 optional | 响应标记 cache degraded，源数据仍真实 |
| MKT-014 | Redis required | 请求/启动明确失败 |
| MKT-015 | admin token | 研究只读端点不向浏览器暴露 token |

## 11. 模型测试矩阵

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| LLM-001 | 本地 OpenAI-compatible 正常 | stream、tool call、usage 正确 |
| LLM-002 | DeepSeek 正常 | hardened SSE parser 和 usage 正确 |
| LLM-003 | 凭据缺失 | 启动或请求返回变量名，不回显值 |
| LLM-004 | 401/403 | `MODEL_AUTH_FAILED`，不重试 |
| LLM-005 | 429/5xx | 有界重试，provider_retry 事件可见 |
| LLM-006 | timeout | 取消 stream 和 tool execution |
| LLM-007 | 超大 SSE frame | `MODEL_STREAM_LIMIT_EXCEEDED` |
| LLM-008 | invalid tool call | 不执行工具，记录失败 |
| LLM-009 | output token limit | 不宣称任务完成 |
| LLM-010 | deterministic provider in production | 启动或调用被拒绝 |
| LLM-011 | query rewrite/model mismatch | 两阶段使用同一选定模型 profile |

## 12. Preview 和进程测试矩阵

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| PROC-001 | allowlisted spawn | 参数数组、cwd、env 白名单正确 |
| PROC-002 | arbitrary command | 被拒绝 |
| PROC-003 | cwd 逃逸 | 被拒绝 |
| PROC-004 | package install | ignore scripts、timeout、日志限额 |
| PROC-005 | package manager 缺失 | 明确 adapter decision；不静默成功 |
| PROC-006 | port 冲突 | 分配新端口或 `PORT_EXHAUSTED` |
| PROC-007 | process close nonzero | preview/eval 标记 failed |
| PROC-008 | termination | grace 后强制终止，仅作用所属进程 |
| PROC-009 | PID 重用 | spawn token 不匹配时拒绝终止 |
| PROC-010 | Windows local execution gate | 默认拒绝；仅严格值 `1` 放行，且状态和日志标记 `windows-unsandboxed` |
| PROC-011 | market bridge | 只允许 GET/HEAD `/api/v1/**` |
| PROC-012 | bridge external URL | host/path/method 拒绝 |
| PROC-013 | required visual validation 缺 Chromium | 明确失败，不能以 warning/skip 通过研究或 E2E eval |

## 13. 评测中心测试矩阵

### 13.1 Dashboard 和管理

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| EVAL-001 | 无历史 run | cases/sets 存在，runs/queue 真实空状态 |
| EVAL-002 | DB unavailable | dashboard 503 或明确 unavailable |
| EVAL-003 | cases 文件缺失/损坏 | typed error，不显示 0 cases |
| EVAL-004 | create case 正常 | 写入 PostgreSQL 自定义 catalog 并立即可见，不修改 seed JSON |
| EVAL-005 | duplicate/invalid case | 400，原数据不变 |
| EVAL-006 | production-supported case 无 oracle | 400 |
| EVAL-007 | create eval set | 只接受存在的 case id |
| EVAL-007A | seed/custom 合并 | ID 唯一、顺序稳定，seed 损坏与 DB unavailable 分别显式失败 |
| EVAL-008 | simulate flow | 不创建 queue/run/report |
| EVAL-009 | active queue polling | 每 3 秒刷新，完成后停止 |
| EVAL-010 | schedule action | 首版返回 `EVAL_SCHEDULE_NOT_CONFIGURED`；自动调度未获确认前不显示 enabled |
| EVAL-011 | 并发同 mode benchmark | 每个 queue item 只关联预分配 reportId，不按 mtime 猜测 |
| EVAL-012 | queue/report identity mismatch | 返回 `EVAL_REPORT_ASSOCIATION_MISMATCH`，queue 不标完成 |

### 13.2 Contract benchmark

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| EVAL-C-001 | 全量 contract | runner exit 0，报告 attestation 通过 |
| EVAL-C-002 | 单 case/limit | selection metadata 准确 |
| EVAL-C-003 | concurrency/repeat 上限 | 输入被规范化或拒绝 |
| EVAL-C-004 | fixture 缺失 | case failed，runner 非假成功 |
| EVAL-C-005 | snapshot hash mismatch | integrity failure |
| EVAL-C-006 | mutation catalog | kill rate 达门槛 |
| EVAL-C-007 | judge calibration | contract 校准通过 |
| EVAL-C-008 | skill lock mismatch | runner 启动失败关闭 |
| EVAL-C-009 | report write failure | queue failed/partial failure，不标 passed |
| EVAL-C-010 | runner runtime dependency | `jiti`/alias/chat route 动态加载在干净安装可用 |

### 13.3 E2E benchmark

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| EVAL-E-001 | 正常 E2E | 真实 Agent、market、validation、preview 全链 |
| EVAL-E-002 | model unavailable | E2E failed，不降级 contract |
| EVAL-E-003 | market unavailable | E2E failed 或真实 partial policy |
| EVAL-E-004 | agent execution attestation | AgentRun/tool/evidence/usage 均匹配 |
| EVAL-E-005 | repair loop | 次数和结果真实记录 |
| EVAL-E-006 | visual check | screenshot 非空、首屏实际内容可见 |
| EVAL-E-007 | temp project cleanup | 只删除本 run 项目；keepProjects 正确 |
| EVAL-E-008 | cancel running | supervisor 终止并最终 cancelled |
| EVAL-E-009 | orphan process | 标记 orphaned，不伪造 cancelled |
| EVAL-E-010 | run detail | E2E metadata 和 artifact 链完整 |
| EVAL-E-011 | queue/report trace | report metadata 的 queueId/reportId/worker identity 与 DB 一致 |
| EVAL-E-012 | required visual dependency | Playwright/Chromium 缺失或截图空白时 E2E failed |

## 14. 鉴权和安全

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| SEC-001 | auth disabled | 仅显式模式生效，显示 local-system 身份，不写 session |
| SEC-002 | 首版无登录链 | 不存在登录路由、Better Auth session/Cookie 或用户表依赖 |
| SEC-003 | quota disabled | 项目创建、研究和评测不 reserve/settle quota，诊断公开 disabled |
| SEC-004 | local-system action | project context 缺失仍返回稳定错误，不能绕过输入校验 |
| SEC-005 | 未来 Auth 扩展边界 | 业务服务通过 Authorization facade，不直接绑定 Better Auth |
| SEC-006 | same-origin mutation | 非受信 Origin 的 eval/其他 mutation 被 403 |
| SEC-007 | production loopback mutation | 未设置显式开关时本机请求被 403；开关为 `1` 时仅同源 loopback 放行 |
| SEC-008 | admin token precedence | 配置 token 后无 token 的 loopback 请求为 401，正确 token 才放行 |
| SEC-009 | WebSocket origin | 缺失或非法 Origin 被拒绝 |
| SEC-010 | path traversal | `..`、encoded separator、反斜杠、junction/symlink 逃逸被拒绝 |
| SEC-011 | secret handling | 响应、日志、workspace、report 不含 secret |
| SEC-012 | source maps/build trace | `.env`、data、tmp、keys 不进入构建产物 |
| SEC-013 | upload | 类型、大小、文件名、内容签名验证 |
| SEC-014 | generated code | 未通过 artifact policy 不执行 |
| SEC-015 | tool approval | external/workspace write 受审批和 schema 约束 |
| SEC-016 | private eval data | 未跟踪、外部挂载、prompt redacted |
| SEC-017 | dependency audit | 高危漏洞按发布策略处理并记录 |
| SEC-018 | Auth 静态闭包 | layout/context/PageHeader/proxy 不引用 Better Auth、AuthUserMenu 或 auth audit |
| SEC-019 | Prisma singleton contract | 只包含目标研究/eval schema 版本，不要求 auth/quota/knowledge 表 |
| SEC-020 | Quota 静态闭包 | projects route、project service、request claim 不引用 `src/lib/quota/**` |

## 15. 视觉与交互对比

在相同 seed、相同 viewport、相同 mock/contract 数据下，对源和目标截图：

| ID | 页面/状态 | Viewport |
| --- | --- | --- |
| VIS-001 | `/` 默认 | 1440x900、390x844 |
| VIS-002 | `/` 提交 loading/error | 1440x900、390x844 |
| VIS-003 | chat generation waiting | 1440x900、390x844 |
| VIS-004 | chat preview ready | 1440x900、390x844 |
| VIS-005 | chat validation failed | 1440x900、390x844 |
| VIS-006 | `/eval-platform` overview | 1440x900、390x844 |
| VIS-007 | eval cases/queue | 1440x900、390x844 |
| VIS-008 | eval run detail | 1440x900、390x844 |

通过条件：

- 核心控件、状态和主要信息层级一致。
- 品牌调整外没有无理由的大范围视觉偏差。
- 没有重叠、横向溢出、空白 canvas、不可点按钮或 404 导航。
- preview iframe 实际加载生成页面，不是连接错误缓存页。

当前执行结果（2026-09-05）：研究工作台和评测中心的桌面/移动加载、主要视图、交互切换、
生成看板 preview 以及评测 run detail 已通过 Playwright smoke；源项目没有被启动或作为目标
运行时依赖。完整 live-model 视觉检查由 E2E runner 的 required visual validation 执行，截图
为空或 Chromium 缺失会使该 runner 失败。

## 16. 独立性和非法引用检查

强制扫描：

```powershell
rg -n "D:\\QuantPilot|D:/QuantPilot" wolf-research
rg -n "wolf-dashboard" wolf-research
rg -n "\.\.[/\\]wolf-dashboard|\.\.[/\\]\.\.[/\\]QuantPilot" wolf-research
```

判定：

- 生产代码、配置、package、script 和环境示例必须零运行时引用。
- 调查文档可以记录来源路径，但不得被程序读取为运行配置。
- 目标依赖树不能包含 `file:` 指向兄弟目录或源项目。
- lockfile 不能通过 transitive package 偶然提供 runner 的直接 runtime 依赖。
- 启动进程清单不能包含源项目或 `wolf-dashboard`。
- 目标静态资源必须位于目标目录。

## 17. 敏感信息和生成物检查

至少扫描：

- `BEGIN * PRIVATE KEY`
- `api[_-]?key`
- `secret`
- `token`
- `cookie`
- `authorization: bearer`
- PostgreSQL/Redis/HTTP URL 中的内嵌凭据
- 高熵长字符串

人工审阅：

- `.env.example` 仅安全占位符。
- `WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE` 默认值为 `0`，风险和适用范围明确。
- benchmark 数据公开且脱敏。
- 无数据库、日志、用户图片、真实工作区、report output、screenshots 被误提交。
- 无 `node_modules`、`.next`、venv、cache、tmp。

## 18. 文档和仓库验收

| ID | 标准 | 通过条件 |
| --- | --- | --- |
| DOC-F-001 | `wolf-research/README.md` | 安装、启动、worker、market、DB、eval 命令真实 |
| DOC-F-002 | `.env.example` | required/optional/default/unsafe 说明完整 |
| DOC-F-003 | 架构说明 | 两条调用链、ports、data flow 和失败语义与代码一致 |
| DOC-F-004 | 根 `docs/PROJECT_MAP.md` | 新模块、入口、数据流、依赖、配置、测试命令已同步 |
| DOC-F-005 | 变更记录 | 只有获得 commit 授权时才更新 `COMMIT_LOG.md`/`CHANGELOG.md` 并提交 |
| DOC-F-006 | 文档链接 | 全部相对链接存在 |
| DOC-F-007 | Git 状态 | 待提交文件只包含授权范围，无 nested repo |

## 19. 最终完成门槛

只有同时满足以下条件才可声明完成：

1. `wolf-research` 可独立安装和启动。
2. `/` 到 `/{project_id}/chat` 的核心研究流程通过。
3. `/eval-platform` contract 和 E2E 核心流程通过。
4. 正常、加载、空、错误、超时、取消和重试场景有真实结果。
5. WebSocket/SSE/轮询或等价实时恢复通过。
6. 所有强制构建、lint、类型检查、单元、集成、合同和 E2E 检查通过。
7. 生产运行时不存在对源项目或 `wolf-dashboard` 的依赖。
8. 不存在敏感信息、用户数据、日志、数据库或构建缓存误提交。
9. 根项目全景图和目标 README 与实际代码一致。
10. `VALIDATION_REPORT.md` 记录每条执行命令、退出结果、偏差、剩余风险和行为差异。
11. Windows 本地 preview 只有显式开关启用后可运行，且不能被描述为 Linux sandbox 或安全隔离。
12. Eval queue 与 report 使用 queueId/reportId 强关联，required visual validation 不允许跳过即通过。

当前执行结论（2026-09-06）：研究工作台、HTTP/WS smoke、类型、lint、unit、build 和市场服务
检查有真实通过证据；但 contract 直接入口、Eval queue 重启恢复、构建 trace 安全和若干错误
语义仍存在阻断或高风险。因此按本矩阵规则，当前状态为“重构实现已落地，验收未完成”。

环境不足或测试失败时，最终状态必须是“未完成”，并列出阻塞影响。
