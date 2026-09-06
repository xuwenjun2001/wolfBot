# wolf-dashboard 重构风险登记

调查日期：2026-09-04；最终复核：2026-09-05

## 1. 评分

- 影响：`Critical`、`High`、`Medium`、`Low`
- 可能性：`High`、`Medium`、`Low`
- 状态：`Open`、`Mitigated`、`Blocked`

阶段三/四已完成重构实现和主要验证；下表状态反映当前目标运行边界。`Mitigated` 仍可有残余风险，
但已有运行时限制和验证证据；contract 直接入口、Eval queue 重启恢复和构建 trace 安全仍按独立
复核保留为后续风险；非核心 Eval schedule 另在重构文档中保持 `BLOCKED`。

## 2. 五个最高风险

| 排名 | ID | 风险依赖 | 影响 | 可能性 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | R-002 | Windows 本地非沙箱执行模型生成代码 | Critical | High | Mitigated |
| 2 | R-001 | dirty snapshot 在冻结前继续变化 | Critical | Medium | Mitigated |
| 3 | R-003 | PostgreSQL durable Agent schema、lease 和 fencing 被不完整迁移 | Critical | Medium | Mitigated |
| 4 | R-004 | Eval E2E 与完整研究 runtime 强耦合 | High | High | Mitigated |
| 5 | R-005 | 行情与模型外部 Provider 不稳定或合同漂移 | High | High | Mitigated |

## 3. 详细风险

### R-001：源工作区 dirty

| 项 | 内容 |
| --- | --- |
| 证据 | 源 `main` 在提交 `2015ecdc...` 上有 35 个未提交项，多项位于研究核心链 |
| 事实状态 | 已确认 |
| 影响 | 无法从 commit 重建迁移输入；后续 diff、归因和回归结果不可复核 |
| 检测 | 迁移前后比较源 `git status`、文件 SHA-256 和 manifest |
| 缓解 | 用户已指定当前 working-tree snapshot；批次 0 逐文件记录 hash/dirty 标志 |
| 回退 | 检测到源变化立即停止该批迁移，重新生成 manifest，不能猜测合并 |
| 剩余风险 | 当前没有外部不可变快照 |
| 状态 | Mitigated |

### R-002：Windows 本地非沙箱执行生成代码

| 项 | 内容 |
| --- | --- |
| 证据 | `src/lib/security/generated-project-sandbox.ts#wrapGeneratedProjectCommand` 仅支持 Linux `unshare`；非 Linux 默认抛错 |
| 事实状态 | 已确认 |
| 影响 | 模型生成的 Next.js build/dev 进程与本机共享 OS 边界，恶意或缺陷代码可能访问进程权限范围内资源 |
| 检测 | 启动 preflight、开关严格值测试、artifact policy、路径/命令/env allowlist、进程退出和敏感信息扫描 |
| 缓解 | 用户已选择首版 Windows 本地模式；默认关闭，使用 `WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE=1` 显式启用，限制 loopback、cwd、命令、环境、超时和日志，并公开 `windows-unsandboxed` |
| 回退 | 关闭开关后返回 `PREVIEW_UNSANDBOXED_NOT_ENABLED`，保留 artifact，不宣称 preview ready |
| 禁止项 | 静默启用、对外或多用户部署时宣称其为 sandbox、向生成进程注入平台密钥 |
| 状态 | Mitigated |

### R-003：durable Agent 一致性语义丢失

| 项 | 内容 |
| --- | --- |
| 证据 | `AgentGenerationJob`、outbox、leases、worker slots、Mission、events、checkpoints、tool executions 和 approvals 共同参与运行 |
| 事实状态 | 已确认 |
| 影响 | 重复执行、旧 worker 覆盖新结果、取消后提交、永久 running、证据与结果不一致 |
| 检测 | PostgreSQL integration tests；并发 claim、lease lost、fencing、orphan recovery 测试 |
| 缓解 | 完整迁移 schema 和 store，不把 inline Map 当生产权威；保留事务和 fencing token |
| 回退 | 生产禁用 worker dispatch，只允许明确标记的单进程维护模式；不能静默改为非 durable |
| 状态 | Mitigated |

