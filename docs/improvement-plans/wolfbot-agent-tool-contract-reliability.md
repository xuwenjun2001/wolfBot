# WolfBot Agent 工具契约与运行可靠性修复计划

- 状态：已完成（2026-08-31）
- 计划日期：2026-08-31
- 实施基线：`main` 分支 `62a6ee8`
- 变更类型：`fix(wolf-dashboard)`
- 变更 ID：`WB-20260831-001`
- 关联计划：[WolfBot Agent MVP 实施计划](wolfbot-agent-mvp.md)

> 本计划已实施并通过自动回归与真实 Provider 验收。新运行只暴露按业务语义
> 拆分的固定端点工具；历史 `quant_api_get` 事件仍保持可读。未经授权未创建
> 提交或推送。

## 实施与验收结果

- sidecar 已替换通用行情入口，按 Skill 模式裁剪工具，并对引用路径、筛选 DSL、
  批次、预算、连续失败和工具生命周期执行 fail-closed 校验。
- 成功工具结果向模型明确返回精确 `tool_call_id`；终端证据引用失败会列出本次
  run 可用的成功 call ID。PI Schema 错误在持久化前移除完整参数，避免泄露或
  重复保存长模型正文。
- backend 已兼容新工具 artifact，Skill 内容响应只列安全 Markdown 引用；前端
  只根据成功配对的候选工具事件回填表格。
- `start.ps1` 只从本地 `.env` 向子进程补充 `OPENAI_API_KEY`、
  `OPENAI_BASE_URL`、`OPENAI_MODEL` 和 `OPENAI_REASONING_EFFORT`，现有进程环境
  优先，不向 sidecar 额外导入 Cookie 等配置。
- 自动验证：sidecar typecheck/build 通过，Vitest `27 passed`；backend pytest
  `79 passed, 2 warnings`；前端与 smoke 脚本 `node --check`、PowerShell parser
  和 `git diff --check` 通过。
- 真实 Provider smoke：run `0aaf70118a2e4028a16323c4135455fc` 状态为
  `completed`；5 次调用全部成功、单轮最多 1 次、无错误码，成功覆盖
  `load_skill`、`read_skill_reference`、`resolve_symbol`、`get_price_history`
  和 `submit_analysis`，数据时点为 `2026-08-31`。

## 1. 背景与问题定义

真实模型运行已经重复出现 `TOOL_LIMIT`，但该错误不是行情服务限流，
也不是 OpenAI-compatible Provider 的 HTTP 429。它由本地 sidecar 在达到
`AGENT_MAX_TOTAL_TOOL_CALLS=20` 后生成。

最近一次“分析一下药明康德上一周的走势”运行呈现以下链路：

1. run 以 `skill_mode=none` 启动，但模型仍能看到并调用 `load_skill`；4 次
   Skill 调用均以 `SKILL_NOT_SELECTED` 失败。
2. 模型随后批量调用 `quant_api_get` 和 `screen_stocks`。调用在进入 FastAPI
   前已被参数或 Schema 校验拒绝，没有形成行情证据。
3. 前 7 轮累计消耗 20 次工具预算；第 8 轮又请求 8 次工具，sidecar 以
   `TOOL_LIMIT` 终止。
4. 持久化事件把前置校验错误统一投影为 `TOOL_ERROR: Tool call was rejected.`，
   页面只能看到最终预算错误，无法定位最早的错误参数。

此前自动选择 `wolf-investing` 的同类问题也出现过相同终态：Skill 正文和
一个引用读取成功后，模型因不知道合法 endpoint 和参数组合而继续猜测路径、
引用文件与工具参数，最终再次触发 `TOOL_LIMIT`。

已用当前 sidecar 工具实现和本地 FastAPI 只读验证确认：

- “药明康德”可以解析为 canonical symbol `sh603259`。
- 历史日线和技术指标接口可以正常返回数据。
- 因此首要故障位于“模型可见工具契约和运行循环”，不是证券目录、腾讯行情
  或 FastAPI 路由本身。

## 2. 修复目标与边界

### 2.1 目标

1. 模型无需猜测 URL、endpoint 或 query key，即可完成证券解析、报价、日线、
   指标、股票池与筛选调用。
