# 固定财报与评测合同 v1

冻结于 S02、候选开发前。研究专用输入在 `fixtures/company-research/`，不与看板 benchmark 共用成绩。评分合同为 `rubric.json`，SHA-256 `81df0d53f38650a955957896c6c9883030588dc455cb482b95eff2ac7e0f0d45`。任何评分或任务分布变更必须另起版本，重建可比基线。

## 资料与答案状态

共 6 家公司、12 份 2023/2024 年年报，来自巨潮官方公开披露。开发集 4 家：贵州茅台、五粮液、美的集团、万华化学，8 份原件、12 个问题。`documents.json` 记录原始 URL、公告 ID、披露日期及其 API 证据、bytes SHA-256、页数、取得时间与解析准备版本。禁止将抓取时间或报告期当披露时间。官方仅提供日期，严格时点统一按上海时区披露日结束后可用，asOf 冻结为 `2025-06-30T15:59:59.999Z`。

开发答案 `development.json` 包含 24 个两期原始数值、12 个变化百分比、8 处风险原文定位与解释。金额保留原单位，引用标 PDF 文件页码，不编造坐标；例如美的 2024 文件第 9 页、印刷第 8 页，单位是千元。同比为 `(本期-基期)/abs(基期)`，基期零值不适用；财务口径均为合并、人民币、累计。

这些答案经过本会话逐段原文核对及确定性校验，状态是 `source_checked_agent_reference`；**尚无独立人工签字，human golden 数量为 0**，用于诊断和准备，不作为已通过人工金标验收的准确率。茅台/美的关键表页还做了渲染检查。保留集 2 家/4 文档/6 问题在受控仓库外路径，通过 `RESEARCH_HOLDOUT_ROOT` 定位，仓库仅保存数量与清单摘要，答案标注明确 pending。后续人工可按资料清单逐项复算；签字前不得把 pending 改称 golden。评测准备的完成与 S13/S20 的人工质量验收分别记录。

开发与保留按公司和文档版本完全分离。验证器检查外部原件 hash、任务清单 hash 和公司交集，不输出保留题。保留答案不进入模型上下文或调优。若将保留失败用于优化，应重新划分未见集合。

## 困难样本

`adversarial.json` 固定 9 项：真实表格/千元单位、真实文件页面派生的图像 PDF、期间不匹配、冲突数值、缺证、未来资料、未知日期、跨用户读取、资料内指令。派生扫描件是受控退化，**不是原始扫描年报**；原件、原页、生成方式、bytes hash 在 `derived-scan.json`。无文本层已由 pypdf 核实。人工构造的冲突、缺失和时间元数据变化均标 synthetic，不能算真实业务分布或增加公司数。

这些是固定的验收输入，S02 不声称 OCR、对抗处理或权限功能已经通过；对应实现由 S04—S18 的行为测试与真实链路完成验证。

## 计分与门槛

| 项目 | 分母与目标 |
| --- | --- |
| 数值正确 | 两期收入、归母净利润、经营现金流及三项变化，共每公司 9 项，开发集 36 项。缺答计错；金额容差为原表最小显示单位一半，百分比容差 0.01 个百分点。目标 ≥95% |
| 证据支持 | 全部实质结论为分母，独立人工或校准 judge 核查语义支持；同时查必需问题覆盖。零结论为不可计算且未完成。目标 ≥90% |
| 任务完成 | 12 个开发问题全部入分母；partial/failed/cancelled/unsupported 不算完成。目标 ≥80%，逐项公布原始数量 |
| 硬门 | 公司、actor、已核实 asOf、文档/hash/定位、引用、期间口径和资料指令边界逐项全过；不得用平均分掩盖已知失败 |
| 耗用 | 分开记录端到端、工具、模型请求、tokens/估计/缺失、失败阶段；不获知价格就标 unknown。成功为零时每成功任务成本不可计算 |

只对完成独立人工核查的结果报告验收准确率。服务失败、模型前失败、模型拒绝、能力不支持分别登记；冻结开发题不因失败移出分母。旧链路无法接受双期问题时标 unsupported，不包装成同题准确率提升；S13 才建立完整能力基线。

S03 预登记预算：模型 `gpt-5.6-luna`、reasoning `max`，开发每公司一次，12 工具/360 秒；先一个校准运行，校准明确独立标签，不用于比较。固定资料回放与真实网关调用分别标明，不能把资料回放称为真实搜索 E2E。完整产品默认 40 工具/20 分钟不因此改变。

## 复验与恢复

```powershell
python scripts/research/collect-fixtures.py --restore-manifest fixtures/company-research/documents.json
Copy-Item fixtures/company-research/documents.json data/research-agent-upgrade/dataset-v1/development/manifest.json
node --import tsx scripts/research/extract-fixtures.ts data/research-agent-upgrade/dataset-v1/development/manifest.json
node --import tsx scripts/research/verify-fixtures.ts
```

原件取得后，提取器会写本地页缓存；冻结的 tracked manifest 原则上不重写，恢复时先复制到本地清单再传给提取器。持有外部集合时设置 `RESEARCH_HOLDOUT_ROOT` 后再验证。不要重新采集“最新年报”覆盖冻结版本；源站返回不同 bytes 时必须停止。扫描件及完整证据随受控归档恢复，缺少时验证器明确失败，不静默跳过。

S02 实跑：8 个开发原件/24 原始数值/32 引用/12 唯一问题均验证通过；2 家外部保留集原件、任务摘要及拆分验证通过。原件和验证输出位于 `data/research-agent-upgrade/`，归本升级任务所有，保留至 S20 及归档；外部保留集由评测维护者管理，不随普通 tmp 删除。独立人工标注和最终模型质量验收仍待执行。