### R-004：Eval E2E 强耦合研究 runtime

| 项 | 内容 |
| --- | --- |
| 证据 | `scripts/evals/run-quant-benchmarks.js` 直接加载 finance workspace、query rewrite、prefetch、PI Agent、validation、preview |
| 事实状态 | 已确认 |
| 影响 | 评测 UI 可启动但 E2E 不真实；漏迁研究子模块会在 runner 运行时才失败 |
| 检测 | contract 和 E2E 分开执行；报告验证 `executionMode`、AgentRun、tool evidence 和 attestation |
| 缓解 | 先完成研究切片，再迁 contract，再启用 E2E；禁止 E2E 自动降级为 contract |
| 回退 | 明确关闭 E2E 并返回 `EVAL_E2E_NOT_CONFIGURED`，保留 contract 模式 |
| 状态 | Mitigated |

### R-005：行情与模型 Provider 不稳定

| 项 | 内容 |
| --- | --- |
| 证据 | 市场依赖 EastMoney/Tencent 等外部接口；模型依赖本地 Qwen/ModelPort/DeepSeek |
| 事实状态 | 已确认 |
| 影响 | Query rewrite、取数或 Agent 失败；字段漂移造成错误看板；限流延长任务 |
| 检测 | health probe、schema validation、timeout/429/5xx contract tests、数据质量标记 |
| 缓解 | `MarketDataPort` 和 `ModelProviderPort`；固定 endpoint；有界重试；provider/asOf/quality 可追溯 |
| 回退 | 部分数据返回 explicit issues；核心数据全失败则任务失败，不生成虚假看板 |
| 状态 | Mitigated |

### R-006：Eval 双存储掩盖故障

| 项 | 内容 |
| --- | --- |
| 证据 | `src/lib/eval/runtime.ts` 多处 `catch(() => [])`、`catch(() => undefined)` |
| 事实状态 | 已确认 |
| 影响 | 数据库或文件损坏被展示为空状态或成功，取消和调度状态不可信 |
| 检测 | 故障注入 DB/file read/write；dashboard health assertions |
| 缓解 | DB 为状态权威；artifact 写入记录 hash；partial failure 返回 typed error 和 outbox |
| 回退 | 评测平台进入 degraded/unavailable，不接受新任务 |
| 状态 | Mitigated |

### R-007：工作区路径逃逸或误删

| 项 | 内容 |
| --- | --- |
| 证据 | 项目目录、asset、repo editor、临时评测项目和 preview 都执行文件操作 |
| 事实状态 | 已确认 |
| 影响 | 覆盖用户文件、读取凭据、删除目标根外目录 |
| 检测 | traversal、symlink/junction、absolute path、case-insensitive Windows path tests |
| 缓解 | `WorkspaceStoragePort` 只接受相对引用；realpath containment；删除前二次校验 |
| 回退 | 拒绝操作并保留审计，不进行自动“修复路径” |
| 状态 | Mitigated |

### R-008：依赖安装和 preview 进程失控

| 项 | 内容 |
| --- | --- |
| 证据 | `PreviewManager` 探测 package manager、安装依赖、启动 Next server、分配端口 |
| 事实状态 | 已确认 |
| 影响 | 供应链脚本、进程泄漏、端口冲突、磁盘膨胀、请求长期挂起 |
| 检测 | command allowlist、process ownership、timeout、port ownership 和 cleanup tests |
| 缓解 | `ProcessSupervisorPort`；`--ignore-scripts`；输出/时间/空间限额；sandbox network bridge |
| 回退 | 终止所属进程，标记 preview failed，保留可定位日志 |
| 状态 | Mitigated |

### R-009：WebSocket/SSE 为进程本地

