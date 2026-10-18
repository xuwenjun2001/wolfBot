# 55线收盘复盘、日报与知识库

在 `/tactics-platform` 的“收盘复盘与日报”查看 B 池、胜率、日报、知识库及提示词设置。

## 启用与日程

已有数据库增量应用 `sqls/015-tactic-reviews.sql`，然后重启行情 API 和 `npm run worker:tactics`。新环境 `npm run db:init` 按顺序包含此迁移。迁移不修改原有事件、筛选参数、观察指引和图表缓存。

worker 默认上海时区交易日 18:00 排队全主板筛选，成功后创建复盘任务，数据齐备后创建日报任务。日程可在页面修改或暂停；未启用日程仍可手动复盘。关闭页面不停止后台任务。独立启动 worker 也能读取 `.env.local` 中的 `DEEPSEEK_API_KEY`；仅报告执行器加载该凭据，不扩大普通行情 API 的环境白名单。

数据缺口每五分钟重试到当日22:00；期间保存部分统计，截止后可生成带覆盖信息的部分日报。公共筛选失败不会伪造当日扫描结果。任务用数据库唯一索引、120秒租约和发布前校验防止重复执行；LLM失败不回滚行情统计。管理台原有“运行收盘筛选”负责新增候选，“运行收盘复盘”负责补齐已有事件并生成日报。

## 胜率口径

B为突破日，以同源前复权B收盘为基准，分别计算B+1、B+2收盘变化。主指标为B+2上涨比例；大于零计胜，持平计入有效分母。停牌、缺数据、未到期分别统计。价格是研究比较基准，不是买入成交价，不计交易成本。

样本按战法、证券、突破日期去重。B+1开盘之前已首次发布的事件为“实际跟踪”，之后为“事后识别”；主指标默认只使用实际跟踪。趋势失效/ST并不删除价格表现。报告按参数版本和来源分组，统计页允许切换过滤；全部版本会展示合并结果。

各期限独立评估：B+1停牌不阻止有合法端点的B+2价格变化。窗口极值需要完整有效窗口。取数采用完整同源窗口，禁止混合前复权基准。回放旧日期不覆盖较新评估，报告快照不可变。已完整到期的样本不因每日运行重复取数。

## 日报与提示词

DS V4.1 Flash：官方 `https://api.deepseek.com/chat/completions`，模型 `deepseek-flash`，thinking开启，`reasoning_effort=max`。这是战法专用配置，不改变聊天默认模型。

业务提示词纯文本编辑，支持保存新版本、取消、恢复历史版本；带expected_version的乐观锁防止覆盖他人修改。固定系统约束只读。任务创建时冻结业务及系统提示词、行情快照和引用。每份日报“本次生成依据”展示实际输入，不显示密钥或模型隐藏思考过程。

报告输出受结构校验和事件/引用/标签白名单约束。数字事实由程序统计；自然语言分析和策略建议仍属于模型研究观点。不给模型调用配置接口的工具。一个任务最多三次传输尝试，单次600秒总截止，输出或结构错误不发布。空池保存程序摘要，无模型调用。

## 本地日报知识库

每次成功生成同步保存报告原文、摘要、章节索引和全部版本。最新有效版本参与检索，停用引用后不会回退到同日旧版本；保留原文与引用审计。知识库搜索支持日期及正文关键词。

每次注入最近5份摘要（每份最多800字符），再从较早报告中取最多8个片段（每个最多1500字符、每份报告最多两个）。匹配优先级为同事件、同股票、同版本同规则、其他版本同规则，同级优先近期。按正文去重，历史正文合计最多16000字符。无向量服务及额外embedding调用。

历史报告日期必须早于目标日，版本生成时间不得晚于目标日收盘。因而今天补写的昨天日报，不会用于重新生成今天收盘时点的知识上下文。该规则防止补跑和修订引入未来信息。当前没有历史知识时正常生成，所有实际注入的引用及正文随任务冻结。

重复建议不视为独立证据，日报须讨论新样本支持或反例。程序单独计算B+1收盘回踩至B+2收盘的变化，不用回踩之前的收益证明回踩有效。B+2后的表现未跟踪。

## 验证

```powershell
$env:TACTICS_TEST_POSTGRES='1'
services/market-data/.venv/Scripts/python.exe -m pytest -q services/market-data/tests/test_tactic_reviews.py services/market-data/tests/test_tactic_reviews_postgres.py
npx vitest run src/app/api/quant/tactics/reviews/route.test.ts
npm run check:tactic-reviews
```

真实指定日期复盘（会写本地战法数据，`--with-report`会调用模型）：

```powershell
services/market-data/.venv/Scripts/python.exe -X utf8 scripts/checks/run-tactic-review-once.py --day 2026-09-09 --with-report
```

API扩展在 `/api/quant/tactics/reviews` 与内部 `/api/v1/tactics/reviews`。GET支持day、start、end、origin、version、search、report。POST的action为run、regenerate、prompt、schedule、knowledge。内部接口继续要求管理员令牌；浏览器读取需quant.data.read，任务需quant.strategy.run，提示词/日程/引用管理需quant.strategy.manage。
