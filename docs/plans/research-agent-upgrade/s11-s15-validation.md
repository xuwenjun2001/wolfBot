# S11—S15：实现与验收证据

2026-10-19，本轮把双期财报研究接入现有 PI 和研究 Worker，并交付可查原文的工作台。最终代码在固定公开 PDF 上通过完整案例和资料不足案例；用户随后对绑定的新报告回复“已逐项核对，通过”，人工确认与 S13—S15 依赖已结清，见文末记录。当前步骤状态统一看 [progress.md](progress.md)，启动、配置和 API 看 [公司研究专题](../../company-research.md)。

## 本轮交付

## Review 修复回归（E-REVIEW-02）

本轮针对 S11—S15 review 复现的四项缺陷完成修复。`numeric-evidence.ts` 统一处理财务标签、完整金额 token、括号/Unicode 负号及全角数字，并要求金额与明确年份列绑定；`document-store`、导入和解析服务在 artifact 写入后、metadata INSERT 前复核受信 attempt，取消/接管/租约过期的旧执行不能发表文档；`evidence-text.ts` 将 NFKC/空白归一引用映射回原始 UTF-16 偏移，长文本上下文正确，只有逐字命中才高亮。

定向命令 `npm run test:unit -- src/lib/company-research src/app/api/company-research/tasks src/app/company-research/financial` 退出 0：121 passed、36 DB skipped。`npm run test:research:postgres` 退出 0：6 个测试文件、36 passed；其中包含倒序年份/负数发布拒绝、取消与接管 fencing、下载中取消、artifact 写入后租约过期和长引用阅读器的 7 个真实数据库回归。`npm run type-check` 与定向 ESLint 退出 0。固定 G0 报告确定性回放保持完整案例 6 known facts/14 citations、资料不足案例 3 known facts/7 citations，均无错误；没有重跑模型或改变人工验收。

证据原件保留在 `data/research-agent-upgrade/evidence/review-s11-s15-fixes/20261019-01/`，包括单测、PG、types、lint、module 和 replay 日志；PG 演练 manifest 为 `S05/rehearsal-4dd1a779-f1b4-4317-be4b-b91129d1cb13/manifest.json`，测试容器已清理。模块边界检查仍只报告原有三个超限文件；本轮未运行完整构建/CI、真实模型重跑、新浏览器截图、保留集或生产部署。

| 步骤 | 实现 | 验证边界 |
| --- | --- | --- |
| S11 | 三问公开计划、受信工具、持久检查点、预算/截止时间继承、取消/fencing、无进展停止；复用同一 PI loop/Worker | 真实数据库恢复与预算反例、真实模型三问路径通过；真实进程中断矩阵留 S18 |
| S12 | 身份/asOf/原文、金额单位/期间列、冲突、独立调用语义审查；发布入口强制核验 | 数值及发布反例、局部修复、真实 reviewer 校准通过；审查为同模型独立调用 |
| S13 | 确定性变化表、三问/六金额固定分母、partial、方法/版本、独立人工验收接口 | 完整/不足两例真实通过；用户已逐项核查绑定新报告通过，独立回执留存 |
| S14 | 新工作台、legacy 入口、权威快照/SSE、序号/generation/epoch、刷新/切换/断线恢复 | 状态单测、API 合同与真实浏览器事件回放通过；完整 Next/auth/live Worker 旅程未运行 |
| S15 | 按原引用的版本/hash 读取、逐字高亮、真实单元格/坐标、OCR/时间质量说明、安全文本与外链 | 原生 PDF、S08 真实 OCR 派生扫描、跨 actor 拒绝及合成恶意文本通过 |

执行代码在 `src/lib/company-research/financial-*`、`execution-*`、`claim-*`、`report-assembly.ts`、`source-reader.ts`，界面在 `src/app/company-research/financial/`。追加迁移 `20261019130000_research_execution` 保存公开检查点、不可变审查和人工验收；应用/生产库没有迁移。

上下文先保留可用原文，超过 32k 输入预算才使用更紧凑视图；完整检查点和原文不变。覆盖检查全部通过后强制进入提交，部分覆盖仍允许补证。最后两次修复解决的是原文被重复事实挤出、完成检查反复循环，不降低业务核验标准。

## 最终真实运行：G0 绝对基线

模型 `gpt-6.1-sol`、reasoning `high`，Skill `financial-change-v2`、工具 `financial-tools-v2`、合同 `financial-change-v1`。每个逻辑任务仍为 **40 次工具 / 20 分钟**，上下文 32k 输入 / 6k 输出。固定资料为贵州茅台 2023/2024 年完整公开年报及保留的 S07 解析；asOf 为上海时间 2025-06-30 日末。研究使用真实 PI、模型、检索和 repository，没有替换为参考答案，没有运行实时公告发现。