| 项 | 内容 |
| --- | --- |
| 证据 | `StreamManager` 和 websocket manager 使用 `globalThis` 单例和内存 Map |
| 事实状态 | 已确认 |
| 影响 | 多实例下事件发到错误实例，UI 卡在 loading；重启丢连接 |
| 检测 | 单机连接断开、SSE/polling recovery、重复 singleton 和 teardown 测试；多实例仍需后续专项验证 |
| 缓解 | 首版明确限定单机 Web；状态先持久化，WS/SSE 失败由 durable polling 恢复；多实例部署前必须增加 Redis 或 durable event bus adapter |
| 回退 | 禁用 WS，使用 SSE/polling 并公开 transport degraded 状态 |
| 状态 | Mitigated |

### R-010：取消语义在 Windows/多主机失效

| 项 | 内容 |
| --- | --- |
| 证据 | Eval 使用 `SIGTERM` 和 PID；preview 对 Windows 与 POSIX 使用不同终止逻辑 |
| 事实状态 | 已确认 |
| 影响 | UI 显示 cancelled 但进程仍运行，或 PID 重用误杀其他进程 |
| 检测 | queued/running/orphaned/cross-host cancel integration tests |
| 缓解 | process identity 包含 host、worker、spawn token；状态经过 cancelling -> cancelled |
| 回退 | 标记 `PROCESS_ORPHANED`，要求 supervisor 清理，不伪造取消成功 |
| 状态 | Mitigated |

### R-011：disabled Auth/quota 边界残留

| 项 | 内容 |
| --- | --- |
| 证据 | 源支持 disabled/local；研究和 eval API 使用不同 permission actions；项目创建/act 使用 quota |
| 事实状态 | 已确认 |
| 影响 | 已排除的账户/quota 代码仍扩大 schema，或移除过度导致 API action/project context 丢失 |
| 检测 | disabled actor、无 session/Cookie、无 quota side effect、same-origin mutation tests |
| 缓解 | 首版固定 disabled local-system adapter；保留 Authorization facade 和 action/project context |
| 回退 | 仅允许 loopback local-system 模式，禁用未封口的 mutation |
| 状态 | Mitigated |

### R-012：Skill registry/hash 漂移

| 项 | 内容 |
| --- | --- |
| 证据 | `.pi/skills.registry.json`、lock 和 capsules 同时约束版本、hash、文件数和 phase |
| 事实状态 | 已确认 |
| 影响 | Agent 上下文与报告声明不一致；评测不可复现；启动时运行失败 |
| 检测 | `check:skills --check-lock`、package hash 和 report skill snapshot |
| 缓解 | 迁移规范源后重新生成 package/lock；不手工编辑 hash |
| 回退 | 启动失败关闭，不能使用 registry fallback 进入生产 |
| 状态 | Mitigated |

### R-013：动态 import 和脚本依赖漏迁

| 项 | 内容 |
| --- | --- |
| 证据 | 首页动态导入 `TaskDrawer`；benchmark 用 `jiti`；WS 使用 Pages Router；child process 引用脚本和 JSON |
| 事实状态 | 已确认 |
| 影响 | type-check 通过但运行时模块缺失 |
| 检测 | 静态 import graph + 搜索 dynamic/import/jiti/spawn/path.resolve；实际 build 和 E2E |
| 缓解 | manifest 单列运行时资源；每批执行 route smoke 和 runner smoke |
| 回退 | 停止下一批，补映射和测试，不复制整个源目录兜底 |
| 状态 | Mitigated |

### R-014：Memory/Knowledge 可选行为造成伪降级

| 项 | 内容 |
| --- | --- |
| 证据 | Chat act 直接调用 personalization 和 governed knowledge；源支持 required/optional 配置 |
| 事实状态 | 已确认 |
| 影响 | 关掉后行为差异未披露，或 HTTP 故障被当作无召回结果 |
| 检测 | disabled/optional/required contract tests；generation metadata issue assertions |
| 缓解 | 用户已确认首版固定正式 disabled adapter，不迁移 HTTP provider 和反馈 UI |
| 回退 | 关闭 UI feedback 控件并显示集成未启用，不伪造成功 receipt |
| 状态 | Mitigated |

