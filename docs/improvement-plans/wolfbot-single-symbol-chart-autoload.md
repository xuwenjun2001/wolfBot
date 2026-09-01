# WolfBot 单标的行情图自动展示修复计划

- 状态：已实施
- 验收备注：自动化与本地 HTTP 集成验证通过；浏览器视觉验收尚未执行
- 计划日期：2026-09-01
- 实施日期：2026-09-01
- 目标变更类型：`fix(wolf-dashboard)`
- 变更 ID：`WB-20260901-002`
- 关联计划：[WolfBot Agent MVP 实施计划](wolfbot-agent-mvp.md)、[WolfBot Agent 工具契约与运行可靠性修复计划](wolfbot-agent-tool-contract-reliability.md)

> 本文现同时记录修复范围、落地结果与真实验证情况。本次诊断确认行情源能够返回
> OHLCV 与均线，主要故障位于 Agent 公共事件投影、前端标的选择和图表触发链路。

## 1. 问题摘要

用户直接询问一只明确股票时，Agent 可以正确解析证券并成功取得日线，但页面
“行情与均线”仍停留在“选择候选”，没有显示 K 线、成交量和均线。

以 2026-09-01 的本地运行“生益最近一周的走势如何”为例：

1. `resolve_symbol` 成功把“生益”解析为生益科技 `sh600183`。
2. Agent 随后使用 `sh600183` 成功调用 `get_price_history`。
3. `/api/v1/quotes/history/sh600183` 可返回 120 条前复权 OHLCV；
   `/api/v1/indicators/technical/sh600183` 可返回成交量与 MA5/10/20/30/60。
4. 浏览器没有把该证券设为图表目标，也没有自动执行图表读取。

因此这不是证券识别失败、腾讯行情缺失或 SVG 组件完全不可用，而是数据已经
到达 Agent 和 FastAPI 后，没有形成可被前端稳定消费的“唯一图表标的”。

## 2. 已确认根因

### 2.1 `resolve_symbol` 的证券身份在公共投影中丢失

`resolve_symbol` 的原始成功响应把证券放在嵌套的 `candidates`/`results` 数组中。
FastAPI 的 Agent 服务只保留 `_PUBLIC_DATA_KEYS` 中的顶层字段，当前未保留这两个
数组，也未把唯一候选规范化为顶层 `symbol`、`code` 和 `name`。

结果是：模型能看到完整解析结果并继续调用行情工具，但 SSE、run 详情、证据和
artifact 中的解析事件只剩资产类型、交易所、来源等摘要，浏览器无法仅凭该事件
恢复证券身份。

### 2.2 前端只从候选表识别可绘图标的

前端 `candidateObjects()` 只遍历 `candidates`、`results`、`items` 数组。
`loadCandidateMarket()` 只由候选表“查看”按钮和图表刷新按钮触发。

直接分析单只股票通常不会调用 `screen_stocks` 或 `get_preset_candidates`，所以：

- 页面不会生成候选行；
- 用户没有“查看”按钮可点；
- 成功的 `get_price_history` 或 `get_technical_indicators` 虽然公开结果中已有
  顶层 `symbol`、`code`、`name`，前端也不会把它们用于图表。

### 2.3 图表点位当前没有正确合并 OHLCV 与均线

`normalizeChartPoints()` 当前优先选用 `indicators.points`，只有没有指标点时才使用
`history.bars`。指标点只包含日期、收盘价、成交量和均线，不包含真实开盘、最高、
最低价；现有代码会用收盘价补齐这些字段，从而生成并非真实 OHLC 的蜡烛。

修复自动展示时必须同时改为按交易日合并：

- `history.bars` 是开高低收与成交量的权威来源；
- `indicators.points` 只覆盖 MA5/10/20/30/60 等派生字段；
- 不得用收盘价伪造缺失的开盘、最高或最低价。

## 3. 修复目标与边界

### 3.1 目标

1. 单标的 run 一旦获得唯一、合法的股票、指数或 ETF 身份，页面自动显示该标的
   的前复权日 K、成交量和可用均线，无需先生成候选表或手工点击。
2. 新运行和可恢复的历史运行使用同一套标的发现逻辑；SSE 重放、run 同步和重复
   渲染不会反复请求行情。
