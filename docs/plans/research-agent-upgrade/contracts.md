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

文档报告期和数值所属期分别保存。引用后一期同日历范围报告中的前期重述值时，事实必须标记 restated、给出 accountingBasis，并通过可选 `periodEvidence` 引用该文档真实的年份/列头原文。所有金额引用和期间引用都重新核对版本、hash、定位和 asOf；期间标签存在不等于数字与列的语义归属已经通过 S12。

单季请求只额外允许本季度末及相邻上季度末的同年累计来源，由 `researchEvidencePeriods` 确定完整期间，默认 ID 如 `ytd_2024_06`、`ytd_2024_03`；若与请求 ID 冲突则追加 `_input`。注册、发现、导入、检索与发布共用这份范围。报告可用 `supportingFacts` 保存这些原始输入，`derivedFrom` 按当前累计值、前期累计值顺序引用输入 ID；Q1 只需当前累计值。发布时重算单季值及其期间、口径、引用集合，拒绝缺输入、环、未被使用的输入和结果篡改。输入事实不充当两期最终事实覆盖，旧报告没有这些可选字段仍可读取。

## 原文、时间和引用

文档记录 SHA-256、fetchedAt、verified/unknown 披露状态及核验链接/摘要。日期精度按上海时区当日结束后可用；不知道披露时间的资料不能进入严格历史结论。定位区分 PDF 文件页、印刷页、块、表格单元格和 HTML 块。框坐标仅在真实提供时记录为归一化 box，禁止空框/倒置框或猜测坐标。

受控 artifact 只接受内容寻址 digest key，不能传本地路径。数据库保存元数据/引用，正文和大 PDF 放受控文件存储。原件 key 必须等于 bytes hash；解析产物有独立 hash 和 parser 版本/失败页记录。存储引用本身不授予读取权限。

`reportBindingErrors` 核对任务/身份/期间、文档版本/hash/页、披露截至时间和 fact/claim 引用。传入页正文时还校验原文片段存在性；无原文校验时只表示引用关系通过，不能声称 quote 或语义验证完成。结论保留 fact/inference/opinion 和 supported/evidence_gap/conflict/incomparable。字符串在原文里不等于结论被语义支持。

发布仅接受 ready/partial 文档；unreadable、缺解析产物及 issuer_or_report_year_unverified 均拒绝，只有 claim 没有 FinancialFact 的报告也一样。v2 原始解析回执中的不可用状态再次核对，不能靠文本块仍为 native 绕过文档身份失败。

S10 检索合同把 actor/task 固定在应用上下文，不接受工具修改 asOf。索引绑定不可变文档版本与 parsed hash，先裁元数据，再按可选字段筛选/排序；返回 chunk/block、locator、原文片段与质量，read 分段续读。字段匹配、检索命中和 needs_review 资料都不等于事实核验。实际 API、上限和索引生命周期见公司研究专题。

partial 明确缺口，不冒充 completed。completed 不能有未解缺口，必须覆盖三个问题和两期三项财务事实；口径不可比较的任务不能标 completed。报告引用错误版本、未来/未知日期、错公司、错期间、越页、未知 fact ID 都拒绝持久提交。

## 状态与事件

首版新 task 从 draft 创建；start API 建立初始三问计划并入队，现有研究 Worker 在旧 run 和新 task 间交替领取。合法路径为 draft → queued → running → completed/partial/failed/cancelled。取消保留原件和已有交付；过期接管使用新 attempt 与递增 generation。恢复继承逻辑 usage，不复播隐藏推理；已耗尽预算的接管只封存 partial，不能再调用模型。

事件 envelope 固定 taskId、sequence、request/plan/report revision、attemptId、generation、时间和公开业务 payload。task.created、task.queued、plan.created、document.registered、research.progress、attempt.started/finished、report.created、task.cancelled 是当前子集；没有隐藏 reasoning 字段。SSE 每次连接首先发送权威 snapshot，事件仅使状态失效，后续快照恢复完整数据。客户端拒绝旧任务、旧 generation 和倒退序号；切换任务撤销请求并关闭旧连接。当前采用原生 SSE，不声明 AG-UI 协议兼容。

## 执行、审查与人工验收

checkpoint v1 保存公开计划进度、事实、结论、有界来源观察、覆盖检查摘要及停止原因。写入与报告提交均受同一 attempt 的租约和 generation 约束；模型请求前预留未知 usage，收到有效回执后再结算。公开模型上下文从 checkpoint 重建，引用预览截断会显式标记，完整原文继续按 locator 读取。工具 schema 使用输入语义，省略带默认值的参数不会在 PI 层被误拒绝。

逐 claim 的语义回执绑定 task/request/plan/asOf、该结论和其依赖事实的 hash；修复其他结论不使无关回执失效。数字检查、引用原文和语义支持分别判定，直接调用报告 repository 也要通过这些门。当前 calibrated reviewer 为同模型单独调用，记录模型、提示词校准与真实独立性；无校准、冲突或不足都不能升级为 supported。复杂原生多列、未经业务复核的 OCR 仍保留缺口。

报告 method 可选，存量报告不要求补填。新报告保存模型、Skill、工具、合同与资料 hash；三问和六项金额覆盖的分母固定。自动 completed 表示机器核验完成；人工验收由认证用户显式确认数字和解释，绑定不可变 revision/hash 并另存表，不改写报告，也不注册为模型工具。旧参考答案的人工确认不等于新生成报告已被用户验收。

source API 从所选报告 revision 或公开草稿（0）的 fact/claim 引用解析原文，不接受任意路径、用户或“最新版本”替换。先授权，再按文档版本/hash 取解析产物并重新核对 quote。阅读器按 React 文本和表格呈现，仅逐字匹配高亮；无坐标提示使用文本定位，OCR needs_review 和未知披露状态保留。外部链接仅展示不含凭据的 http/https URL，原件下载仍走授权接口。

S04 行为测试覆盖旧合同读取、未知版本、完整请求摘要、非法证券/期间、不可比较、披露精度、0/缺失、引用版本/hash/页/原文、partial 门和不同版本计数。模型质量、OCR、检索和 UI 不在本步验证范围。