2. `skill_mode=none` 时不向模型提供不可用的 Skill 工具；自动模式无可用 Skill
   时行为相同。
3. 每个工具尝试都有完整、单一且可审计的开始/完成或失败事件，参数错误保留
   具体错误码和脱敏消息。
4. 无效参数和超大工具批次不会消耗真实行情请求预算，也不会在多轮猜测后被
   错误归因为 `TOOL_LIMIT`。
5. 单标的趋势问题应在默认 8 轮、20 次工具调用和 16 次市场请求预算内提交
   `completed`；证据确实不足时提交 `insufficient_evidence`。
6. 增加显式运行的真实 Provider smoke，覆盖固定夹具无法发现的模型规划问题。

### 2.2 不在本次范围内

- 不新增外部行情源、财务、估值、行业、资金、新闻或公告数据。
- 不改变 FastAPI 已有 `/api/v1/` 行情与研究 HTTP 路由。
- 不增加任意 HTTP、Shell、文件写入、脚本执行、SQL 或交易工具。
- 不调高默认工具、轮次、市场请求、token 或超时预算。
- 不修改历史 run、事件或证据，不对 SQLite 做迁移。
- 不把真实 Provider smoke 加入默认 CI，也不让测试自动读取或输出凭据。

## 3. 已锁定的设计决策

| 事项 | 决策 |
| --- | --- |
| 通用工具 | 新运行不再向模型暴露 `quant_api_get` |
| 模型接口 | 使用按业务语义拆分的专用工具，每个工具映射一个固定 FastAPI 能力 |
| HTTP 安全 | origin、方法、路径和 query key 全部由 sidecar 固定，模型不能传 URL |
| Schema | 每个字段提供类型、枚举、范围、用途说明和 `additionalProperties: false` |
| 无 Skill 模式 | 保留市场工具和终端工具，移除 `load_skill`、`read_skill_reference` |
| Skill 引用 | `load_skill` 返回精确的 `available_references`；禁止猜测引用路径 |
| 工具批次 | 提示模型每轮优先调用一个工具；单轮最多接纳 3 个工具调用 |
| 连续失败 | 连续 3 个工具轮全部失败后以 `REPEATED_TOOL_FAILURE` 停止 |
| 总工具预算 | 只统计通过前置校验且获准执行的工具调用，默认仍为 20 |
| 市场请求预算 | 只统计通过校验并进入市场工具执行的调用，默认仍为 16 |
| 兼容性 | 历史 `quant_api_get` 事件继续读取；浏览器 run API 和 FastAPI 行情 API 不变 |
| 真实验收 | 增加需要显式执行、使用现有本地服务和 Provider 的 smoke 命令 |

## 4. 模型可见工具契约

### 4.1 工具到 FastAPI 的固定映射

| 工具 | 模型输入 | sidecar 固定调用 | 用途 |
| --- | --- | --- | --- |
| `resolve_symbol` | `query` | `GET /api/v1/symbols/resolve` | 将名称、代码或别名解析为 canonical symbol |
| `get_realtime_quote` | `symbol` | `GET /api/v1/quotes/realtime/{symbol}` | 获取实时或最近报价 |
| `get_price_history` | `symbol`、可选 `adjustment`、`limit` | `GET /api/v1/quotes/history/{symbol}` | 获取日 K |
| `get_technical_indicators` | `symbol`、可选 `adjustment`、`limit` | `GET /api/v1/indicators/technical/{symbol}` | 获取均线、收益、波动与回撤 |
| `get_universe_summary` | 空对象 | `GET /api/v1/research/universes/summary` | 获取全 A 股票池数据覆盖 |
| `get_universe_members` | 可选 `page`、`page_size` | `GET /api/v1/research/universes/a-share/members` | 分页读取股票池成员 |
| `get_preset_candidates` | `mode`、可选 `as_of`、`limit` | `GET /api/v1/research/screeners/a-share/short-term-candidates` | 执行固定筛选模式 |
| `screen_stocks` | `conditions`、`sort`、可选 `as_of`、`limit` | `POST /api/v1/research/screeners/a-share/query` | 执行白名单自定义筛选 |
| `submit_analysis` | 结构化终态、回答、证据、限制和风险声明 | sidecar 本地终端工具 | 提交唯一可展示终态 |