3. 后端只公开经过限量和脱敏的证券身份，不直接放行任意嵌套工具响应。
4. 图表按日期合并真实 OHLCV 和均线；部分接口失败时保留可用内容并明确告警，
   不伪造缺失数据。
5. 条件选股仍由用户点击候选切换图表，不自动选择多候选列表中的第一只股票。
6. 板块、概念、行业和主题对象不进入单证券 K 线链路。

### 3.2 不在本次范围内

- 不新增行情源、分钟线、周线、复权算法、财务、资金流、新闻或公告。
- 不改变现有行情 API 路径，不把完整 bars/points 写入 Agent 事件或 SQLite artifact。
- 不为模糊证券解析自动猜选候选，不把 `board_id` 当成证券代码。
- 不改动模型工具调用预算、Provider 配置或 sidecar 的市场工具定义。
- 不自动修改历史数据库；旧 run 只能使用当时已经持久化的安全字段恢复。
- 不在本计划阶段提交、推送或声称代码修复已经完成。

## 4. 目标数据流

```text
用户提出单标的问题
  -> sidecar: resolve_symbol
  -> FastAPI 行情层返回唯一 canonical symbol
  -> Agent 服务生成有界公共证券身份
  -> SSE / run detail / artifact 到达浏览器
  -> 前端确认唯一且合法的 chart target
  -> 自动请求 history + technical indicators
  -> 以 history OHLCV 为基底，按日期叠加 MA
  -> 显示 K 线、成交量、均线、数据日期和部分失败警告
```

前端还应支持以下恢复路径：

```text
旧 run 的 resolve artifact 缺少 symbol
  -> 查找成功的 get_price_history / get_technical_indicators artifact
  -> 使用其顶层 symbol/code/name 恢复 chart target
```

## 5. 后端公共投影设计

### 5.1 使用工具感知的证券身份投影

不要把 `candidates` 或 `results` 简单加入全局 `_PUBLIC_DATA_KEYS`。这会让所有工具
都能把任意大小和形状的同名数组带入事件，并削弱当前的大小与隐私边界。

应增加统一 helper，例如：

```text
_project_public_tool_data(tool_name, data) -> bounded public mapping
```

该 helper 同时供 `_project_event()` 和 `_persist_evidence()` 使用，避免 SSE、证据和
artifact 对同一工具生成不同字段。

对 `resolve_symbol`：

- `status=resolved` 且恰好一个候选时，把安全身份规范化为顶层字段：
  `query`、`status`、`ambiguous`、`candidate_count`、`symbol`、`code`、`name`、
  `asset_type`、`exchange`、`source`、`fetched_at`、`data_quality`。
- 模糊解析时可以保留最多 8 个安全候选，每项只允许证券身份字段，不自动选择。
- 未解析时不产生虚假的 `symbol`，保留可定位状态和数据质量信息。
- canonical symbol 必须继续满足 `^(?:sh|sz|bj)[0-9]{6}$`。

目标唯一解析公共形状示例：

```json
{
  "query": "生益",
  "status": "resolved",
  "ambiguous": false,
  "candidate_count": 1,
  "symbol": "sh600183",
  "code": "600183",
  "name": "生益科技",
  "asset_type": "stock",
  "exchange": "SH",
  "source": "local-catalog"
}
```

### 5.2 保持大行情响应的有界投影

`get_price_history` 和 `get_technical_indicators` 的公共事件继续只保存证券身份、
来源、复权、时间和数据质量，不持久化完整 `bars` 或 `points`。浏览器确定目标后
直接调用现有只读行情 API 获取绘图数据。

这样既能自动显示，又不会让每个 Agent 事件膨胀到完整 120 日行情大小。

### 5.3 历史兼容

- 新 run 可直接从规范化后的 `resolve_symbol` 事件恢复标的。
- 已存在且包含成功行情 artifact 的旧 run，可从行情 artifact 的顶层
  `symbol/code/name` 恢复标的。
- 只有旧 `resolve_symbol` 摘要、且从未成功调用任何证券行情工具的 run 无法追溯
  出被过滤的候选；页面应保持“未取得可绘图标的”，不能猜测。
- 不迁移或重写历史事件与 artifact。

