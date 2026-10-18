# wolfbot SQL Bootstrap

`sqls/` 保存 wolfbot 组件第一次使用时需要的基础数据库对象。所有 SQL 都应保持可重复执行，方便 Docker 首次建库、已有本地库补齐和后续部署检查。

## 执行顺序

| 文件 | 组件 | 说明 |
| --- | --- | --- |
| `001-quant-timeseries.sql` | TimescaleDB / quant schema | 创建 TimescaleDB 扩展、`quant` schema、股票 K 线、因子、策略信号和组合快照 hypertable |
| `002-quant-research-platform.sql` | 策略研究 / 入库 / 回测 | 补齐证券主数据、股票池、入库任务、同步水位、回测任务和示例 A 股研究池 |
| `003-split-stock-etf-universes.sql` | 策略股票池治理 | 幂等拆分 A 股股票池与 ETF/指数池，只调整池成员，不删除历史 K 线 |
| `004-enrich-stock-bars-fields.sql` | 行情字段增强 | 将振幅、涨跌幅、涨跌额和换手率提升为正式列，并从历史 metadata 回填有效值 |
| `005-enrich-stock-bars-daily-context.sql` | 日频上下文增强 | 将前收盘、交易状态、ST、涨跌停标记提升为正式列，并补齐估值因子查询索引 |
| `006-enrich-security-sector-metadata.sql` | 证券主数据增强 | 将行业、地区、概念和板块标签提升为证券 metadata 的稳定字段 |
| `007-quant-foundation-components.sql` | 基础组件 | 创建交易日历、因子定义、数据质量扫描和通用平台任务表，并登记核心因子口径 |
| `008-realtime-quote-snapshots.sql` | 实时行情隔离 | 创建未复权实时快照表，防止盘中观察值覆盖正式复权日线 |
| `009-canonical-stock-bars-repair.sql` | 正式 K 线治理 | 归档并迁移历史快照污染，建立正式 K 线统一视图并重建覆盖状态 |
| `010-dashboard-index-sessions.sql` | 行情看板量额归档 | 保存四项指数前五交易日加当日分钟量额，支持昨日与MA5比较 |
| `011-tactics-platform.sql` | 战法平台 | 公共参数、可恢复运行、逐股快照、短期观察事件与评估证据；由Python行情服务统一事务管理 |
| `012-tactic-observation-guide.sql` | 战法观察指引 | 公共可编辑观察文字，独立版本和修改人；幂等初始化默认指引，不覆盖用户编辑 |
| `013-tactic-chart-cache.sql` | 战法图表缓存 | 按证券、视图及行情参数持久化完整行情响应，不修改筛选证据 |
| `014-tactic-incremental.sql` | 战法增量采集 | 窗口全量基准日期、口径版本与逐股采集诊断；保留旧价格 |

主业务表由 Prisma 维护，不在这里手写：

| 组件 | 表 |
| --- | --- |
| 项目与对话 | `projects`、`messages`、`sessions`、`tool_usages`、`user_requests` |
| 环境与集成 | `env_vars`、`service_tokens`、`project_service_connections`、`commits` |
| 平台配置 | `platform_settings` |
| 策略平台 | `strategy_scan_runs`、`strategy_scan_jobs` |
| 评测平台 | `eval_runs`、`eval_queue_items`、`eval_repair_tickets`、`eval_schedules` |

## 本地初始化

首次使用推荐：

```bash
npm run db:up
npm run db:init
npm run db:doctor
```

`npm run db:init` 会按顺序执行 `sqls/*.sql`，然后运行 `prisma db push` 同步 Prisma 管理的应用表。已有数据库也可以重复执行该命令。

表字段、来源和页面使用位置见 [数据字典](../docs/data-dictionary.md)。如果新增 SQL 表、字段或因子定义，需要同步更新这里和数据字典。

## 规则

迁移 `015-tactic-reviews.sql` 新增55线自动日程、复盘任务与表现快照、版本化提示词、日报及本地知识片段。表归Python战法服务管理，不建立重复Prisma模型；已有业务数据不覆盖。操作说明见[收盘复盘与日报](../docs/tactic-reviews.md)。

- SQL 必须使用 `IF NOT EXISTS` 或等价方式，避免重复执行失败。
- 时序、大批量行情和策略信号表放在 `quant` schema。
- `stock_bars` 的唯一口径包含 `symbol + timeframe + adjustment + ts`，避免前复权、后复权和不复权数据互相覆盖。
- 平台主业务表继续先改 `prisma/schema.prisma`，再通过 Prisma 生成数据库结构。
- 后续若引入 Redis、对象存储或 ClickHouse，只把 PostgreSQL/TimescaleDB 相关 SQL 放在这里。