最终目录：`data/research-agent-upgrade/evidence/S13/2026-10-19T06-06-19-135Z/`。

| 场景 | 任务 / 结果 | 工具 | 必需金额 |
| --- | --- | --- | --- |
| 完整双期 | `a316d272-71e8-4ec2-a793-6d5475b9b8c3`；completed；三条解释均被审查支持 | 24/40 | 6/6 |
| 缺后期资料 | `cf1d6b73-7549-420a-bbf0-c5ef4f680b51`；partial；不补造 2024 年金额和解释 | 27/40 | 3/6，缺失继续计入分母 |

完整案例耗时 204071 ms，输入 388673 / 输出 6788 Token、unknownModelRequests=0。用量包含生成与审查，失败尝试另存；实际费用 **unknown**。本机单次结果不能作为生产性能或总体准确率。

| 指标（合并、全年累计、人民币元） | 2023 | 2024 | 精确增幅 |
| --- | --- | --- | --- |
| 营业收入 | 147693604994.14 | 170899152276.34 | 15.711951% |
| 归母净利润 | 74734071550.75 | 86228146421.62 | 15.379966% |
| 经营现金流净额 | 66593247721.09 | 92463692168.43 | 38.848450% |

金额来源为两份年报文件第 5 页。现金流解释引用 2024 年报第 9 页，同时保留销售收现增加与财务子公司归集集团其他成员单位资金增加；不能全部归因为主营回款。风险引用 2023 年报第 21 页、2024 年报第 22 页：四类风险延续，管理措辞改变不等于风险下降/消失。

完整报告 canonical hash：`22bc9651bcc672ec227fd1af1205e351525f19342097f2cb77b9546ee88d3be5`；同目录 `report.json` 中的 `reportSha256` 是另一种序列化文件 hash，不混用。`human-review.md` 直接摘录此报告，提供六金额、三段解释、原件链接及版本/hash；原材料保留确认前的 pending，用户后续确认见文末独立回执。未修改历史 snapshot 或向应用/业务库补写验收。

原件 SHA-256：2023 `2125ff97a452ea79b0d784e2432f7d224b6aecc330b644b593477d69e22f4ed1`；2024 `5299f4940e2ce4e91084b73dc457d558b9d335fa76fbfee6227e4254eb7f4a30`。人工参考确认 `2995da80c309a7852ad9a866f1db26b0808c63ed336eb1f68e29699eb16ff427` 和 rubric `81df0d53f38650a955957896c6c9883030588dc455cb482b95eff2ac7e0f0d45` 保持不变。未读取保留集。

## 开发失败与审查校准

七轮均为两个固定开发场景，修改过实现，属于开发调试，不是同一算法重复 7 次，也不与 S03 不支持的新能力计算改善率。以下目录均位于 `evidence/S13/`；原始 snapshot、工具轨迹、用量和失败不覆盖。

| 批次（UTC 目录） | 完整案例 | 不足案例 | 主要发现 |
| --- | --- | --- | --- |
| `05-19-41-904Z` | partial，40 次，3/6 | partial，40 次，1/6 | 观察被元数据/截断占据 |
| `05-26-20-148Z` | partial，40 次，1/6 | partial，40 次，2/6 | PI 输入默认参数和局部结论保存错误 |
| `05-39-42-716Z` | partial，18 次，5/6 | partial，39 次，3/6 | 重复事实造成 32k 上下文超限 |
| `05-46-14-989Z` | completed，39 次，6/6 | partial，21 次，3/6 | 首次完整成功，后续变更另行复验 |
| `05-50-36-716Z` | partial，40 次，6/6 | partial，40 次，3/6 | 过度压缩损失原因/完整风险清单，审查拒绝 |
| `05-58-17-811Z` | partial，27 次，6/6 | partial，22 次，3/6 | 三问通过后重复覆盖检查，被无进展保护停止 |
| `06-06-19-135Z` | completed，24 次，6/6 | partial，27 次，3/6 | 最终执行代码通过 |

目录日期前缀均为 `2026-10-19T`。同目录 `development-experiments.json` 汇总 14 个任务，SHA-256 `7cc52eeb1e557e99ef01142261714f78d8100b04c7942fb074348d462d25a06b`；首两轮曾把 cache_estimated 缓存分类误计为整次 usage unknown，旧记录保留，后续已修正。

