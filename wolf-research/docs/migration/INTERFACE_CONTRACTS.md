# wolf-dashboard 重构接口契约

调查日期：2026-09-04

## 1. 设计目标

本文件定义阶段三必须实现或保持的 Port、Adapter、Facade 和 HTTP 契约。目标是：

1. 保持既有研究产品的 UI、交互和主要接口语义；QuantPilot 仅作为历史行为参考。
2. 把数据库、鉴权、AI、文件系统、队列、进程和第三方服务隔离在适配器后。
3. 外部能力不可用时返回可定位错误，不返回空成功。
4. Mock 只在 `development` 或 `test` 环境通过明确开关启用。
5. 所有长任务支持 deadline、取消、幂等键和关联 ID。

状态标记：

- **已确认**：源实现已有该行为或合同。
- **方案**：目标建议合同。
- **待验证**：需要部署或产品决策。

实施复核（2026-09-05）：目标已实现并验证研究、评测、市场、模型、数据库、工作区、队列、
实时通道和 Windows 本地 preview 的主要合同；历史 contract benchmark 为 16/16，DeepSeek
官方 live-model E2E 为 4/4。独立复核仍需补齐直接 contract fixture 编排、Eval queue 重启恢复
和构建安全边界。外部服务失败仍按本文件返回结构化错误；唯一明确非核心未决合同是 Eval
schedule 自动调度，继续返回 `EVAL_SCHEDULE_NOT_CONFIGURED`。

## 2. 通用调用上下文

所有 Port 操作接受等价的上下文：

```ts
interface OperationContext {
  correlationId: string;
  actorId: string | null;
  projectId?: string;
  requestId?: string;
  idempotencyKey?: string;
  deadlineAt?: string;
  signal?: AbortSignal;
}
```

约束：

- `correlationId` 必填，并回写到 HTTP 响应和结构化日志。
- 用户触发的生成使用 `requestId`；重复 `requestId` 返回冲突或原操作状态，不能创建第二次执行。
- 写操作需要 `idempotencyKey` 或具有等价唯一键。
- `deadlineAt` 与 `signal` 同时存在时，任一触发都应取消下游。
- Adapter 不得记录凭据、Cookie、完整 Prompt、上传图片内容或敏感 Provider 响应。

## 3. 通用错误模型

```ts
interface ServiceErrorPayload {
  code: string;
  message: string;
  service: string;
  operation: string;
  correlationId: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}
```

错误类别：

| 类别 | 示例 code | HTTP | 重试 |
| --- | --- | --- | --- |
| 输入错误 | `INVALID_REQUEST`、`INVALID_PATH` | 400 | 否 |
| 未认证 | `AUTHENTICATION_REQUIRED` | 401 | 否 |
| 未授权 | `CAPABILITY_DENIED` | 403 | 否 |
| 不存在 | `PROJECT_NOT_FOUND`、`RUN_NOT_FOUND` | 404 | 否 |
| 冲突/幂等 | `REQUEST_ID_ALREADY_EXISTS`、`LEASE_CONFLICT` | 409 | 读取状态后决定 |
| 配额 | `QUOTA_EXCEEDED` | 429 | 按窗口 |
| 外部限流 | `PROVIDER_RATE_LIMITED` | 429/503 | 按 `Retry-After` |
| 超时 | `MODEL_TIMEOUT`、`MARKET_TIMEOUT`、`PREVIEW_TIMEOUT` | 504 | 仅幂等操作 |
| 外部不可用 | `MODEL_UNAVAILABLE`、`MARKET_UNAVAILABLE` | 503 | 有界重试 |
| 数据合同错误 | `INVALID_PROVIDER_RESPONSE`、`EVAL_REPORT_INVALID` | 502/422 | 通常否 |
| 存储错误 | `DATABASE_UNAVAILABLE`、`WORKSPACE_IO_ERROR` | 503/500 | 依操作 |
| 取消 | `OPERATION_CANCELLED` | 409/499 等价语义 | 否 |
| 内部错误 | `INTERNAL_ERROR` | 500 | 否，需人工检查 |

约束：

- Adapter 保留原始 cause 给日志，但 HTTP 只返回脱敏 payload。
- `retryable=true` 不表示自动无限重试；重试次数和总 deadline 由调用方控制。
- 文件或数据库读取失败不能转换成空数组、`null` 或“无记录”，除非合同明确区分
  `not_found` 与 `unavailable`。

## 4. HTTP 响应 Facade

兼容期保持源接口的 `{ success, data, error, message }` 外形，同时增加 `correlationId` 和稳定 code：

```json
{
  "success": false,
  "error": "MARKET_UNAVAILABLE",
  "message": "市场数据服务当前不可用。",
  "correlationId": "req_...",
  "retryable": true
}
```

成功：

```json
{
  "success": true,
  "data": {},
  "correlationId": "req_..."
}
```

源接口中已经直接返回业务对象的端点，例如 active request summary，可以在兼容 facade 中保持外形，
但错误响应仍必须使用稳定 code。

## 5. AuthPort 与 AuthorizationPort

### 5.1 AuthPort

```ts
interface AuthPort {
  getSession(headers: Headers, ctx: OperationContext): Promise<AuthSession | null>;
  signOut(sessionId: string, ctx: OperationContext): Promise<void>;
}
```

