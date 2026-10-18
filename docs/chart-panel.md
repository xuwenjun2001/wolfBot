# 项目看板交互图表

标准“K 线与量价结构”模块使用独立客户端 SVG 组件，固定纵向排列价格、成交量、成交额。三块图共享时间坐标、悬停参考线和数值浮层；支持鼠标、触屏点选、方向键、Home/End/Escape。

## 数据与时间口径

- 日线读取项目 `data_file/final/dashboard-data.json` 快照，显示最近60根，使用完整序列计算 MA5/10/20/60。
- 日线请求 `GET /api/v1/quotes/history/{symbol}?period=daily&enrich_amount=true` 时补充金额和比较日期。先查询本地未复权日线，再使用已实测的百度股市通历史成交额，仍有缺口时请求东方财富；仅按同一证券与日期补充金额，不改原 OHLC、成交量或复权口径。
- 百度补充仅用于沪深股票。接口使用固定参数与经过验证的市场代码，响应按 `keys` 定位日期和 `amount`，拒绝冲突日期、缺少必要字段和异常结构。金额以十进制元解析，真实零值保留，负数、非有限数和占位符不补入。百度原始成交量为股，不用于覆盖腾讯原有按手计的成交量。该源一般不回显证券代码，因此来源证据明确记录请求绑定的身份校验方式。
- 原始日线字段不变，`bars[].metadata.previousTradeDate` 指向已核验的上一交易日，`amountEvidence` 记录补充金额来源及时间。响应 `metadata` 增加 `chartDataVersion`、`amountUnit`、`volumeUnit`、`amountCoverage` 和 `chartWarnings`。
- 金额补全版本 `amountEnrichmentVersion=2`，`amountSources` 列出实际使用的金额来源；界面独立显示成交额来源和覆盖数。价格来源仍按原数据展示。
- `GET /api/v1/quotes/session/{symbol}` 返回 `SecuritySessionResponse`。通过项目 `/api/market/quotes/session/{symbol}` 获取，沿用 quotes 读取和预览网络桥接边界。明确市场代码优先，例如 `1.000001` 为上证，`0.000001` 为平安银行；支持沪深股票、ETF、指数，北交所暂不支持。
- 分时首次切入加载，此后仅手动刷新。服务按证券合并请求，独立缓存60秒，最多256项；同一应用实例内生效。刷新失败时客户端保留原数据和获取时间。
- `rows` 包括价格、分钟成交量、分钟成交额、累计成交额、上日同时点累计、差额、变化率及未完成标志。金额单位元，东方财富分时成交量单位手。
- 分时采用源返回的单分钟量额，09:30开盘节点包含源记录的集合竞价量额；只对完整连续前缀累计，午休不计入。缺少开盘或中间分钟不补零、不跨缺口推算。上日金额为零时变化率为空。
- 优先使用完整维护的交易日历；缺少日历时，使用独立上证指数实际日线观测核验前后交易日。不能使用个股自己的稀疏日期序列推断上日。无足够覆盖时不计算比较。
- 原生行情看板的指数接口不变；此模块不引入数据库迁移、自动轮询或任意历史分钟回放。

## 模板升级与回滚

```powershell
node --import tsx scripts/ops/upgrade-chart-panels.ts
node --import tsx scripts/ops/upgrade-chart-panels.ts --apply --enrich
node --import tsx scripts/ops/upgrade-chart-panels.ts --project=PROJECT_ID --rollback
```

默认仅预览。应用时只识别标准 `TrendChart` 函数，跳过其他模板及已定制的交互图表。升级备份保存在项目 `.chart-panel-upgrade/manifest.json`，每次写入前保存原文件和哈希。回滚前核验所有文件，遇到升级后的用户修改则拒绝覆盖。

金额补充证据保存到 `evidence/chart-amount-enrichment.json`。金额覆盖不足会报告，不使用价格乘成交量估算；上游恢复后可重复执行 `--apply --enrich`。生成和模板恢复都会安装独立 `app/components/ChartPanel.tsx`。

## 验证

```powershell
uv run --project services/market-data pytest -q services/market-data/tests/test_chart_data.py
npx vitest run src/lib/utils/chart-panel.test.ts src/lib/utils/scaffold.test.ts src/lib/quant/validation-dashboard-restore.test.ts
node scripts/checks/check-chart-panel.js http://localhost:3110
```

浏览器脚本针对运行中的标准项目验证真实日线组件，并使用明确的分时测试响应验证请求次数、失败保留与交互。截图输出到 `tmp/chart-panel-qa`。该测试响应不写入项目数据，不能作为上游可用性证明。

## 战法详情复用

渲染源统一在 `src/lib/utils/scaffold-chart-panel.ts`；执行 `node --import tsx scripts/build/sync-chart-panel.ts` 同步生成 `src/components/quant/PriceVolumeChart.tsx`，请勿单独修改生成文件。`averagePeriods` 可配置，原看板默认 MA5/10/20/60 不变。`loadData(mode, refresh, signal)` 适配战法独立缓存，存在该适配器时首次进入和切换视图只读缓存，刷新按钮仅刷新当前视图，无自动轮询。

战法传入 MA5/10/20/55/60/233，完整历史计算后取最近60根。MA55为琥珀色、MA233为粉色，图例和悬停值同步；窗口不足显示“— / 历史不足”。价格纵轴包含所有均线，鼠标、触摸、左右键/Home/End联动三图；Escape收起提示。刷新失败保留图表和获取时间，关闭/切换详情会中止旧请求的界面更新。