审查校准原件 `evidence/S12/2026-10-19T05-12-55-698Z/calibration.json`，SHA-256 `06508863de6498a109d794d44c74b030a0ab51fb6faf7c68e8fd1aec9543d350`。2 个正例和 6 个反例全部通过，覆盖相反含义、错误公司/期间/单位、无依据因果和风险消失。回执绑定模型和 reviewer prompt hash；后续仅改生成上下文和提交控制，reviewer prompt 未改。这是有限开发校准，不冒充不同模型审查或全分布语义准确率。

## 验证与环境交接

最终单测 `s11-s15-unit-closeout2.log`：113 passed、29 DB 默认 skipped；真实 DB 由专用 runner 另行 29 passed。types、定向 ESLint 和 QA JS ESLint 退出 0；docs/差异结果见 progress 的最终归档。没有改依赖或放宽门禁。

真实模型所在 PG 演练 `S05/rehearsal-002e3f6c-437a-4e26-856d-4e5a4f6969f3/manifest.json`，SHA-256 `212578e1b78e166e06bd6e39caf51e5b36f02a2c857feab70d24fd90d5e8cba1`，33 条迁移、重复 deploy、独立 Prisma、旧 reader/Worker 兼容、DB 测试、真实模型、migration status 均成功。此后只增加只读 QA helper 的合成事件回放；全部 116 个执行相关文件中仅该 helper 不同，执行/审查代码一致。

最终 PG 复验 `S05/rehearsal-236e7660-1fd1-41f8-a198-8b3d719c10ce/manifest.json`，SHA-256 `931eff763c247fec6b6f94106412d220462e5442ae7d2d64a270e2b95c32e754`，116 个源码 hash 与收尾一致、29 项通过、所有迁移/兼容阶段退出 0、containerRemoved=true。没有因此重新消费模型预算。

界面证据在最终 S13 目录的 `workbench-qa/`：桌面 1280、手机 390×844、原生/现金流/扫描阅读器、恶意文本、刷新/任务切换、资料不足终态和真实 EventSource 合成回放。首次连接主动关闭，浏览器自动再次连接并接收终态；重复/乱序/缺序事件与旧重连清理分别留痕。`verification.json` 绑定截图、AX、bundle 和事件日志 hash。页面使用实际 React/Tailwind 组件及 repository 保留响应，Next Link 为替身；不声称完整 Next/auth/live Worker 或实时取数 E2E。

扫描为真实年报页栅格化后经 S08 Docling/RapidOCR 解析的派生样本，非自然扫描年报。选中 0 起始 row=1/column=1，金额 `170,899,152,276.34`，坐标来自真实回执；保留 needs_review/未知披露时点，未升级为 known。手机表格可内部横向滚动，页面 bodyWidth=375、viewport=390，无页面横向溢出。

自己的临时 PG 容器、QA 服务和标签页均已关闭，9090/10171/5430 无监听；共享服务未动。大原件、数据、截图、日志和校准回执仅在忽略目录保留至 S20/受控归档，不随源码推送。

模块门仍只有原三项失败：chat 4161/4100、data-prefetch 2211/2040、market-data API 1541/1540。既有 Node 锁/Python 审计修复按用户指令暂缓；未跑完整构建/CI，未部署生产。本轮止于 S15，后续步骤未启动。

## 新报告人工确认

用户在原核查问题中明确回复“已逐项核对，通过”。确认登记于北京时间 2026-10-19 21:55:42，绑定 task `a316d272-71e8-4ec2-a793-6d5475b9b8c3` / report v1 / 上述 canonical hash，范围为六金额、三增幅、现金流原因和风险比较；登记时间不当作用户实际复核完成时刻。

最终 S13 目录新增 `human-acceptance-01/acceptance.json`，SHA-256 `644ce4083c9e83c30f83b5b986fcc30eb97a152d70b8ab526110827dde8c0709`，可读副本 acceptance.md SHA-256 `d168a4c4334834c35267d3f7f3afed119fa53fac625b0fa56026f6f09ae387ff`。独立 verification.json SHA-256 `4562e23e063903317985e521004e8604a714a4b07fa7ff04968f11c49f041c0b` 记录回执登记时 canonical 原始/合同解析后的一致性、78 个原收尾未变文件、116 个源码、24 个浏览器材料及两份原 PDF 的 hash 全部通过。之后仅更新 progress 与本说明，收尾独立复核其余 77 个历史文件及全部源码/浏览器/PDF 仍一致。源码基准为 `2964ee7598ace01cfa984766a2f1bb49526bbc0f`。

原 human-review.md、报告/来源 snapshot、closure 及截图保持确认前状态，当前人工结论以独立回执为准。未向应用/业务库补写验收，也未重跑模型/OCR、改变冻结资料/评分或解除业务 OCR needs_review。S13 的人工要求已满足，结合 S14/S15 的自身验证，三步均标 done；整体 15/20，详细交接见 progress 的 E-S13-02。