| 项 | 契约 |
| --- | --- |
| 请求 | HTTP headers 和调用上下文 |
| 响应 | `AuthSession`，包括 actor id、role、ban 和 password-change 状态；未登录为 `null` |
| 错误 | `AUTH_PROVIDER_UNAVAILABLE`、`INVALID_SESSION` |
| 超时 | 本地 DB session 查询 2 秒建议值 |
| 重试 | 请求内不自动重试；只允许连接池级瞬时重试 |
| 认证 | 首版不读取 Cookie；未来 Better Auth adapter 才可解释 Cookie |
| 环境 | 首版只启用 `disabled` adapter，返回正式 local-system actor；Better Auth adapter 暂不迁移 |
| 状态 | 用户已确认首版不需要认证和 quota，目标保留接口封口 |

`disabled` 模式不是 Mock。它必须：

- 仅在 `WOLF_RESEARCH_AUTH_MODE=disabled` 时启用。
- 生成固定、不可冒充外部用户的 local system actor。
- 在响应或诊断中公开 `authMode=disabled`。
- 不写用户 session、Cookie 或伪造登录成功。
- 不执行 quota reserve/settle；诊断中公开 `quotaMode=disabled`。
- `AuthContext`、layout、`PageHeader` 和 proxy 不得静态导入 Better Auth client/server、
  `AuthUserMenu`、auth audit 或用户管理模块。
- projects route、project service 和 request claim 不得静态导入 quota service、allocation
  reconciliation 或 structural capacity。

### 5.2 AuthorizationPort

```ts
interface AuthorizationPort {
  requireAction(
    input: { action: PermissionAction; projectId?: string },
    ctx: OperationContext
  ): Promise<AuthorizedActor>;
}
```

保持源 `requireAction` 语义：

- 项目 action 缺 `projectId` 返回 `PROJECT_CONTEXT_REQUIRED`。
- 未登录返回 `AUTHENTICATION_REQUIRED`。
- 禁用账号返回 `ACCOUNT_DISABLED`。
- 必须改密码返回 `PASSWORD_CHANGE_REQUIRED`。
- 项目不存在或无成员关系返回 `PROJECT_NOT_FOUND`，避免泄露项目存在性。
- admin 仍需项目上下文，但可跳过成员查询。

## 6. 数据库与 Repository Ports

### 6.1 TransactionPort

```ts
interface TransactionPort {
  run<T>(
    operation: (repositories: TransactionRepositories) => Promise<T>,
    ctx: OperationContext
  ): Promise<T>;
}
```

| 项 | 契约 |
| --- | --- |
| 隔离 | 关键 claim/lease/approval 使用与源语义等价的原子事务 |
| 错误 | `DATABASE_UNAVAILABLE`、`TRANSACTION_CONFLICT`、`CONSTRAINT_VIOLATION` |
| 超时 | 普通事务 5 秒；lease/claim 由专用配置控制 |
| 重试 | 仅 serialization/deadlock，最多 2 次，带抖动，且写操作必须幂等 |
| 认证 | 只从服务端连接串读取，不下发浏览器 |

### 6.2 ProjectRepository

```ts
interface ProjectRepository {
  create(input: CreateProjectRecord, ctx: OperationContext): Promise<ProjectRecord>;
  getById(projectId: string, ctx: OperationContext): Promise<ProjectRecord | null>;
  list(access: ProjectAccessFilter, ctx: OperationContext): Promise<ProjectRecord[]>;
  update(projectId: string, patch: ProjectPatch, ctx: OperationContext): Promise<ProjectRecord>;
  delete(projectId: string, ctx: OperationContext): Promise<void>;
  updateActivity(projectId: string, at: string, ctx: OperationContext): Promise<void>;
  setPreview(projectId: string, preview: PreviewRecord | null, ctx: OperationContext): Promise<void>;
}
```

关键行为：

- `create` 与工作区 provision 需要补偿事务：数据库记录和目录不能留下不可解释的半成品。
- 已存在 managed workspace 返回 `WORKSPACE_ALREADY_EXISTS`，不得覆盖。
- 删除前验证目标路径属于配置工作区根；数据库删除与目录删除分别记录结果。
- `getById=null` 只表示确认不存在，数据库错误必须抛出。

### 6.3 ResearchRunRepository

覆盖 `UserRequest`、Agent run、Mission、事件、checkpoint、tool execution、evidence 和 lease：

```ts
interface ResearchRunRepository {
  claimRequest(input: ClaimRequest, ctx: OperationContext): Promise<ClaimResult>;
  getRequest(projectId: string, requestId: string, ctx: OperationContext): Promise<RequestRecord | null>;
  transitionRequest(input: RequestTransition, ctx: OperationContext): Promise<RequestRecord>;
  createMission(input: MissionCreate, ctx: OperationContext): Promise<MissionRecord>;
  appendMissionEvent(input: MissionEventAppend, ctx: OperationContext): Promise<MissionEventRecord>;
  claimGenerationLease(input: LeaseClaim, ctx: OperationContext): Promise<LeaseToken>;
  heartbeatGenerationLease(token: LeaseToken, ctx: OperationContext): Promise<void>;
  releaseGenerationLease(token: LeaseToken, outcome: LeaseOutcome, ctx: OperationContext): Promise<void>;
  recordToolExecution(input: ToolExecutionRecord, ctx: OperationContext): Promise<void>;
  recordEvidence(input: EvidenceReceipt, ctx: OperationContext): Promise<void>;
}
```

关键错误：

- `REQUEST_ID_ALREADY_EXISTS`
- `REQUEST_PROJECT_MISMATCH`
- `REQUEST_ACTOR_MISMATCH`
- `INVALID_REQUEST_TRANSITION`
- `MISSION_STATE_CONFLICT`
- `GENERATION_LEASE_BUSY`
- `LEASE_LOST`
- `FENCING_TOKEN_STALE`