存在可用 Skill 且模式允许时，额外注册：

| 工具 | 输入 | 约束 |
| --- | --- | --- |
| `load_skill` | `skill_id` | 只能加载本次允许的一个已启用 Skill |
| `read_skill_reference` | `skill_id`、`path` | `path` 必须来自 `load_skill.available_references` |

`quant_api_get` 从 `TOOL_NAMES` 和模型工具定义中移除。其底层固定请求、响应大小、
超时、重定向禁止和脱敏能力保留为专用工具共享的内部 helper，不提供通用入口。

### 4.2 公共参数规则

- `query`：UTF-8 非空字符串，1 至 80 个字符，可为名称、代码或 canonical symbol。
- `symbol`：必须匹配 `^(?:sh|sz|bj)[0-9]{6}$`；名称问题必须先调用
  `resolve_symbol`，后续工具只使用解析响应中的 symbol。
- `adjustment`：只允许 `none`、`qfq`、`hfq`，默认 `qfq`。
- `limit`：行情/指标为 1 至 800；筛选为 1 至 20。工具层使用与 FastAPI 一致的
  默认值，不让模型传 `period`，周期固定为 `daily`。
- `mode`：只允许 `short_term`、`limit_up_relay`、`trend_liquidity`。
- `as_of`：省略或使用 `YYYY-MM-DD`；不要求模型传 JSON `null`。
- `page`：最小 1；`page_size` 为 1 至 200。
- universe 固定为 `a-share`，不作为模型输入。

`screen_stocks` 的 `field`、`right_field` 和排序字段必须在 Schema 中直接公开以下
枚举，而不是仅在运行时 TypeScript Set 中校验：

```text
exchange, board, asset_type, close, change_pct, amount, turnover,
ma5, ma10, ma20, ma30, ma60,
return_5d_pct, return_10d_pct, return_20d_pct, return_60d_pct,
amount_ratio_20d, volatility_20d_pct,
max_drawdown_20d_pct, max_drawdown_60d_pct,
is_st, is_limit_up, is_limit_down, trade_status,
limit_up_count_4d, limit_up_count_10d
```

操作符只允许 `eq`、`gt`、`gte`、`lt`、`lte`、`between`。每个条件必须且只能
提供 `value` 或 `right_field` 之一；`between` 必须使用两个有限数字。现有语义
校验继续作为服务端第二道防线，不能只依赖模型 Schema。

### 4.3 单标的标准调用序列

“分析一下药明康德上一周的走势”的期望流程为：

```json
{"query":"药明康德"}
```

```text
resolve_symbol -> sh603259
```

```json
{"symbol":"sh603259","adjustment":"qfq","limit":10}
```

```text
get_price_history -> 最近交易日日 K、source、as_of、data_quality
```

如需均线或波动指标，再执行：

```json
{"symbol":"sh603259","adjustment":"qfq","limit":20}
```

```text
get_technical_indicators -> points、summary、source、as_of、data_quality
```

最后调用 `submit_analysis`，证据引用必须指向本次 run 中成功完成的行情工具
call ID。不得为同一目的并列猜测多个 endpoint 或 symbol 格式。

## 5. Skill 可见性与引用契约

sidecar 根据 run 请求动态构造工具集合：

| 模式 | Skill 描述符 | 可见 Skill 工具 |
| --- | --- | --- |
| `none` | 空 | 无 |
| `auto` 且无已启用 Skill | 空 | 无 |
| `auto` 且有已启用 Skill | 所有已启用摘要 | `load_skill`、`read_skill_reference` |
| `manual` | 仅用户选择的 Skill | `load_skill`、`read_skill_reference` |

FastAPI 的 Skill 内容响应增加只读字段：

```json
{
  "skill_id": "wolf-investing",
  "path": "SKILL.md",
  "content": "...",
  "version": "0.1.0",
  "available_references": ["references/market-fields.md"]
}
```

引用列表从已通过完整性校验的安装目录生成，只包含安全的
`references/**/*.md` 相对路径，按字典序排列并受现有文件数量限制。sidecar
不得把安装路径或任意文件名暴露给模型。