## 6. 前端标的发现与自动加载

### 6.1 图表目标来源优先级

新增独立于候选表的 `chartTargetFromRun()`，按以下优先级寻找最新成功结果：

1. `get_price_history` 或 `get_technical_indicators` 的顶层证券身份；
2. `get_realtime_quote` 的顶层证券身份；
3. 唯一成功 `resolve_symbol` 的规范化证券身份；
4. 对历史 run，使用 evidence，或仅使用 metadata 中带受控工具名的
   `market_evidence` artifact 安全身份。

只有股票、指数或 ETF 且 symbol 通过 canonical 正则校验时才可成为自动目标。
`screen_stocks`、`get_preset_candidates` 的多候选结果和所有板块工具都不参与自动
目标选择；同一优先级出现多个不同证券身份时也保持未选择。artifact 兜底只接受
`get_price_history`、`get_technical_indicators`、`get_realtime_quote` 和严格唯一的
`resolve_symbol`，不会仅凭 `market_evidence` 类型推断用途。

### 6.2 自动加载幂等性

在前端状态中记录至少以下信息：

```text
selectedCandidate      当前图表标的
chartSelectionMode     auto 或 manual
chartAutoLoadKey       run_id + symbol
marketRequest          当前请求序号，用于淘汰过期响应
```

规则：

- 每次新 run 重置自动加载键和选择模式。
- SSE 收到成功证券工具事件后调用 `maybeAutoLoadChart()`。
- 加载历史 run、SSE 重连或 run detail 同步后也调用同一函数。
- 同一个 `run_id + symbol` 只自动触发一次；重复事件和重复 render 不产生新请求。
- 用户点击候选后切换为 `manual`，后续事件不得把图表自动切回其他标的。
- 图表刷新按钮可以显式重试当前标的，不受自动加载键限制。

### 6.3 候选表与单标的解耦

`candidateObjects()` 继续只负责筛选结果。不要通过伪造一行候选的方式修复单标的
图表，否则“候选标的”会把已分析证券误解为筛选命中结果。

单标的名称和代码直接显示在图表标题；候选表没有筛选调用时仍显示“暂无结果”。

## 7. K 线、成交量和均线合并规则

将 `normalizeChartPoints(history, indicators)` 改为显式合并，而不是二选一：

1. 以 `history.bars` 建立按 `date/trade_date` 索引的基础点。
2. 基础点必须保留真实 `open/high/low/close/volume`。
3. 以 `indicators.points` 的同日记录覆盖 `ma5/ma10/ma20/ma30/ma60`。
4. 成交量优先使用 history；仅当 history 当日 volume 缺失且指标 volume 有效时
   才使用指标值补充。
5. 对日期排序并去重；无效 OHLC 点不绘制蜡烛，并产生可见数据质量提示。
6. 不使用 `close` 合成 open/high/low，不绘制伪 K 线。

部分成功语义：

| history | indicators | 页面行为 |
| --- | --- | --- |
| 成功 | 成功 | 显示真实 K 线、成交量和可用均线 |
| 成功 | 失败 | 显示 K 线与成交量，明确提示“均线读取失败” |
| 失败 | 成功 | 可显示指标摘要，但不绘制伪 K 线；提示历史行情读取失败 |
| 空数据 | 任意 | 显示“无有效日线数据”，不绘制占位行情 |
| 失败 | 失败 | 显示可定位错误并保留刷新按钮 |

## 8. 页面状态与可观察性

图表状态至少区分：

- `等待标的`：尚未取得唯一证券身份；
- `已识别`：已取得标的、尚未开始读取；
- `加载中`：正在请求日线和指标；
- `部分可用`：K 线可用但均线失败，或只有指标摘要；
- `已加载`：K 线和可用均线绘制完成；
- `无数据`：接口成功但没有有效日线；
- `读取失败`：行情请求失败，可显式刷新。

页面不得用全局告警覆盖已有 Agent 回答；图表局部错误应在图表区域保留，必要时
再同步一条简短全局告警。错误消息继续通过现有 `errorMessage()` 限定为公开信息。

初始提示建议从“点击候选行查看 K 线与成交量”调整为：

```text
识别到唯一标的后将自动显示；也可点击候选行切换。
```

