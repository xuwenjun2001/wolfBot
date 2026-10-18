# 财报变化研究合同 v1

S04 将新合同放在 `src/lib/company-research/{task,document,revision}-contracts.ts`，由现有 `contracts.ts` 导出。新合同 `schemaVersion: 1`；旧研究 JSON 的 `state.version: 2` 是旧运行状态版本，两者没有大小或升级替代关系。`compatibility.ts` 显式区分旧请求/旧报告与新合同，未知新版本直接拒绝，不能回退成 legacy。

## 版本分别表示什么

| 字段 | 含义与规则 |
| --- | --- |
| taskId | 一个逻辑研究请求，actor 私有；修订不新建预算账本 |
| requestRevision | 用户需求快照：身份、两期、截至时间、三问、合并/母公司口径、预算；不可原地改写 |
| plan.revision | 某个需求版本的公开研究步骤快照；引用 requestRevision |
| document.id + version | 原件版本，绑定公司、报告期、bytes hash、披露证据、原件/解析产物引用；原字节和解析版本分别记录 |
| report.revision | 不可变交付快照，绑定 requestRevision 和 planRevision；引用具体文档版本 |
| attempt.id | 某个计划的一次执行；不是 taskId，也不是用户需求版本 |
| generation | 服务端递增执行权 fencing；领取新 attempt 不得重置逻辑任务工具数、tokens、开始时间和 deadline |
| event.sequence | 同一 task 内持久递增游标，用于补放；不是任何业务 revision |

S16 才开放修改需求和安全重规划：使用 expectedRevision 和幂等键创建新快照，到工具边界令旧 attempt 失效，合格证据可复用；不重置逻辑预算。S17 更新资料形成新报告 revision，保留旧报告。S05 先落地不可变关系、冲突检查和执行权基础设施，不宣称完整交互修订已经可用。

## 任务与财务口径

新请求仅接受 financial_change，规范化 A 股 symbol 必须与 exchange 一致。两期有不同 ID、正确起止和年度/半年/季度及累计/单季口径，并按先后排序。默认可比较时必须为相同日历范围和口径；不匹配只能显式登记 incomparable 及原因。三类问题各出现一次，不能靠删除问题提高覆盖率。

所有用户可控字段经严格 schema 校验并进入稳定 JSON 的 SHA-256：更改 asOf、问题、期间、口径、版本或预算都构成不同请求。actor/tenant/project 不接受来自请求正文；由服务端身份派生。HTTP 幂等键不能把不同请求合并。

事实保留原始十进制字符串、元/千元/万元/亿元、人民币、显示精度、报告期、合并/母公司与重述标记。known 的 0、missing 和 conflict 是三种状态；已知/冲突事实必须有引用。营业收入与营业总收入是不同 metric。S09 已实现 decimal-v1 规范化、比较与累计转单季，规则见 [公司研究](../../company-research.md)。每股现金流不能替代现金流总额。

FinancialFact 新增可选 normalization（原始文本、单位标签、精确元值）、sourceQuality、disclosure、accountingBasis 和 derivedFrom，旧事实仍按原合同读取。needs_review 来源不能写成 known；自动表格/扫描块也由报告存储再次检查。schema 核对精度和规范化值，解析不是原文/语义审查的替代。金额 BigInt 十进制计算，百分比 6 位、半值远离零；零基数不产生虚假百分比，负基数使用绝对值分母并标记。

## 原文、时间和引用

文档记录 SHA-256、fetchedAt、verified/unknown 披露状态及核验链接/摘要。日期精度按上海时区当日结束后可用；不知道披露时间的资料不能进入严格历史结论。定位区分 PDF 文件页、印刷页、块、表格单元格和 HTML 块。框坐标仅在真实提供时记录为归一化 box，禁止空框/倒置框或猜测坐标。

受控 artifact 只接受内容寻址 digest key，不能传本地路径。数据库保存元数据/引用，正文和大 PDF 放受控文件存储。原件 key 必须等于 bytes hash；解析产物有独立 hash 和 parser 版本/失败页记录。存储引用本身不授予读取权限。

`reportBindingErrors` 核对任务/身份/期间、文档版本/hash/页、披露截至时间和 fact/claim 引用。传入页正文时还校验原文片段存在性；无原文校验时只表示引用关系通过，不能声称 quote 或语义验证完成。结论保留 fact/inference/opinion 和 supported/evidence_gap/conflict/incomparable。字符串在原文里不等于结论被语义支持。

partial 明确缺口，不冒充 completed。completed 不能有未解缺口，必须覆盖三个问题和两期三项财务事实；口径不可比较的任务不能标 completed。报告引用错误版本、未来/未知日期、错公司、错期间、越页、未知 fact ID 都拒绝持久提交。

## 状态与事件

首版新 task 从 draft 创建；S11 才接入调度执行，旧 Worker 不领取新表。后续合法路径为 draft → queued → running → completed/partial/failed/cancelled。取消保留原件和已有交付；重试使用新 attempt 与递增 generation。恢复继承逻辑 usage，不复播隐藏推理。

事件 envelope 固定 taskId、sequence、request/plan/report revision、attemptId、generation、时间和公开业务 payload。task.created、plan.created、document.registered、attempt.started/finished、report.created、task.cancelled 是当前子集；没有隐藏 reasoning 字段。未来 UI 使用快照加有序事件恢复，AG-UI 适配仍留在 S14。

S04 行为测试覆盖旧合同读取、未知版本、完整请求摘要、非法证券/期间、不可比较、披露精度、0/缺失、引用版本/hash/页/原文、partial 门和不同版本计数。模型质量、OCR、检索和 UI 不在本步验证范围。