内置 `wolf-investing` 同步增加以下运行指导：

- 名称先解析为 canonical symbol，再调用行情工具。
- 单标的趋势优先取最小日线窗口，只有确有需要时再取指标或实时价。
- 只调用工具定义中存在的语义工具。
- 只读取 `available_references` 中的路径。
- 同一校验错误纠正一次；仍失败时提交 `insufficient_evidence`，不得批量猜测。

## 6. 运行循环与预算语义

### 6.1 工具分类

`RegisteredTool` 增加内部分类元数据，不暴露给 Provider：

```text
skill      load_skill, read_skill_reference
market     所有行情、股票池和筛选工具
terminal   submit_analysis
```

运行引擎按分类统计预算和生成 artifact，避免在多个条件分支中重复硬编码工具名。

### 6.2 前置校验与批次控制

处理每个 assistant tool-call message 时按以下顺序执行：

1. 校验 call ID、工具名和终端工具独占性。
2. 若一轮请求超过 3 个工具，将该轮所有调用标为 `TOOL_BATCH_LIMIT` 并阻止执行；
   结果回灌模型以允许下一轮纠正，该批次不计入工具或市场预算。
3. PI Schema 校验失败时生成 `INVALID_TOOL_INPUT`，不调用工具、不计预算。
4. `beforeToolCall` 再执行工具自己的语义解析；失败同样返回
   `INVALID_TOOL_INPUT`，并保留具体、脱敏、限长的消息。
5. 只有通过上述检查且预算仍有余额的调用才增加总工具计数。
6. 只有分类为 `market` 且即将执行的调用才增加市场请求计数。
7. 达到真实预算时仍使用 `TOOL_LIMIT` 或 `MARKET_REQUEST_LIMIT`，不得静默放宽。

### 6.3 连续失败保护

- 每个包含工具调用的 turn 记录 attempted、completed、failed 和主要错误码。
- 只要本轮至少一个工具成功，连续全失败计数归零。
- 一轮全部失败时计数加一；工具结果需提示模型纠正参数或提交证据不足终态。
- 连续 3 个工具轮全部失败后，以 `REPEATED_TOOL_FAILURE` 终止并保存最后一个
  具体错误码，不继续消耗模型轮次直至 `TOOL_LIMIT`。
- Provider、超时、取消和终端工具错误继续使用现有独立终态，不并入连续工具失败。

默认预算保持：8 个模型轮次、20 个获准工具调用、16 个市场请求、12,000 个
累计输出 token、300 秒整体超时。

## 7. 工具事件与错误可观测性

当前工具执行事件分别由 governed tool wrapper 和 PI 回调生成，导致前置 Schema
失败没有 `tool_started`，最终又被降级成通用 `TOOL_ERROR`。实施时统一以 PI 的
`tool_execution_start` 和 `tool_execution_end` 为唯一生命周期来源。

每个调用必须恰好生成：

```text
tool_started -> tool_completed
```

或：

```text
tool_started -> tool_failed
```

`tool_started` 保存经过公共脱敏和大小限制的参数；即使 Schema 失败，也保存足以
定位字段形状的公共投影。`tool_failed` 使用统一结构：

```json
{
  "turn": 2,
  "operation_id": "<run>:turn-2:op-1",
  "tool_call": {"id": "call-1", "name": "get_price_history"},
  "ok": false,
  "error": {
    "code": "INVALID_TOOL_INPUT",
    "message": "symbol must use a canonical sh/sz/bj prefix"
  }
}
```

错误消息继续执行凭据、token、Cookie、路径和长度脱敏。只有无法分类的 PI 内部
错误才允许使用 `TOOL_ERROR`；参数、未知工具、批次、预算、FastAPI HTTP、协议、
取消和超时必须保留各自错误码。

后端投影与前端轨迹直接展示上述公开错误，不保存模型隐藏推理或未脱敏 Provider
响应。

## 8. 证据、artifact 与前端兼容

后端证据持久化采用以下映射：

| 工具 | artifact 类型 |
| --- | --- |
| `resolve_symbol`、报价、日线、指标、股票池摘要/成员 | `market_evidence` |
| `get_preset_candidates`、`screen_stocks` | `candidate_table` |
| `load_skill`、`read_skill_reference` | 仅普通证据，不生成市场 artifact |
| `submit_analysis` | 保持现有终态证据校验 |