## 9. 实际影响文件

| 文件 | 计划修改 |
| --- | --- |
| `wolf-dashboard/backend/app/agent_service.py` | 增加工具感知的有界公共投影，规范化唯一 `resolve_symbol` 身份 |
| `wolf-dashboard/backend/tests/test_agent_api.py` | 增加唯一解析、模糊解析、投影限量、历史 artifact 和敏感字段回归 |
| `wolf-dashboard/frontend/agent-market.js` | 新增 chart target 发现、证券身份校验和 OHLCV/MA 合并纯函数 |
| `wolf-dashboard/frontend/agent.js` | 接入幂等自动加载、手动优先、局部状态和合并后的图表点位 |
| `wolf-dashboard/frontend/agent.html` | 调整图表初始提示；如实现需要，增加局部质量状态容器 |
| `wolf-dashboard/frontend/agent.css` | 未修改；复用现有 `.quality-line` 样式 |
| `wolf-dashboard/frontend/tests/*` | 使用 Node 22 内置测试覆盖纯数据选择与合并逻辑，不新增第三方依赖 |
| `wolf-dashboard/README.md` | 说明单标的自动展示、候选切换和部分失败语义 |
| `docs/PROJECT_MAP.md` | 实施后同步前端职责、测试入口和数据流事实 |
| `CHANGELOG.md`、`COMMIT_LOG.md` | 实施提交时按仓库规范记录变更 ID、原因、方法和真实验证结果 |

若为自动测试提取新的前端 helper 文件或增加测试目录，必须在同一实施提交更新
项目全景图；若所有逻辑仍保留在现有 `agent.js`，则只更新行为和验证说明。

## 10. 实施阶段

### 阶段 1：锁定回归夹具与公共契约

1. 用 fake sidecar 事件构造唯一 `resolve_symbol`、模糊解析和成功历史行情场景。
2. 为 Agent 服务增加统一工具数据投影 helper。
3. 规范化唯一证券身份，同时保持集合数量、字段长度和敏感信息边界。
4. 确认完整 bars/points 仍不进入事件、证据和 artifact。

阶段门槛：后端测试证明浏览器能得到唯一 canonical symbol，且大响应和敏感字段
没有被放宽。

### 阶段 2：前端目标选择与自动加载

1. 实现 `chartTargetFromRun()` 和 `maybeAutoLoadChart()`。
2. 在实时事件、run 同步和历史 run 恢复三个入口调用同一自动加载流程。
3. 增加 `run_id + symbol` 幂等键和 manual 优先规则。
4. 保持筛选候选表展示与点击切换行为不变。

阶段门槛：直接单标的问题无需候选表即可发出一次且仅一次图表请求；多候选和
板块 run 不会误选标的。

### 阶段 3：真实 OHLCV 与指标合并

1. 重写图表点位规范化逻辑，以日线为基础按日期合并指标。
2. 删除用 close 合成 OHLC 的降级行为。
3. 实现 history/indicators 部分成功状态和局部警告。
4. 确认成交量柱、蜡烛和 MA 路径使用同一日期坐标。

阶段门槛：夹具中的开高低收原样进入 SVG；均线只叠加、不覆盖真实 OHLCV。

### 阶段 4：端到端验证与文档同步

1. 运行后端、前端纯函数和项目级回归。
2. 使用本地 FastAPI/sidecar 完成一个明确股票的真实 run，并在浏览器验证自动图表。
3. 验证历史 run 恢复、SSE 重连、手动候选切换和上游失败状态。
4. 更新 README、项目全景图、CHANGELOG 和 COMMIT_LOG。

阶段门槛：第 12 节验收矩阵全部通过，且真实运行结果和命令如实记录。

## 11. 自动测试设计

### 11.1 后端

- 唯一 `resolve_symbol` 成功结果投影为顶层 `symbol/code/name`。
- 模糊结果不生成顶层 symbol，候选数量受限且字段受白名单约束。
- `get_price_history` 和 `get_technical_indicators` 仍只投影身份与元数据。
- bars、points、原始 Provider 响应、Cookie、API Key 和任意路径不进入公开记录。
- SSE 事件、run detail、evidence 和 artifact 的证券身份一致。
- 历史工具名和既有 artifact 仍可读取。