重试 lease 操作时必须保留 fencing token；旧 worker 不能提交新 generation 的结果。

### 6.4 EvalRepository

```ts
interface EvalRepository {
  createQueueItem(input: EvalQueueCreate, ctx: OperationContext): Promise<EvalQueueItem>;
  claimNextQueueItem(workerId: string, ctx: OperationContext): Promise<EvalQueueItem | null>;
  updateQueueItem(id: string, patch: EvalQueuePatch, ctx: OperationContext): Promise<EvalQueueItem>;
  attachReport(input: EvalReportAttachment, ctx: OperationContext): Promise<EvalQueueItem>;
  saveRun(run: QuantEvalRun, ctx: OperationContext): Promise<void>;
  getRun(id: string, ctx: OperationContext): Promise<QuantEvalRun | null>;
  listRuns(limit: number, ctx: OperationContext): Promise<QuantEvalRun[]>;
  saveRepairTickets(items: QuantEvalRepairTicket[], ctx: OperationContext): Promise<void>;
  listRepairTickets(ctx: OperationContext): Promise<QuantEvalRepairTicket[]>;
}
```

目标合同：

- PostgreSQL 是 queue、repair ticket 和 run metadata 的权威存储。
- 报告 JSON 和日志可以保留在文件存储，但 DB 必须记录 URI、hash、size 和状态。
- enqueue 时预分配 `queueId` 和 `reportId`；runner 参数和报告 metadata 必须包含两者。
- `attachReport` 原子验证 queue ownership、report ID、mode、artifact hash 和 terminal transition，
  禁止使用文件 mtime 或 mode 猜测报告归属。
- 文件写成功、DB 写失败时返回 `EVAL_PERSISTENCE_PARTIAL_FAILURE`，并写入可恢复 outbox；
  不能返回成功。
- DB 不可用时 dashboard 返回 `EVAL_STORAGE_UNAVAILABLE`，不能显示空队列。

### 6.5 EvalCatalogRepository

```ts
interface EvalCatalogRepository {
  listCases(ctx: OperationContext): Promise<QuantEvalCase[]>;
  createCase(input: CreateQuantEvalCaseInput, ctx: OperationContext): Promise<QuantEvalCase>;
  listEvalSets(ctx: OperationContext): Promise<QuantEvalSetDefinition[]>;
  createEvalSet(input: CreateQuantEvalSetInput, ctx: OperationContext): Promise<QuantEvalSetDefinition>;
}
```

规则：

- `benchmarks/quantpilot/*.json` 是只读、版本化 seed；运行时不得改写。
- 自定义 case/eval set 写 PostgreSQL，并与 seed 合并读取；ID 在两种来源间唯一。
- seed 文件缺失、损坏或 hash 不匹配返回 `EVAL_SEED_CATALOG_INVALID`，不能显示 0 cases。
- DB 写入使用 idempotency key；重复 ID/请求 hash 不一致返回 409。
- 测试覆盖 seed-only、custom-only、合并、重复 ID、无效 case 引用和 DB unavailable。

## 7. WorkspaceStoragePort

```ts
interface WorkspaceStoragePort {
  provision(projectId: string, template: WorkspaceTemplate, ctx: OperationContext): Promise<WorkspaceRef>;
  resolveProjectRoot(projectId: string, ctx: OperationContext): Promise<WorkspaceRef>;
  readText(ref: WorkspaceFileRef, ctx: OperationContext): Promise<VersionedText>;
  writeText(ref: WorkspaceFileRef, value: string, expectedSha256: string | null, ctx: OperationContext): Promise<VersionedText>;
  readJson<T>(ref: WorkspaceFileRef, schema: Schema<T>, ctx: OperationContext): Promise<T>;
  writeJson<T>(ref: WorkspaceFileRef, value: T, schema: Schema<T>, ctx: OperationContext): Promise<VersionedFile>;
  list(ref: WorkspaceDirectoryRef, limits: ListLimits, ctx: OperationContext): Promise<WorkspaceEntry[]>;
  removeProject(projectId: string, ctx: OperationContext): Promise<void>;
}
```

路径规则：

- 所有业务调用使用 `{ projectId, relativePath }`，不接受任意绝对路径。
- `relativePath` 使用 `/`，拒绝 `..`、反斜杠、NUL、控制字符、符号链接逃逸。
- 解析后的 real path 必须位于配置的 target workspace root。
- `.data-agent` 的平台拥有文件对 Agent 只读。
- 写操作采用临时文件、fsync/rename 等价原子替换，并返回 SHA-256。
- 并发写入使用 expected hash 或 workspace resource lock。

错误：

- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_PATH_DENIED`
- `WORKSPACE_CONFLICT`
- `WORKSPACE_SCHEMA_INVALID`
- `WORKSPACE_IO_ERROR`
- `WORKSPACE_LIMIT_EXCEEDED`

超时建议：

- 小文件读写 5 秒。
- 目录枚举 5 秒，必须有 `maxDepth`、`maxEntries`。
- 项目删除/清理 30 秒，且必须验证根路径。

## 8. AssetStoragePort

```ts
interface AssetStoragePort {
  putImage(input: ImageUpload, ctx: OperationContext): Promise<StoredAsset>;
  getImage(projectId: string, filename: string, ctx: OperationContext): Promise<StoredAssetBody>;
  deleteProjectAssets(projectId: string, ctx: OperationContext): Promise<void>;
}
```

请求：

- 允许的 MIME 和文件签名双重校验。
- 单文件和总附件大小上限沿用源配置。
- 服务端生成文件名，不信任上传文件名作为路径。

响应：

- `assetId`、`filename`、`mimeType`、`size`、`sha256`、相对 URL。

错误：

- `ASSET_TYPE_DENIED`
- `ASSET_TOO_LARGE`
- `ASSET_NOT_FOUND`
- `ASSET_STORAGE_UNAVAILABLE`
- `ASSET_MALWARE_DETECTED`，若部署接入扫描器

重试：

- `putImage` 仅在 idempotency key 相同且 hash 相同时重试。
- 浏览器 GET 可重试；写入不做无界重试。

## 9. GenerationQueuePort

```ts
interface GenerationQueuePort {
  enqueue(job: GenerationJob, ctx: OperationContext): Promise<GenerationReceipt>;
  claim(worker: WorkerIdentity, ctx: OperationContext): Promise<ClaimedGeneration | null>;
  heartbeat(claim: ClaimedGeneration, ctx: OperationContext): Promise<void>;
  complete(claim: ClaimedGeneration, result: GenerationOutcome, ctx: OperationContext): Promise<void>;
  cancel(projectId: string, requestId: string, reason: string, ctx: OperationContext): Promise<CancelResult>;
  getStatus(projectId: string, requestId?: string, ctx?: OperationContext): Promise<GenerationStatus>;
}
```

Adapter：

| 环境 | Adapter | 约束 |
| --- | --- | --- |
| 开发 | `InlineGenerationQueueAdapter` | 单进程；仍写 request/mission 状态；明确标记非 durable |
| 测试 | `InMemoryGenerationQueueStub` | 仅 `NODE_ENV=test` 且显式开关 |
| 生产 | `PostgresGenerationQueueAdapter` | lease、heartbeat、outbox、fencing、worker slot |

超时和重试：

- enqueue 5 秒，数据库冲突按幂等键读取已有 receipt。
- worker polling 使用配置间隔。
- 失败重试只针对分类为 retryable 的错误，保留 attempt 和 nextAttemptAt。
- 总执行时间受 `PI_AGENT_TIMEOUT_MS` 和 mission deadline 双重限制。

取消：

- 队列中任务原子转为 cancelled。
- 运行中任务触发 `AbortSignal`，写 request/mission terminal event。
- 取消后到达的旧 worker 结果因 fencing token 被拒绝。

## 10. EvalQueuePort

```ts
interface EvalQueuePort {
  enqueue(input: EvalRunRequest, ctx: OperationContext): Promise<EvalQueueItem>;
  claim(workerId: string, ctx: OperationContext): Promise<EvalQueueItem | null>;
  attachProcess(id: string, process: ProcessIdentity, ctx: OperationContext): Promise<void>;
  finish(id: string, outcome: EvalProcessOutcome & { reportId: string }, ctx: OperationContext): Promise<EvalQueueItem>;
  cancel(id: string, ctx: OperationContext): Promise<EvalQueueItem>;
  list(limit: number, ctx: OperationContext): Promise<EvalQueueItem[]>;
}
```

关键修正：

- `runningChildren Map` 只可作为进程内句柄缓存。
- DB 状态和 worker ownership 是权威。
- `pid` 不能单独作为身份，至少绑定 worker instance、host id、spawn token 和 startedAt。
- runner 只能写 enqueue 时预分配的 `reportId`，并在报告内回写 `queueId`；身份不匹配时返回
  `EVAL_REPORT_ASSOCIATION_MISMATCH`。
- 取消先标记 cancelling，再请求 supervisor 终止，收到 exit 后写 cancelled。
- 找不到进程但 DB 仍 running 时返回 `EVAL_PROCESS_ORPHANED`，不能直接假定取消成功。

## 11. ModelProviderPort

```ts
interface ModelProviderPort {
  describe(modelId: string): ModelCapability;
  complete(request: ModelRequest, ctx: OperationContext): AsyncIterable<ModelEvent>;
  health(modelId: string, ctx: OperationContext): Promise<ProviderHealth>;
}
```

请求：

- `modelId`
- 规范化 messages
- tool schemas
- token/turn budgets
- reasoning 配置
- stream limits
- idempotency/request id

响应事件：

- `text_delta`
- `thinking_delta`
- `tool_call`
- `usage`
- `provider_retry`
- `completed`
- `failed`

错误：

- `MODEL_NOT_REGISTERED`
- `MODEL_CREDENTIAL_MISSING`
- `MODEL_AUTH_FAILED`
- `MODEL_RATE_LIMITED`
- `MODEL_TIMEOUT`
- `MODEL_NETWORK_ERROR`
- `MODEL_INVALID_RESPONSE`
- `MODEL_STREAM_LIMIT_EXCEEDED`
- `MODEL_OUTPUT_LIMIT`

超时与重试：

| 操作 | 超时 | 重试 |
| --- | --- | --- |
| Query rewrite | 默认使用源 `QUANTPILOT_QUERY_REWRITE_LLM_TIMEOUT_MS` 等价值 | 仅 network/408/409/425/429/5xx，最大次数配置 |
| Agent turn | 受 run deadline 剩余时间限制 | Provider adapter 有界重试，事件必须可见 |
| Health | 3 秒 | 不重试 |

认证和环境：

- 凭据只从 server environment 或 secret manager 读取。
- `credentialEnv` 只用于定位缺失配置，不能回显值。
- 本地 OpenAI-compatible endpoint 也必须经过 host allowlist，不能接受用户 URL。
- deterministic provider 仅 contract/test；生产研究请求禁止选择。

## 12. MarketDataPort

```ts
interface MarketDataPort {
  resolveSymbols(query: SymbolResolveRequest, ctx: OperationContext): Promise<SymbolResolveResponse>;
  getRealtimeQuote(symbol: string, ctx: OperationContext): Promise<RealtimeQuote>;
  getRealtimeQuotes(symbols: string[], ctx: OperationContext): Promise<BatchQuoteResponse>;
  getHistory(input: HistoryRequest, ctx: OperationContext): Promise<KlineResponse>;
  getTechnicalIndicators(input: IndicatorRequest, ctx: OperationContext): Promise<TechnicalIndicatorsResponse>;
  getFinancials(input: FinancialRequest, ctx: OperationContext): Promise<FinancialReportsResponse>;
  getFundamentalIndicators(input: FinancialRequest, ctx: OperationContext): Promise<FundamentalIndicatorsResponse>;
  getAnnouncements(input: EventRequest, ctx: OperationContext): Promise<AnnouncementResponse>;
  runMaCrossover(input: BacktestRequest, ctx: OperationContext): Promise<BacktestResponse>;
  screenShortTermCandidates(input: ScreenerRequest, ctx: OperationContext): Promise<AShareScreenerResponse>;
  getRegistry(ctx: OperationContext): Promise<DataRegistryResponse>;
  getCoverage(input: CoverageRequest, ctx: OperationContext): Promise<CoverageResponse>;
}
```

HTTP adapter 约束：

- base URL 由服务端配置，必须是 allowlist 中的内部 `http/https` host。
- 只允许固定 endpoint 和 GET/POST 方法，拒绝调用方提供完整 URL。
- redirect 为 `error`。
- 响应限制字节数，JSON schema 校验。
- 记录 provider、endpoint、asOf、fetchedAt、rowCount 和 dataQuality。

错误区分：

- `SYMBOL_NOT_FOUND`
- `SYMBOL_AMBIGUOUS`
- `SYMBOL_RESOLVER_UNAVAILABLE`
- `MARKET_RATE_LIMITED`
- `MARKET_TIMEOUT`
- `MARKET_UNAVAILABLE`
- `MARKET_INVALID_RESPONSE`
- `MARKET_DATA_STALE`
- `MARKET_PARTIAL_DATA`

超时与重试：

- 普通报价 5 至 10 秒。
- 历史和 screener 使用单独配置，保留源现有 timeout 变量的等价项。
- 网络、连接重置、429 和 5xx 最多 2 至 3 次指数退避。
- 4xx 输入错误和 schema 错误不重试。
- 部分端点失败时返回带 `issues[]` 的 partial result；所有核心标的失败时整体失败。

认证：

- 浏览器和生成项目不能持有市场 admin token。
- preview bridge 仅暴露无凭据只读 endpoint。
- 管理/ingestion endpoint 不进入研究 Agent 工具 allowlist。

ClickHouse 处置：

- 首版 `screenShortTermCandidates` 使用明确的 TimescaleDB repository，不加载 ClickHouse module。
- 响应保留 `data_basis`/analytics 字段，但不得宣称命中 ClickHouse。
- ClickHouse 配置不存在不是错误；如果目标代码仍引用 ClickHouse package、analytics route 或 sync
  repository，module-boundary 检查失败。
- 无 ClickHouse 集成测试覆盖正常筛选、空结果、数据库不可用、数据陈旧和字段合同。

## 13. PreviewRuntimePort

```ts
interface PreviewRuntimePort {
  start(input: PreviewStartRequest, ctx: OperationContext): Promise<PreviewInfo>;
  stop(projectId: string, ctx: OperationContext): Promise<PreviewStopResult>;
  status(projectId: string, ctx: OperationContext): Promise<PreviewStatus>;
  reconcile(projectId: string, ctx: OperationContext): Promise<PreviewStatus>;
}
```

开始条件：

1. 项目存在。
2. Mission candidate 已通过 validation 和 evidence acceptance。
3. generated artifact security policy 通过。
4. workspace 路径通过 realpath 校验。
5. Windows local adapter 已由 `WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE=1`
   明确启用；未启用时必须拒绝执行。

响应：

- `status`
- `url`
- `port`
- `runtimeId`
- `ownerInstanceId`
- `startedAt`
- `sandboxMode`

错误：

- `PREVIEW_NOT_ACCEPTED`
- `PREVIEW_SECURITY_POLICY_FAILED`
- `PREVIEW_SANDBOX_UNAVAILABLE`
- `PREVIEW_UNSANDBOXED_NOT_ENABLED`
- `PREVIEW_PORT_EXHAUSTED`
- `PREVIEW_INSTALL_FAILED`
- `PREVIEW_START_FAILED`
- `PREVIEW_TIMEOUT`
- `PREVIEW_CANCELLED`
- `PREVIEW_OWNERSHIP_CONFLICT`

超时和重试：

- install 和 startup 使用不同 deadline。
- readiness probe 可短间隔重试直到总 timeout。
- package manager 不可用时不得静默换工具；如果允许 fallback，必须在配置中列出顺序并记录
  `adapterDecision`。
- start 同一 project 使用 single-flight；重复请求返回同一 receipt。

环境：

- 首版使用 Windows local unsandboxed adapter，不迁移 Linux namespace runner。
- `WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE` 默认 `0`；只有值严格为 `1` 才执行。
- `PreviewInfo.sandboxMode` 固定返回 `windows-unsandboxed`，UI、API 和结构化日志必须可见。
- 只支持受信任的本地单机使用；对外或多用户 hardened deployment 不在首版验收范围。

## 14. ProcessSupervisorPort

```ts
interface ProcessSupervisorPort {
  spawn(spec: ProcessSpec, ctx: OperationContext): Promise<ManagedProcess>;
  terminate(identity: ProcessIdentity, graceMs: number, ctx: OperationContext): Promise<TerminationResult>;
  status(identity: ProcessIdentity, ctx: OperationContext): Promise<ProcessStatus>;
  streamLogs(identity: ProcessIdentity, sink: LogSink, ctx: OperationContext): Promise<void>;
}
```

`ProcessSpec` 必须包含：

- allowlist command id，而不是任意 shell 字符串。
- 参数数组。
- validated cwd。
- 白名单环境变量。
- timeout、stdout/stderr 限额。
- owner project/run/worker identity。
- sandbox policy。

禁止：

- `shell=true` 处理用户输入。
- 把源或目标根外的任意 cwd 交给进程。
- 只凭 PID 终止进程。
- 忽略非零退出码。

Benchmark、preview、依赖安装都通过此 Port。

## 15. RealtimePort

```ts
interface RealtimePort {
  publish(projectId: string, event: RealtimeEvent, ctx: OperationContext): Promise<void>;
  subscribe(projectId: string, subscriber: RealtimeSubscriber, ctx: OperationContext): Promise<Subscription>;
}
```

事件 envelope：

```ts
interface RealtimeEvent {
  eventId: string;
  projectId: string;
  requestId?: string;
  type: "message" | "status" | "error" | "heartbeat" | "preview_success" | "preview_error";
  occurredAt: string;
  data?: Record<string, unknown>;
  error?: string;
}
```

规则：

- 业务完成状态先持久化，再发布事件。
- publish 失败不能回滚已提交业务事务，但必须记录 outbox/degraded 状态供轮询恢复。
- 客户端按 `eventId` 去重。
- WS、SSE 和 polling 都消费同一持久状态语义。
- 首版 Windows 单机使用 Web 进程内 WS/SSE；generation worker 不承担浏览器连接。
- 跨进程或 publish 丢失由 durable messages/status polling 恢复，UI 不得永久 loading。
- 多 Web 实例不在首版验收范围；未来启用时必须增加 Redis pub/sub 或 durable event adapter。

初始化规则：

- `PreviewManager`、`StreamManager`、WebSocket manager、heartbeat timer 和 HTTP upgrade listener
  重复加载时只能存在一个有效实例。
- 正常退出、测试 teardown 和 HMR 替换必须清理 timer、subscriber、socket 和 owned child process。
- 初始化失败返回 typed startup/runtime error，不能留下部分注册成功的全局状态。

### 15.1 StartupCoordinator

```ts
interface StartupCoordinator {
  preflight(ctx: OperationContext): Promise<StartupReport>;
  migrateDatabase(ctx: OperationContext): Promise<StartupStepResult>;
  startManagedServices(ctx: OperationContext): Promise<StartupReport>;
  shutdown(ctx: OperationContext): Promise<ShutdownReport>;
}
```

规则：

- `npm install`/`npm ci` 不写 `.env`、`.env.local`，不生成 secret，不迁移数据库。
- 环境文件由用户显式创建；preflight 只读取并校验 required 变量名、URL、端口和 unsafe 开关。
- DB migration、market、Web、generation worker 分步骤执行并记录 owner/PID/health。
- 首版不执行 Auth/quota bootstrap、ClickHouse init 或 degradation 自动恢复。
- required 步骤失败时返回 `STARTUP_PREFLIGHT_FAILED`、`DATABASE_MIGRATION_FAILED` 或
  `MANAGED_SERVICE_START_FAILED`，停止后续步骤并清理本次已启动进程。
- 测试覆盖重复启动、部分启动失败、已有外部 market service、worker 崩溃和 shutdown。

## 16. MemoryPort 和 KnowledgePort

### 16.1 MemoryPort

```ts
interface MemoryPort {
  recall(input: MemoryRecallInput, ctx: OperationContext): Promise<MemoryRecallResult>;
  recordUse(input: MemoryUseInput, ctx: OperationContext): Promise<MemoryUseReceipt>;
  recordFeedback(input: MemoryFeedbackInput, ctx: OperationContext): Promise<MemoryFeedbackReceipt>;
}
```

### 16.2 KnowledgePort

```ts
interface KnowledgePort {
  retrieve(input: KnowledgeContextInput, ctx: OperationContext): Promise<KnowledgeContextResult>;
  recordUse(input: KnowledgeUsageInput, ctx: OperationContext): Promise<KnowledgeUseReceipt>;
  recordFeedback(input: KnowledgeFeedbackInput, ctx: OperationContext): Promise<KnowledgeFeedbackReceipt>;
}
```

共同规则：

- 正式 disabled adapter 返回 `{ enabled:false, reason:"disabled_by_configuration" }`，
  不伪造召回内容或写入成功。
- 首版固定使用 disabled adapter，不迁移 HTTP provider、凭据配置、反馈 UI 或回执表。
- 首版只允许 disabled 模式；配置为 required/optional HTTP provider 时 preflight 返回
  `MEMORY_ADAPTER_NOT_IMPLEMENTED` 或 `KNOWLEDGE_ADAPTER_NOT_IMPLEMENTED`，不得静默改成 disabled。
- 首版不发起 Memory/Knowledge 网络请求，因而不存在 HTTP 重试或认证 token。
- `ChatInput`、`ChatLogView` 不得静态导入未迁移的反馈组件。

## 17. ToolApprovalPort

```ts
interface ToolApprovalPort {
  request(input: ApprovalRequest, ctx: OperationContext): Promise<PendingApproval>;
  list(projectId: string, status: ApprovalStatus, limit: number, ctx: OperationContext): Promise<ApprovalSummary[]>;
  resolve(input: ApprovalDecision, ctx: OperationContext): Promise<ResolvedApproval>;
  wait(approvalId: string, ctx: OperationContext): Promise<ResolvedApproval>;
}
```

规则：

- approval 与 `runId`、`projectId`、tool、effect、public input hash、idempotency 绑定。
- 允许 decision 由合同限定为 approve/reject/edit。
- edit 后重新验证输入 schema 和 hash。
- 过期返回 `APPROVAL_EXPIRED`。
- 非原项目 actor 或无 `project.update` 权限返回 403。
- wait 受 deadline 和 cancel signal 控制。

## 18. Clock 和 IdGenerator

```ts
interface Clock {
  now(): Date;
}