为兼容历史记录，后端读取和投影仍识别 `quant_api_get`，但 sidecar 不再为新运行
产生该工具名。

前端工具轨迹继续按事件中的动态工具名展示。候选表回填扩展为：

- `screen_stocks` 按现有参数调用自定义筛选 POST。
- `get_preset_candidates` 按 mode、as_of、limit 调用固定筛选 GET。
- 其他专用市场工具不触发候选表回填。

浏览器 `POST /api/v1/runs`、run 详情、SSE 与取消接口不改变路径和请求体。

## 9. 实施步骤

### 阶段 1：专用工具与 Schema

1. 在 sidecar 工具模块定义专用工具名称、Schema、分类和固定 endpoint 映射。
2. 抽取共享的固定 FastAPI 请求 helper，保留 origin、重定向、超时、响应大小、
   JSON 解析和取消限制。
3. 移除模型可见 `quant_api_get`，补齐 screener 字段枚举和参数说明。
4. 根据 Skill 模式裁剪工具集合，并把安全引用清单加入 Skill 加载响应。
5. 更新 `wolf-investing` 的工具工作流和引用约束。

阶段门槛：所有工具契约单测通过；没有模型可控 URL、路径或 HTTP 方法。

### 阶段 2：运行循环与公开事件

1. 把工具 lifecycle 事件统一迁移到 PI 执行事件。
2. 引入工具分类预算、每轮批次上限和连续全失败保护。
3. 保留结构及语义校验的具体公开错误，删除误导性的通用拒绝投影。
4. 确保终端工具仍然单轮独占，证据只能引用本次 run 已成功完成的工具。

阶段门槛：原问题的回归夹具不再以 `TOOL_LIMIT` 结束；无效参数在第一条失败
事件即可定位。

### 阶段 3：后端、前端与兼容

1. 更新后端新工具证据和 artifact 映射，保留历史工具读取。
2. 增加 Skill 引用清单 API 字段和安全测试。
3. 扩展固定筛选候选表回填，确认普通单标的工具不重复请求。
4. 更新 README、sidecar 文档和项目全景图中的当前工具与验证命令。

阶段门槛：既有 run API/SSE 回归全部通过，历史数据库无需迁移。

### 阶段 4：真实模型验收

新增非默认命令 `npm run smoke:provider`。脚本通过正在运行的 FastAPI 创建真实
run，而不是直接绕过产品 API 调用运行引擎。

运行前置条件：

1. Provider 环境变量已配置，但脚本不读取或打印 key。
2. FastAPI 与 sidecar 已按正常启动方式运行。
3. A 股目录已初始化，且“药明康德”能够解析为 `sh603259`。
4. 当前没有其他活动 run。

脚本提交：

```json
{
  "question": "分析一下药明康德上一周的走势",
  "skill_mode": "auto"
}
```

脚本最多等待 300 秒，读取最终 run 和事件后只输出 run ID、状态、工具名、错误码、
计数和数据时间，不输出凭据、完整模型文本或原始大响应。

## 10. 失败场景与预期行为

| 场景 | 预期行为 |
| --- | --- |
| 无 Skill 模式请求 `load_skill` | Provider 根本看不到该工具；若返回未知工具名，则 `UNKNOWN_TOOL` |
| 模型为行情工具传名称而非 canonical symbol | `INVALID_TOOL_INPUT`，提示先 `resolve_symbol` |
| 模型传任意 path、URL 或 query 字段 | Schema 不包含这些字段，调用在本地被拒绝 |
| 单轮请求 4 个以上工具 | 全批次 `TOOL_BATCH_LIMIT`，不请求 FastAPI、不计预算，并允许下一轮纠正 |
| 连续 3 个工具轮全部失败 | `REPEATED_TOOL_FAILURE`，不继续等待预算耗尽 |
| 合法调用达到 20 次 | `TOOL_LIMIT`，含真实 accepted-call 计数 |
| 实际市场调用达到 16 次 | `MARKET_REQUEST_LIMIT` |
| Skill 猜测不存在引用 | 可用路径已明确；非法路径显示具体失败且计入失败轮次 |
| FastAPI 返回 4xx/5xx | 保留 `FASTAPI_HTTP_ERROR` 与状态码，不伪造数据 |
| 行情覆盖不足 | Agent 使用现有证据提交 `insufficient_evidence` |
| Provider 不遵守工具 Schema | 本地校验失败关闭，事件可定位，不访问越权 endpoint |
| 历史 run 含 `quant_api_get` | 详情、证据与前端轨迹继续可读 |