### 11.2 前端纯逻辑

优先用 Node.js 22 内置 `node:test`，不增加前端框架或浏览器测试依赖。若需提取
纯 helper，应覆盖：

- 从成功 history、technical、quote 和唯一 resolve 事件选择 chart target。
- 拒绝模糊 resolve、非法 symbol、板块对象和 screener 多候选。
- 同一 run/symbol 的 SSE 重放只触发一次自动加载。
- 用户手动选择后不被后续自动事件覆盖。
- 按日期合并 OHLCV 与 MA，输入乱序、重复日期和缺失值时行为明确。
- indicators 不包含 OHLC 时不会生成伪蜡烛。

### 11.3 API 与浏览器回归

- `/api/v1/quotes/history/{symbol}` 返回可绘制 OHLCV。
- `/api/v1/indicators/technical/{symbol}` 返回可叠加均线。
- `/api/v1/runs/{id}` 对新 run 返回可恢复的证券身份。
- 浏览器重新载入当前 run 后自动恢复同一图表。
- `/skills`、`/monitor` 和板块卡片不受影响。

## 12. 验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| “生益最近一周的走势如何” | 解析为 `sh600183` 后自动显示 K 线、成交量和可用均线，无需候选点击 |
| “分析药明康德上一周” | 自动显示 `sh603259`；最近运行恢复后仍能显示 |
| 输入 `000001` 且解析为多个证券 | 不自动选股，明确提示需要消歧 |
| 单标的只成功调用 history | 显示真实 K 线与成交量，均线缺失有局部提示 |
| history 失败、indicators 成功 | 不生成伪 K 线，显示历史行情失败和可用指标摘要 |
| history 与 indicators 均失败 | 图表显示可定位失败，刷新按钮可重试 |
| 条件筛选返回多个候选 | 不自动选第一只；用户点击后正常切换图表 |
| 用户手动选择候选后又收到 SSE | 保持手动选择，不跳回自动标的 |
| SSE 重连或重复同步 | 同一 run/symbol 不重复自动请求 |
| 板块问题 | 只显示板块卡片，不把 board 当成证券加载 K 线 |
| 旧 run 有 history artifact | 可从 artifact 恢复图表 |
| 旧 run 只有被裁剪的 resolve 摘要 | 不猜测标的，显示无法恢复的明确状态 |

## 13. 验证命令

实施时至少执行并记录真实结果：

```powershell
$env:PYTHONPATH = (Resolve-Path 'wolf-dashboard/backend')
wolf-dashboard/backend/.venv/Scripts/python.exe -m pytest -q wolf-dashboard/backend/tests/test_agent_api.py
wolf-dashboard/backend/.venv/Scripts/python.exe -m pytest -q
node --check wolf-dashboard/frontend/agent.js
node --check wolf-dashboard/frontend/agent-market.js
node --test wolf-dashboard/frontend/tests/*.test.mjs
git diff --check
git status --short
```

若最终未增加 `frontend/tests/*.test.mjs`，必须在交付说明中写明无法自动化的原因，
并记录桌面与移动视口的手工步骤、浏览器结果和实际请求次数。不得把未执行命令
写成已通过。

文档检查至少确认：

- 本计划、README 和项目全景图中的相对链接存在；
- 新增测试命令与实际文件一致；
- 待提交文件不包含 SQLite、日志、构建产物、Provider 凭据或原始大行情导出。

实际执行结果见第 16 节。仓库根目录执行无路径约束的 `pytest` 会误收集同仓库的
`QuantPilot` 项目并因其可选包缺失产生 18 个 collection error；该命令不是
Wolf Dashboard 的正确项目级入口。最终全量回归在 `wolf-dashboard/backend` 目录执行。

## 14. 完成标准