interface IdGenerator {
  projectId(): string;
  requestId(): string;
  missionId(): string;
  runId(): string;
  eventId(): string;
}
```

用途：

- lease、重试和报告时间可确定性测试；未来 schedule 获批后复用同一 Clock。
- ID 格式、最大长度和唯一性集中约束。
- 测试 fixture 不依赖真实系统时间。

## 19. 研究 HTTP 契约

### 19.1 `POST /api/projects`

请求保持源 camelCase：

```json
{
  "projectId": "string",
  "name": "string",
  "initialPrompt": "string",
  "selectedModel": "string",
  "description": "string|null",
  "capabilityId": "string",
  "capabilitySelectionSource": "manual|default|inferred",
  "agentProfileId": "string"
}
```

关键状态：

- `201` 创建成功。
- `400 INVALID_PROJECT_REQUEST`。
- `409 PROJECT_CREATE_OPERATION_ALREADY_USED` 或 workspace 冲突。
- `503 DATABASE_UNAVAILABLE` / `WORKSPACE_IO_ERROR`。

源首页未发送 `Idempotency-Key`，且源 API 只在 Auth session 存在时把 header 用于 quota reservation。
目标首版应把项目创建幂等从 quota 解耦：客户端为一次创建尝试生成稳定 key，重试复用；服务端用
独立 operation repository 保存 request hash、project ID 和结果。disabled quota 模式不返回
`QUOTA_EXCEEDED`。

### 19.2 `POST /api/chat/{projectId}/act`

请求由 `chatActRequestSchema` 定义：

```json
{
  "instruction": "string",
  "displayInstruction": "string",
  "conversationId": "string",
  "requestId": "string",
  "selectedModel": "string",
  "images": [
    {
      "name": "string",
      "path": "assets/<filename>",
      "mimeType": "image/*"
    }
  ],
  "isInitialPrompt": false,
  "capabilityId": "string",
  "capabilitySelectionSource": "manual|default|inferred"
}
```

成功响应至少包含：

- `success`
- `message`
- `requestId`
- `missionId`
- `generationId`
- `queued`
- 当前项目/请求状态

目标首页必须显式发送 `requestId`，网络重试复用同一值；兼容其他客户端时服务端仍可生成，但响应
必须返回最终 request ID。

关键错误保持：

- `INVALID_JSON`
- `INVALID_ACT_REQUEST`
- `REQUEST_ID_ALREADY_EXISTS`
- project/actor mismatch
- `Project generation is busy` 的稳定 code
- query rewrite/model/market typed errors
- quota/auth errors

### 19.3 状态、消息、暂停和预览

| 端点 | 契约重点 |
| --- | --- |
| `GET /generation/status` | 返回 durable request/mission/generation/validation/preview snapshot |
| `GET /messages` | 支持 offset 和 after cursor；返回 total |
| `GET /requests/active` | 区分 `hasActiveRequests=false` 与 endpoint unavailable |
| `POST /pause` | 可指定 requestId；幂等取消；返回最终或 cancelling 状态 |
| `POST /preview/start` | 只启动已接受产物；返回 `sandboxMode` |
| `POST /preview/stop` | 幂等；区分未运行、已停止和停止失败 |
| `GET/POST /quant/validation` | 返回报告、Mission 验证状态、repair/preview 结果 |

## 20. 评测 HTTP 契约

### 20.1 `GET /api/evals`

响应 `QuantEvalDashboardData`：

- `cases`
- `evalSets`
- `runs`
- `queue`
- `repairTickets`
- `schedule`
- `runtimeOptions`
- `generatedAt`
- 新增 `storageHealth` 和 `runnerHealth`

任何核心存储读取失败返回 503，不能用空数组代替。

### 20.2 `POST /api/evals`

保持 action facade：

| action | 必要字段 | 响应 |
| --- | --- | --- |
| `start-benchmark` | mode、evaluator、case selection、concurrency、repeat | queue item |
| `simulate-flow` | 同上 | 不写入的 flow simulation |
| `create-case` | name、question、capability/type 等 | case |
| `create-eval-set` | name、caseIds | eval set |
| `cancel-benchmark` | queueId | queue item |
| `update-schedule` | enabled、interval、selection | `BLOCKED`；首版返回 `EVAL_SCHEDULE_NOT_CONFIGURED` |
| `check-schedule` | 无 | `BLOCKED`；首版返回 `EVAL_SCHEDULE_NOT_CONFIGURED` |

验证：

- `mode` 只允许 `contract|e2e`。
- concurrency 和 repeat 有硬上限。
- evaluator 必须声明支持 mode。
- case ID 必须存在。
- production-supported case 必须有 oracle 和 safety tags。
- mutation 请求要求 same-origin/privileged mutation 校验。
- 生产/strict 模式下，浏览器 mutation 只有在 `WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS=1`
  且请求目标和 `Host` 都是 loopback 时才允许；该开关默认 `0`，不能作为网络访问控制的替代。
- `WOLF_RESEARCH_ADMIN_TOKEN` 一旦配置，始终要求 server-only token，loopback 开关不能绕过它；
  浏览器 UI 不读取或发送该 token。
- `start-benchmark` 预分配 `queueId/reportId`，runner 和最终 report 必须回写并匹配。

### 20.3 `GET /api/evals/runs/{runId}`

- `404 RUN_NOT_FOUND` 只用于确认不存在。
- report 文件丢失但 DB 存在时返回 `EVAL_REPORT_ARTIFACT_MISSING`，并带 run metadata。
- report hash 不一致返回 `EVAL_REPORT_INTEGRITY_FAILED`。

## 21. 环境适配矩阵

| 能力 | Development | Test | Production |
| --- | --- | --- | --- |
| Auth | disabled | fake session dependency injection | 首版 disabled local-system |
| DB | 本地 PostgreSQL | 临时 PostgreSQL；纯单元可 fake repository | PostgreSQL required |
| Generation queue | inline 或 worker | in-memory stub 或 test DB | durable worker |
| Eval queue | DB + 本地 worker | in-memory stub/fixture | durable DB + supervisor worker |
| Model | 本地 Qwen/真实 provider | deterministic stub | 注册的真实 provider |
| Market | 本地 FastAPI | contract fixture | 内部 FastAPI + real providers |
| Preview | 显式 unsafe Windows local | fake process + Playwright fixture | 显式 unsafe Windows local |
| Memory/Knowledge | disabled | stub | disabled |
| Realtime | in-process + polling | in-memory + repository fixture | 单机 in-process + durable polling |
| Eval schedule | disabled/not configured | injected clock unit test | `BLOCKED`，不属于首版核心 |

首版 Windows 本地启动必须校验：

- required adapter 配置齐全。
- test/deterministic/mock adapter 未启用。
- 生产本机评测 UI 写操作默认拒绝；仅 `WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS=1` 显式启用，
  且 health/preflight 公开 `loopbackMutationsEnabled`；非 loopback 请求仍拒绝。
- 未设置 `WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE=1` 时 preview 明确拒绝。
- 开关启用后 health、API、UI 和日志公开 `windows-unsandboxed`。
- secret 长度和 URL allowlist 合法。
- DB schema、skill lock、benchmark resource hash 可用。
- `jiti`、`tsconfig-paths` 等 runner runtime 依赖必须直接声明。

### 21.1 外部依赖失败与测试矩阵

| 能力 | 失败策略 | 超时/重试 | 认证 | 首版环境 | 必测 |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL/TimescaleDB | required 时失败关闭，不返回空记录 | 事务 deadline；仅 deadlock/serialization 有界重试 | server connection string | 本地 DB required | unavailable、conflict、restart recovery |
| Filesystem | typed IO/partial failure；原子写 | 非幂等写不自动重试 | realpath root policy | Windows local | traversal、junction、disk error |
| Model | typed auth/rate/network/schema error | 总 deadline 内有界重试 | server secret、host allowlist | 至少一个真实 adapter | 401、429、5xx、timeout、invalid SSE |
| Market service/provider | partial issues 或整体失败，禁止空成功 | endpoint timeout、429/5xx 退避 | internal URL；admin token server-only | FastAPI + TimescaleDB | stale、partial、all-failed、fallback |
| BaoStock/AkShare | 默认关闭；显式启用失败返回 typed unavailable | provider adapter 有界重试 | Python extra + server config | optional | disabled no-load、missing extra、provider failure |
| Redis cache | optional 显示 degraded；required 明确失败 | 短连接 timeout | server URL | optional | disabled/unavailable/required |
| Child process | nonzero/timeout/orphan 为失败 | readiness deadline；仅探测重试 | command/cwd/env allowlist | Windows local | cancel、PID reuse、log limit |
| Playwright | required E2E 缺 Chromium 即失败 | viewport deadline | 无外部认证 | 目标 dev dependency | missing browser、blank screenshot |
| Memory/Knowledge | 只返回 disabled metadata | 无网络调用 | 无 token | disabled | zero-network、zero-write |
| Auth/quota | local-system/disabled 可见 | 无外部调用 | 无 Cookie/session | disabled | no Better Auth/quota schema/runtime |
| Removed integrations | 不注册 GitHub/Vercel/Supabase/ClickHouse/observability adapter | 不发起调用 | 不接受对应凭据 | removed | import/route/dependency/network 零引用 |

## 22. 已确认和待确认接口决策

1. 已确认首版 Auth/quota 为 disabled，不迁移 Better Auth 和 quota 执行链。
2. 已确认 Preview 使用显式启用的 Windows local unsandboxed adapter。
3. 已确认 Benchmark 资源保留内部 `benchmarks/quantpilot` 目录名。
4. 已确认 Memory/Knowledge 固定 disabled，Shadow Replay 不迁移。
5. 已确认首版 realtime 为单机 in-process WS/SSE + durable polling，不要求 Redis fan-out。
6. 已确认 ClickHouse runtime 不迁移，screener 使用 TimescaleDB adapter。
7. `BLOCKED（非核心）`：Eval schedule 缺少 UI 和主动 scheduler，尚不能确定进程所有权、
   lease、时钟与重启恢复语义。