### R-015：ClickHouse 范围误判

| 项 | 内容 |
| --- | --- |
| 证据 | Python 主依赖包含 `clickhouse-connect`，研究 screener 可使用 ClickHouse 增强 |
| 事实状态 | 已确认存在；无 ClickHouse 的目标 screener 端点测试已证明其不是首版最小依赖 |
| 影响 | 少迁导致 screener/E2E 失败，多迁增加部署和维护成本 |
| 检测 | 对每个最小市场端点做依赖注入和无 ClickHouse 集成测试 |
| 缓解 | 首版分类 `REMOVE`；目标已通过端点级测试并固定 TimescaleDB 路径，不升级为 `MIGRATE` |
| 回退 | screener 返回 `CAPABILITY_NOT_CONFIGURED`，不能返回空候选伪装成功 |
| 状态 | Mitigated |

### R-016：品牌和许可证归因遗漏

| 项 | 内容 |
| --- | --- |
| 证据 | 源 MIT License，UI、benchmark、skill 和文案大量使用 QuantPilot 名称 |
| 事实状态 | 已确认 |
| 影响 | 法务归因不完整，或品牌混杂造成产品问题 |
| 检测 | 文件来源 manifest、license scan、UI 文案 scan |
| 缓解 | 用户可见品牌统一为 Wolf Research；保留 MIT notice、来源和改编范围；内部 benchmark 路径保留 `quantpilot` |
| 回退 | notice、品牌扫描或来源清单不完整时阻止交付 |
| 状态 | Mitigated |

### R-017：隐藏/生产回放数据泄漏

| 项 | 内容 |
| --- | --- |
| 证据 | runner 支持 hidden 和 production replay case path 环境变量 |
| 事实状态 | 已确认 |
| 影响 | 把私有数据、用户 Prompt 或 replay 数据提交到仓库/报告 |
| 检测 | tracked-file check、dataset visibility、prompt redaction、敏感扫描 |
| 缓解 | 首版不迁移 Shadow Replay；只迁公开 benchmark，不复制 private/production replay 数据 |
| 回退 | 拒绝运行并返回 `PRIVATE_DATASET_NOT_CONFIGURED` |
| 状态 | Mitigated |

### R-018：目标误依赖 `wolf-dashboard`

| 项 | 内容 |
| --- | --- |
| 证据 | WolfBot 仓库已有另一个行情/Agent 实现，但用户明确禁止依赖 |
| 事实状态 | 已确认约束 |
| 影响 | `wolf-research` 不能独立启动，模块边界被破坏 |
| 检测 | import、package、URL、filesystem、process command 全仓扫描 |
| 缓解 | 独立 market service 和 adapters；禁止相对路径访问兄弟目录 |
| 回退 | 删除违规依赖并恢复目标本地实现；不能通过文档说明豁免 |
| 状态 | Mitigated |

## 4. 风险接受门槛

重构验收完成前：

- R-001、R-002、R-003、R-004、R-005 已不再是未处理的 `Blocked/Open`；其残余风险仍须按本表
  的检测和回退策略维护。
- 任一 Critical 风险若只能接受，必须有用户明确书面批准和运行时硬限制。
- 测试环境可接受外部 Provider 不可用，但必须使用显式 contract fixture。
- 用户已书面接受首版 Windows 本地 unsandboxed preview；目标已实现默认关闭、显式开关、模式披露、
  artifact policy、环境/路径/命令限制、超时和进程清理。
- 对外或多用户 hardened production 不能沿用该本地模式，也不能使用 test model、静默存储
  fallback 或跨目录文件操作。

## 5. 风险验证关联

每项风险的可执行检查见 [ACCEPTANCE_CRITERIA.md](./ACCEPTANCE_CRITERIA.md)；
接口缓解措施见 [INTERFACE_CONTRACTS.md](./INTERFACE_CONTRACTS.md)。