- [x] 唯一证券身份以有界、脱敏、稳定的公共契约到达浏览器。
- [x] 单标的 run 自动加载图表，且每个 run/symbol 最多自动触发一次。
- [x] 筛选多候选、模糊解析和板块问题不会误触发自动选股。
- [x] K 线使用真实 OHLCV；指标只按日期叠加均线，不再合成伪蜡烛。
- [x] history/indicators 的部分失败和空数据均有明确页面状态。
- [x] 历史 run 恢复、目标优先级和失败边界已通过自动化与 HTTP 集成回归。
- [ ] 实时 run、SSE 重连和手动候选切换尚未完成真实浏览器视觉验收。
- [x] 自动测试、项目级测试、JS 语法检查和 `git diff --check` 通过。
- [x] README、项目全景图、CHANGELOG、COMMIT_LOG 与代码事实同步。
- [x] 实施记录列出修改内容、真实验证结果、历史 run 限制和仍存在的风险。

## 15. 风险与回退

| 风险 | 控制措施 |
| --- | --- |
| 放宽投影导致事件膨胀或敏感字段泄露 | 使用工具感知的安全身份投影；候选限量；不全局放行数组 |
| SSE 重放触发请求风暴 | 使用 `run_id + symbol` 幂等键和现有 `marketRequest` 竞态淘汰 |
| 自动选择覆盖用户操作 | 一旦用户点击候选即进入 manual 模式，自动流程不再改写 |
| 指标日期与日线日期错位 | 按标准日期键合并、排序和去重，无法匹配的指标不绘制 |
| 上游部分失败被误报为完整成功 | 图表状态区分完整、部分可用、无数据和失败 |
| 新增 `market_evidence` 工具被误当成图表标的 | artifact metadata 持久化受控工具名，前端仅接受明确白名单工具 |
| 历史 run 无法恢复 | 只使用带工具身份的 evidence/artifact；更早且已裁剪身份的记录明确提示，不迁移、不猜测 |

若实施出现回归，可独立关闭 `maybeAutoLoadChart()` 的自动入口，保留原有候选手动
切换；后端新增的安全证券身份字段保持向后兼容，无需删除历史数据。

## 16. 实施与验证记录

### 16.1 已落地行为

- `_project_event()` 与 `_persist_evidence()` 统一经过工具感知的有界投影；唯一且
  无歧义的解析生成顶层 canonical 身份，模糊结果最多公开 8 个白名单候选，完整
  `bars`/`points` 和敏感 metadata 不进入 SSE、证据或 artifact。
- artifact metadata 记录受控 `tool`，前端恢复时按工具白名单 fail closed；同一证据
  优先级出现多个证券、缺少明确 `asset_type`、解析状态不唯一或 symbol 非 canonical
  时均不自动选择。
- 新增 `agent-market.js`，以日线真实 OHLCV 为基底按交易日叠加均线；缺失 OHLC 的
  bar 被丢弃，指标点不会合成伪蜡烛，重复、乱序和未匹配数据生成局部质量提示。
- Agent 页面在实时事件和 run detail 恢复入口执行幂等自动加载，保留 manual 优先、
  部分成功状态和显式刷新；候选表只消费筛选工具和 `candidate_table` artifact。

### 16.2 已执行验证

- Agent API 定向回归：`18 passed, 1 warning`。
- Backend 全量回归（从 `wolf-dashboard/backend` 执行）：`156 passed, 2 warnings`。
- `node --check wolf-dashboard/frontend/agent.js` 与
  `node --check wolf-dashboard/frontend/agent-market.js`：通过。
- `node --test wolf-dashboard/frontend/tests/*.test.mjs`：`15 passed`。
- 本地 HTTP 集成 smoke：`/` 与 `/static/agent-market.js` 均返回 HTTP 200；历史 run
  `0a9c0acbe51a4e0596c1b95a654769e6` 恢复为生益科技 `sh600183`，合并 120 个日线点，
  其中 116 个具有均线覆盖，无合并告警，数据时点为 2026-09-01。
- `git diff --check`：通过；20 个 Markdown 文件中的 23 个本地链接检查通过；11 个待提交路径
  的安全检查通过，新文件无尾随空白。

### 16.3 尚未执行与兼容性限制

- 未启动交互式浏览器进行视觉检查，因此真实 run 的自动绘图观感、SSE 重连后的
  请求次数和手动候选切换仍需本地浏览器补验；不能把 HTTP smoke 记作视觉验收。
- 旧 run 若只有被裁剪的 resolver 摘要，且 evidence/artifact 都没有可验证的工具名与
  canonical 身份，将保持不可恢复；这是 fail-closed 的既定兼容性边界。
