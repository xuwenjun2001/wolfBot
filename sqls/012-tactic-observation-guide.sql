-- Editable public observation notes, versioned separately from screening parameters.
CREATE TABLE IF NOT EXISTS quant.tactic_guides (
  tactic_id text PRIMARY KEY REFERENCES quant.tactic_configs(id),
  content text NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 20000),
  version integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL DEFAULT 'system',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO quant.tactic_guides(tactic_id,content) VALUES
('ma55-breakout-pullback', $guide$入池后如何观察

一、先确认观察窗口
突破日记为B，随后两个市场交易日为B+1、B+2。优先观察B+1，最迟到B+2收盘，周末和节假日不计。漏运行后补入的股票只有剩余窗口，重复筛选不续期。观察池是候选名单，入池不等于买入信号。

二、次日开盘和盘中：人工看盘
先看MA5 > MA10 > MA20的趋势是否仍保持，再观察价格与日MA55的关系。原战法重点是突破后的第二天（最多第三天），开盘较快向下击穿55线；若大盘同时回落，结合市场环境观察。关注下穿后是否止跌、分时转向，以及能否回抽55线，不把“碰线”或“跌破”本身当成必然反弹。
原作者认为，开盘下穿后当天回抽较强，尾盘介入后次日回抽次之；延迟回抽但没有明显放量下跌时继续观察。这是待验证的经验描述，不是胜率承诺。

三、尾盘与收盘复核
观察成交量是否较突破日收缩、价格是否回到55线附近，以及多头排列是否保持。平台当前默认回踩条件为：成交量不超过突破日80%，收盘距MA55在−3%至+1%，且MA5 > MA10 > MA20。修改筛选参数后，应以事件入池时冻结的参数版本为准。
每个观察日收盘后，手动运行筛选，用新的日K更新回踩、趋势失效和到期状态。个股缺数据时跳过并展示原因，不用旧行情确认新信号。

四、失效、到期与交易纪律
多头排列失效或转ST时，不再按原趋势继续观察；停牌仍消耗市场交易日。B+2收盘后退出有效池，即便当天才出现回踩，也不会为原事件延长观察期。
若自行交易，应在下单前明确仓位、定量止损和退出条件，避免因期待55线吸引而无限期持有。上方可人工参考更大级别均线、前高等压力位置；它们不是自动卖出信号。A股当日新买仓位受T+1约束，不能假定可当日卖出。

五、当前平台会做什么
目前仅提供收盘选股、日线跟踪和按时到期。盘中页面刷新不会实时计算下穿或反弹，不会自动监控分钟买点、推送买卖提醒或下单。15:00前点击筛选使用最近已收盘交易日的数据。
原文的15分钟55线做T属于另一个盘中观察方法，当前未实现；上述盘中判断需要自行看盘。

这份指引可以编辑，供平台用户共同查看；编辑文字不会改变筛选公式、公共参数或股池有效期。$guide$)
ON CONFLICT(tactic_id) DO NOTHING;