## 11. 测试与验收矩阵

### 11.1 Sidecar 自动测试

- 每个专用工具的合法输入生成精确 URL、方法、query/body 和取消信号。
- 未知字段、非 canonical symbol、非法 adjustment/limit/date/mode 被拒绝。
- `screen_stocks` 的字段、操作符、值类型、right-field 类型和排序枚举一致。
- `none`、空自动模式、有效自动模式和手动模式暴露正确工具集合。
- Skill 加载只返回经过完整性校验的引用路径。
- PI Schema 失败也生成单一 `tool_started` 与具体 `tool_failed`。
- 超大批次不执行工具，下一轮合法调用可以恢复。
- 连续失败在第 3 个全失败工具轮终止；中间成功会重置计数。
- 合法工具、市场工具和终端工具预算分别正确计数。
- 终端工具混用、无终端提交、超时和取消保持现有失败语义。

### 11.2 后端与前端测试

- 新工具事件能够持久化、SSE 恢复、脱敏并映射到正确 artifact。
- 历史 `quant_api_get` fixture 仍能生成 `market_evidence`。
- Skill 内容 API 的 `available_references` 只包含安全 Markdown 路径。
- 固定筛选和自定义筛选均能回填候选表；失败时显示具体错误。
- 工具名或长错误文本不会破坏桌面和移动端轨迹布局。

### 11.3 真实 Provider smoke 验收

“分析一下药明康德上一周的走势”必须满足：

- 最终状态为 `completed`，并存在 `terminal_submitted`。
- 至少成功完成 `resolve_symbol` 和 `get_price_history`。
- 回答证据引用本次成功工具 call ID，并包含 source、as_of、复权和限制说明。
- 获准执行的工具调用不超过 10，单轮不超过 3。
- 不出现 `TOOL_LIMIT`、`MAX_TURNS`、`UNKNOWN_TOOL`、
  `INVALID_TOOL_INPUT` 或 `REPEATED_TOOL_FAILURE`。
- 若外部行情在验收时确实不可用，smoke 必须失败并记录真实外部错误；不得把
  `insufficient_evidence` 当作本用例的通过结果。

### 11.4 验证命令

```powershell
Push-Location D:\wolf\wolf-dashboard\backend
$env:PYTHONPATH = (Get-Location).Path
.\.venv\Scripts\python.exe -m pytest -q
Pop-Location

Push-Location D:\wolf\wolf-dashboard\agent-sidecar
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:provider
Pop-Location

git diff --check
git status --short
```

真实 Provider smoke 与普通测试结果必须分开记录；没有配置或未执行时，不得声称
端到端验收通过。

## 12. 完成标准与交付约束

只有同时满足以下条件，本修复才可标记完成：

1. 模型可见工具中不存在通用 `path/query` 行情入口，所有市场访问仍受固定
   FastAPI 白名单控制。
2. 原问题自动回归和真实 Provider smoke 均通过，且没有以调高预算规避失败。
3. 参数、批次、预算、FastAPI 和 Provider 错误能够从第一条公开失败事件定位。
4. `none`、自动和手动 Skill 模式均符合本文工具可见性表。
5. 现有后端、sidecar、前端和历史事件兼容测试全部通过。
6. README、sidecar 文档、项目全景图、`CHANGELOG.md` 和 `COMMIT_LOG.md`
   与代码事实同步。
7. `fix` 提交使用实施时确认的唯一变更 ID；提交正文写明 Why、How、Validation。
8. 不提交数据库、日志、`.env`、Provider 响应、真实运行导出、`node_modules`
   或 `dist`。
9. 未经当前任务明确授权，不创建提交或推送。
