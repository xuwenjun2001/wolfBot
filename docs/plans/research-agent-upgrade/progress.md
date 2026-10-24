# 财报研究 Agent：进度与会话交接

这是唯一的当前进度来源。计划见 [plan.md](plan.md)，规范见 [development.md](development.md)，选型见 [decisions.md](decisions.md)。更新时间使用北京时间。

## 当前交接

| 字段 | 当前值 |
| --- | --- |
| 最后更新 | 2026-10-24（用户授权实现 U 系列板块 1；U00 分支与登记准备，原 S 系列验收结论保留） |
| 计划版本 | v1 |
| 总体状态 | S01—S18 已验收（S17 按当前反例修复并重验）；S19/S20 仍有必需验收阻塞。生产部署不在授权范围内 |
| 已验收步骤 | 18/20；S17 重开与修复过程分别保留 E-REVIEW-03 / E-FIX-R2R3 |
| 当前待处理步骤 | U00 登记与分支，随后实现板块 1（阶段 0）的 U01—U05；S19/S20 保持 blocked |
| 下一步骤 | 完成历史失败归因、并列 v2 评分、消融 runner mock、开发样本扩充及检索基线，再核对 G0；不得跨入未授权的板块 2 |
| 下一具体动作 | 先完成 U00 文档验证并提交；U01/U02/U04 并行，各自文件独占；U03/U05 随接口和轨迹就绪接入。真实研究模型费用、人工标签和实验登记在交付具体材料后集中请用户确认 |
| 当前会话登记 | 2026-10-24-u-block1：用户授权板块 1；开发子 Agent 固定 gpt-6.1-sol/max。主 AI 维护进度、决策、文档导航与提交；各工作包负责范围见下方 U 系列表 |
| 工作区 | `D:/QuantPilot`；在其他电脑以实际项目根为准 |
| 分支 / 本轮实现起点 | codex/agent-upgrade；起点 `26968ffdb751d3ee0488b608f020be29679780be`，从已核对同步的 origin/codex/research-agent-s11-s15 新建；保留用户修改的 v2 计划和目录 README |
| 目标仓库 | `https://github.com/xuwenjun2001/wolfBot`，默认分支 `main` |
| 本轮涉及文件 | U00：v2 计划、目录 README、docs/README.md、progress.md；U01—U05 的实现、fixture、验证与文档按下方文件范围登记 |
| 已有改动提醒 | 起点有用户对 agent-upgrade-proposal.md 与目录 README.md 的两份修改；本次按其计划开发并纳入 U00，保留原内容。其余无已有源码改动；受控原件、凭据、临时日志不提交 |
| 运行环境 / 进程 | Windows 普通文件符号链接仍受 EPERM 限制；Linux 专用容器已完成真实链接/namespace 验证和默认发布检查，导出证据后按 ID 停止并移除。四案例临时 PG 与入口 QA server 已停；保留临时 checkout/依赖 junction，不递归删除。未操作日常服务或生产库 |
| 模型与数据费用 | 历史 S19 14 次真实任务完整保留；新开发回归四任务/136 工具/12 工具失败、输入 2104212 / 输出 48527 Token。累计 18 任务/626 工具、输入 9458172 / 输出 192453 Token，未知用量请求 0，费用 unknown；未调用付费搜索或 OCR。每任务保持 40 工具/20 分钟 |
| 阻塞 | S19 旧人工确认与缺答保留；新开发回归数值 36/36，但问题与支持结论均 9/12（75%），未达 80%/90% 门槛。S20 的 Linux 默认 22 项代码检查已通过；原锁文件 npm ci 仍失败，Quality Node 锁文件/Python 审计继续暂缓，未证明完整 CI 或生产发布通过 |
| 最近验证 | 开工核对 HEAD、远端、工作区、当前单 Agent runtime、BM25 v4 与历史质量证据；新实现验证尚待执行。历史工程与财报质量证据保留，不当作本轮通过 |
| 受控资料恢复 | 开发资料在 `data/research-agent-upgrade/`；本机 `RESEARCH_HOLDOUT_ROOT=D:/QuantPilot-private-evals/research-v1`，换机须经受控归档恢复并核对登记 hash；这里不记录保留题/答案 |
| 范围提醒 | 本轮实现 U00 与板块 1 的 U01—U05，按用户 v2 计划替代旧 R 草案作为后续开发入口；不改变原 S 系列状态。尚无真实模型实验授权，不读取未见保留答案，不部署，不扩展修复暂缓的依赖门 |

## 步骤状态

状态：`pending` 未开始；`in_progress` 正在实现或等待必需验证；`blocked` 有具体外部阻塞；`done` 本步验收通过且证据齐全。依赖未完成的 pending 不自动算 blocked。被重开的步骤保留原证据并记录原因。

| 步骤 | 工作包 | 最低依赖 | 状态 | 证据 / 阻塞 |
| --- | --- | --- | --- | --- |
| S01 | 现状核实与首版场景 | 无 | done | E-S01-01；baseline.md |
| S02 | 固定资料、人工答案与评测合同 | S01 | done | E-S02-01/02、E-ANNOT-01/02；用户确认核查 4 家/12 题，9 完整/3 partial，完整人工参考公司 1 家；冻结 v1 字段保留原状态，人工批次另存 |
| S03 | 实测基线与失败记录 | S01、S02 | done | E-S03-01 原 401 基线保留；E-S03-02 新配置 4 次请求均 200，单案例工具调用可用、结果 partial；不作同题质量对照 |
| S04 | 版本化领域与事件合同 | S01、S02 | done | E-S04-01；contracts.md；51 测试通过/2 DB 跳过；types 通过；E-REVIEW-01 回归通过 |
| S05 | 持久化、隔离与迁移 | S04 | done | E-S05-01；七张版本表、actor repository/原件存储/API；13 项 PG 测试和旧库升级/旧代码兼容通过；E-REVIEW-01 回归通过 |
| S06 | 财报发现、导入与时间证据 | S05 | done | E-S06-01/02；公网原件/hash、八份日期修正；追加修订原件不能回溯旧披露日的隔离/重试实跑 |
| S07 | 文本 PDF / HTML 定位解析 | S06 | done | E-S07-01；八份原件/32 引用定位，v1/v2 兼容、HTML/截断/跨页与 PG 发布校验；E-REVIEW-01 回归通过 |
| S08 | OCR 与表格结构解析 | S07 | done | E-S08-01/02/03/04；样本人工确认、当前 CPU 镜像、禁网 OCR、HTTP 健康/取消/超时保留页及恢复、资源与质量门通过；保留“合井口径”误字与业务 needs_review |
| S09 | 财务口径与变化计算 | S07、S08 | done | E-S09-01；decimal-v1、16 项边界测试、24 金额+12 变化复算通过；限模块验收，S08 待复核 OCR 拒绝成为 known；E-REVIEW-01 回归通过 |
| S10 | 证据检索与按需上下文 | S07、S08、S09 | done | E-S10-01；版本化索引/asOf/字段过滤与有界读取；23/24 页、11/12 题；E-REVIEW-01 回归，S11 接线见 E-S11-01；OCR 质量门保持 |
| S11 | 研究计划与 Agent 循环 | S04、S05、S09、S10 | done | E-S11-01、E-REVIEW-02；同一 PI/Worker、公开计划/checkpoint、预算继承/停止/取消及取消/接管/租约过期写入 fencing 回归通过 |
| S12 | 结论与证据分层核验 | S09、S11 | done | E-S12-01/E-REVIEW-02/E-S12-02；S19 暴露的行内单位缺口已补验：46 单测、47 真实原表失败回放、44 PG；冲突/别行单位/缺年份列继续拒绝。未改变语义 reviewer |
| S13 | 报告与变化表完整交付 | S11、S12 | done | E-S13-01/02、E-REVIEW-02；完整/partial 固定报告确定性回放无错误，原人工确认绑定报告 hash 保留 |
| S14 | 工作台与事件流 | S04、S13 | done | E-S14-01、E-S13-02；桌面/手机、状态/路由、刷新/切换、浏览器 EventSource 断线/重复/乱序/终态通过 |
| S15 | 原文定位与证据阅读器 | S07、S08、S12、S14 | done | E-S15-01、E-S13-02、E-REVIEW-02；原生 PDF/真实 OCR 派生扫描、版本/hash/坐标/逐字高亮、权限与恶意文本通过，长文本归一化引用范围回归通过 |
| S16 | 修改计划与安全重新规划 | S04、S05、S11、S14 | done | E-S16-01；request/plan expectedRevision 与幂等、取消优先、旧 attempt fencing、同逻辑预算继承、旧报告上下文和窄屏工作台检查通过 |
| S17 | 新财报更新与报告差异 | S06、S09、S13、S15、S16 | done | E-FIX-R2R3：独立更新预算、历史累计与不可变快照、失败来源重试/去重及 fencing；46 PG 回归/34 迁移通过。原 E-REVIEW-03 反例与 E-S17-01 固定案例保留 |
| S18 | 恢复、隔离与运行观测 | S05、S11、S14、S16、S17 | done | E-S18-01；reliability.md；44 项 PG、真实 SIGKILL/自然租约接管、3 项 parser 测试，原预算/未知用量保留 |
| S19 | 评测对照与 Skill 改进实验 | S02、S03、S13、S18 | blocked | E-S19-01/02、E-FIX-QUALITY；旧保留 9/18 数值、3/6 问题与人工确认保留。新四案例开发回归数值 36/36、问题与支持结论均 9/12，质量门仍未过 |
| S20 | 综合验收与面试证据包 | S01—S19 | blocked | E-FIX-RELEASE-FINAL：Linux 默认发布检查 22/22，原 19 个 symlink 用例通过；历史失败保留。S19 质量门未过，既有安装/审计问题继续暂缓，不代表完整 CI/生产发布验收 |

`done` 数量与上方完成数一起更新。计划文件不复制状态；一旦状态矛盾，以实际证据核对后修正本文件，不静默选择较乐观的记录。

## U 系列

用户于 2026-10-24 授权实现板块 1（计划阶段 0：U01—U05）及前置 U00。开发子 Agent 使用 gpt-6.1-sol / max，主 AI 负责集成、门禁、进度和 Git 同步。下表只登记计划中存在的 ID；`done` 必须具有本轮证据，人工确认与真实模型验收单列。

| ID | 状态 | 负责会话 | 写入范围 | 证据 | 下一动作 |
| --- | --- | --- | --- | --- | --- |
| U00 | done | 2026-10-24-u-block1 / 主 AI | 计划、目录 README、docs/README.md、progress.md；分支 codex/agent-upgrade | E-U00-01；文档检查退出 0（78 Markdown/568 链接）、差异检查通过 | 推进 U01—U05，按文件独占并行 |
| U01 | pending | 待派发 | src/lib/eval/research-failure-attribution.ts 及测试；scripts/research/attribute-failures.ts；failure-attribution.md | — | 全部历史 S19 批次只读归因 |
| U02 | pending | 待派发 | financial-research-score-v2.ts 及测试；statistics.ts 只增；rubric-v2.json；answerability-dev-v1.json | — | 实现评分、起草标签；人工确认后冻结 |
| U03 | pending | 待派发 | scripts/research/run-agent-ablation.ts、ablation-protocol.ts 及测试；ablation-registration.md | — | 安全 runner 与 mock 空跑；登记预算提案 |
| U04 | pending | 待派发 | development-v2.json、peer-pairs-v1.json、holdout-registration-v2.json；受控 evidence/U04/ | — | 采集解析、生成标注表；不得代替人工核对 |
| U05 | pending | 待派发 | retrieval-labels-v2.json；verify-retrieval.ts 兼容扩展；受控 evidence/U05/ | — | 原因/风险页标签、真实 query 和 Recall/MRR 基线 |
| U10 | pending | 未授权 | plan-graph.ts 及测试；task-contracts.ts | — | 等待 G0 及板块 2 授权 |
| U11 | pending | 未授权 | gap-policy.ts 及测试 | — | 等待 G0 及板块 2 授权 |
| U12 | pending | 未授权 | budget-policy.ts 及测试 | — | 等待 G0 及板块 2 授权 |
| U13 | pending | 未授权 | financial-scheduler.ts；runtime/tools/execution-contracts/observation；集成测试 | — | 等待 U10—U12 |
| U14 | pending | 未授权 | financial-runtime.ts 与批量工具调用测试 | — | 等待 U13 |
| U15 | pending | 未授权 | 受控消融证据；evaluation-results.md 新小节 | — | 等待 U14、费用审批 |
| U20 | pending | 未授权 | retrieval-expansion.ts、evidence-retrieval.ts、lexical-index.ts、verify-retrieval.ts | — | 等待 G0 及板块 3 授权 |
| U21 | pending | 未授权 | 受控检索实验与报告 | — | 等待 U20/U15、费用审批 |
| U30 | pending | 未授权 | subtask-contracts.ts、subtask-merge.ts 及测试 | — | 等待 G1 及板块 4 授权 |
| U31 | pending | 未授权 | subtask-store.ts、集成测试与独立迁移目录 | — | 等待 U30 |
| U32 | pending | 未授权 | financial-researcher.ts、researcher-tools.ts、researcher-prompts.ts、financial-tools.ts 抽取 | — | 等待 U30 和 U31 接口 |
| U33 | pending | 未授权 | financial-coordinator.ts；financial-runtime.ts；execution-contracts.ts | — | 等待 U31/U32 |
| U34 | pending | 未授权 | multi-agent-faults.integration.test.ts 与夹具 | — | 等待 U33 |
| U35 | pending | 未授权 | observability.ts、快照投影、任务树组件 | — | 等待 U31 |
| U36 | pending | 未授权 | 受控 C1/C2 评测证据 | — | 等待 U34/U35、费用审批 |
| U37 | pending | 未授权 | task-contracts.ts、peer-coordinator.ts、必要迁移与同行评分 | — | 等待 U33、同行对资料 |
| U40 | pending | 未授权 | ablation-report.md、delivery.md、README.md | — | 等待 G2/U21 及板块 5 授权 |

G0 尚未执行；弃答标签/评分合同与实验样本、次数、Token 上限尚未获用户确认。实现完成与冻结验收分开记录，不据 U 系列进展改变 S19/S20 的 blocked。

## 初始核对得到的事实（历史，当前状态见上表）

- 公司研究已使用 DeepSeek Search/Fetch，当前模型与搜索凭据分别配置；旧会话中的 Tavily 描述已过时。
- 当前研究合同主题为主营业务、上下游和近期财报；双期变化研究仍是拟新增能力。
- 已有来源 hash、引用存在性校验、研究状态、Worker fencing、SSE 与取消；不能因此声称升级步骤已完成。
- 扫描件 OCR、检索任意已读来源、结构化计划编辑和报告版本差异需按计划实现。
- S01—S05 新增可复验的基线、评测、版本合同和持久化基础层；新请求先保存 draft，S11 才接入双期执行。旧 Worker 不领取新表。
- 原 S03 网关基线全部在鉴权时失败；用户指定新模型后另存校准，4 次请求均 200，但提前收尾且无财报来源，不是质量提升证据。后续人工确认按 E-ANNOT-02 单独归档，不能反向把旧模型运行变为通过。

## 验收证据

### E-U00-01：U 系列分支与开工登记

- 2026-10-24，从 `26968ffdb751d3ee0488b608f020be29679780be` 建立 `codex/agent-upgrade`。创建前 fetch origin，原工作分支与远端为 0/0，目标分支不存在。用户的 v2 计划和目录 README 修改原样保留，并作为本轮开发依据纳入。
- U 系列表包含全部已定义的 U00—U40 工作包，状态、负责会话、文件范围、证据和下一动作分别登记；未授权的后续板块保持 pending。
- `npm run check:docs` 退出 0（78 Markdown/568 本地链接），`git diff --check` 退出 0。日志保存在受控目录 `data/research-agent-upgrade/evidence/U00/block1-20261024/docs.log`；本步仅文档与分支，不声称产品或模型验收。
- 原 S 系列 18/20、S19/S20 blocked 和既有依赖问题暂缓的边界保持原证据；后续 U02 人工标签、U04 标注及 G0 实验审批分别验收。

### E-FIX-RELEASE-FINAL：工程门与财报门分别收尾

- 在干净的 `a4b5a64699ad185c052612ec6dea6e7acf88a771` Linux checkout 运行 `npm run release:check`，退出 0，默认 22 项全部通过，总计 591.8 秒。前端 250 文件中 240 passed/10 skipped，1465 passed/76 skipped；后端 308 passed/22 skipped。前端类型、全量 lint、四模板构建、生产构建等均通过；数据库集成测试由独立 PG runner 的 46 项实跑补充，跳过项不计作通过。
- 原 19 个符号链接失败用例在真实 Linux 文件系统全部执行通过，namespace 前置检查实际成功，没有关闭源码沙箱或替换链接反例。Windows 最近整门为 1445 passed/19 failed/55 skipped，19 项仍为创建链接 EPERM；其后独立 types、后端 lint/tests/build 通过。Windows 首次 types 内存失败和 Linux 首次后端 lint 缓存锁失败日志都保留，后者是依赖准备与检查并发导致的验证环境冲突；完成准备后顺序重跑整门通过。
- 最终 1335 个运行源码/测试/fixture/锁文件与目标提交全部一致，checkoutCommit 与 targetCommit 均为 a4b5a64，工作树干净。`release-repair-01/runtime-source-comparison-final.json` SHA-256 `ef1168577ee0b2cc7ff38402542f42dc44c60e4c036cbafba02fad9085fd5817`；二进制按原字节，UTF-8 文本按既定 LF 语义核对，文档另验。
- 最终日志 `release-repair-01/release-linux-final.log` SHA-256 `34da8447ce0bb076a5011f99b3911b331ef8894b6a8441585397c69ed2580c6e`。独立汇总 `repair-checks-final.json` SHA-256 `ed94d97b8e9f0f46e478e56bd94161e91f9028c479a3ffdc6c0e69ad547fd6bd` 绑定工程、PG、入口、质量、安装限制和清理证据；旧日志与 repair-checks.json 不覆盖。
- Linux 使用 Node 24.12.0/Python 3.14.7 及校验过的官方 Prisma/SWC 运行件。原锁文件 `npm ci` 因既有 @emnapi 不一致真实失败；仅在隔离环境准备依赖，四处版本/嵌套差异存于 `linux-dependency-differences.json`，仓库锁文件未改。此结果是默认代码检查通过，不是原锁可复现安装、可选 security/runtime/production/live-evidence 门或 GitHub CI 通过；Node 锁/Python 审计仍按用户要求暂缓。
- 财报门独立保持失败：四个开发任务数值 36/36，问题和支持结论均 9/12，门槛不变，详见 E-FIX-QUALITY。S19/S20 仍 blocked，总计 18/20。没有新增模型调用、重开旧保留任务或代填人工验收。
- 所属 Linux 容器 `01d9f11bf532…` 已在导出证据后停止/移除，临时 PG 与入口 QA 服务已停，日常/生产服务未重启。新增 `20261020150000_research_update_budgets` 仅在隔离库演练；本轮没有迁移应用库，正常开发启动脚本会执行 migrate deploy。
- 三份最终交接文档的 `npm run check:docs` 退出 0（77 Markdown / 539 本地链接），`git diff --check` 通过，日志 `release-repair-01/release-docs-final.log`。这次文档收尾未修改已验证的运行源码或锁文件。

### E-FIX-LINUX-01：Linux 首轮与补充夹具修复

- 隔离 Linux/Node 24.12.0 在 5659ecf 完整源码运行 250 文件：1463 passed、2 failed、75 skipped，原 19 个 symlink 安全用例均执行通过。旧两项超时在本轮为 PI loop 1822ms、Skill 镜像 323ms，保留原 5000ms 限制。日志和 JSON：`release-repair-01/release-linux-unit.log`、`release-linux-unit-first.json`。
- 新失败均为测试合同：sandbox 测试依赖未跟踪的 data/projects 目录；atomic workspace 测试在 POSIX 期待仅 Windows 才启用的 EPERM 重试。前者使用独立临时目录并清理；后者在 Windows 检验两次 rename，POSIX 另验立即传播错误、保留原目标和清除临时文件。安全和写入实现未改。
- 修复后 Linux 两文件 6 passed/2 平台 skipped；Windows 过滤定向 3 passed/5 未执行，不能当作八项全过。此阶段完整 release 尚待执行；后续整门通过见 E-FIX-RELEASE-FINAL。Linux 使用真实用户命名空间、与官方校验值一致的 Prisma 引擎/SWC/Python；未连接业务库。

### E-FIX-QUALITY：四案例开发回归与独立质量门

- `repair-validation-20261020-01` 独占登记后只运行 baseline 四任务，模型 gpt-6.1-sol/high，每任务 40 工具/20 分钟；没有候选调优、原任务重试或旧保留集重跑。结果为 36/36 数值、9/12 问题、9/12 支持结论、硬错误零，公司 completed 2/4；问题 80% 与支持 90% 两项门槛未达。
- 两个现金流原因问题缺少直接业务因果证据，另一个风险结论在预算耗尽前未完成语义核验；诚实缺口保留在全分母。原始 `baseline/results.json` 与独立 `full-denominator-gate.json` 分开保存；方法、逐公司结果、hash 和用量见 [evaluation-results.md](evaluation-results.md#修复后的四案例开发回归)。旧人工确认继续有效，不重复核查；本次开发回归不能替代新的盲保留验收。
- 运行的临时 PG manifest `S05/rehearsal-c5127592-a073-4e59-8bf6-adb64ec8e19c/manifest.json` SHA-256 为 `fc3dec3bbf6b3ca55abb3258541c5ed79faa78c1bc016ffea7e5d9c44f9a0cf7`，46 PG/34 迁移检查通过，nativeClusterStopped=true。命令退出 0 只证明运行执行完成，财报质量 gatePassed=false；S19/S20 保持 blocked。

### E-FIX-ENTRY-E2E：真实解析到开始研究

- 使用新建、隔离的 release-repair-worktree 与临时 PG，通过认证 HTTP 旅程输入“安迪苏”和“601919”；实际本地行情服务返回裸代码，API 保存规范身份后再次验证并成功创建/排队。两项 resolve 200 / create 201 / start 202，数据库状态 queued，工具/模型均零调用；随后取消。
- `npm run test:research:postgres` 的原生模式追加 `--delivery` 与自动退出环境配置：46 PG 回归、入口旅程、34 迁移检查通过，QA server 和自建 PG 已停止。PG manifest：`S05/rehearsal-566e5dc3-cc6e-4133-872d-1d4bf8297934/manifest.json`；入口原件：`S20/journey-566e5dc3-cc6e-4133-872d-1d4bf8297934/entry-journey.json`。
- 这补足 R1 的整条入口回归；重放的旧报告和真实模型质量验收仍分开计算。脚本不使用搜索摘要替代财报，也不自动点击人工报告验收。

### E-FIX-R2R3：新更新预算、失败重试与检查回执

- 新来源更新封存旧轮次快照，使用工具基数计算新轮次额度，所有任务累计工具/Token/未知请求不清零。实际过期反例：首次 2 工具后隔日更新正常执行 3 工具，总数 5、输入/输出 500/100，原时间窗和消耗可从不可变历史回读。
- 模型首请求失败、零工具/来源仍 acquired 后，新请求成功重排同一来源；本轮预算 revision、startedAt、deadline、累计用量完全保留。相同幂等键只返回已有受理结果；新键受 expectedRevision 控制。耗尽 deadline 时拒绝继续重排，旧 attempt 不能写读取回执。实际读取并正常提交的无关来源可去重，仅提交未读取来源仍保持 pending。
- `node scripts/checks/run-research-postgres-integration.js --native-postgres=data/research-agent-upgrade/evidence/S05/native-postgres-16.14/package/native/bin`：7 文件/46 测试通过，34 迁移旧库升级、重复 deploy、新 client 与旧代码兼容均通过。原件 `data/research-agent-upgrade/evidence/S05/rehearsal-fb326fe1-d1a1-4e78-967d-4e74efb2775e/manifest.json`，SHA-256 `6ee3d509e9dc0198ca81a568d164915da40fe8e473cd5733cea70ce6df37e365`，outcome=passed、nativeClusterStopped=true。`npm run type-check` 退出 0；模块边界和文档链接检查通过。本批无真实模型请求。
- 追加迁移和数据字典/专题/SQL 索引同步；未对应用或生产库执行迁移。S19 历史模型任务预算没有重开；D32 记录新更新与同轮重试的边界。

### E-FIX-R1：研究入口的证券查询边界

- 2026-10-20，用户授权按顺序修复 review/release 问题。`resolveCompanies` 将规范身份中的交易所后缀转换为行情接口接受的六位代码，保留公司名称搜索；创建 API 继续核对权威代码、名称，拒绝不同交易所返回值。
- 正式回归通过真实连接器和 HTTP fetch 边界验证“安迪苏”“601919”的 resolve→create 转换，以及空结果、异代码/交易所/名称和权限拒绝；不再把 resolver mock 成恒成功。另覆盖规范代码和空白输入转换、重复结果和非股票排除。
- `npx vitest run src/lib/company-research/connectors.test.ts src/app/api/company-research/tasks/route.test.ts`：2 文件/23 测试通过；`npm run type-check`：退出 0。完整浏览器 resolve→create→start 旅程留在最终工程发布门执行，不能以本回归替代。

### E-S20-03：发布失败的根因补查与协助边界

- 起点 `ea48ab49e0dc369ce01db4be7ccde9c8d084767c`，原失败日志 hash 重新核对一致。逐项归因见 [release-failures.md](release-failures.md#2026-10-20-根因补充)：32 项环境/测试适配，1 项确定的 Skill 跨平台编译缺陷，2 项未完全归因的历史超时。32 项不等于免验收，尤其 19 项安全断言仍缺有效环境实跑。
- 当前四个原用例串行定向结果为 2 passed / 2 failed。历史两个超时分别约 1669.7ms / 660.0ms，通过原 5 秒门槛；没有全套并行 CPU/I/O 证据，不能宣称已修复。Skill 原组合仍 5026/5000；实际上下文含 40 处 CRLF，独立进程只在 resource 读取时规范 LF 后，真实编译器在原 5000 预算返回 4986。没有写回源码、改 lock、提高验收阈值或调用模型。
- 归档探针确认脚本原包 mode=755、Windows 解压文件 mode=666、重新打包 mode=644，导致篡改 fixture 先触发可执行位检查；原安全校验没有放行。新临时链接也复现 EPERM。Docker 只读探测当前 OSType=linux；不要求用户立即修改系统权限，后续优先准备隔离 Linux 测试环境。
- 证据目录 `data/research-agent-upgrade/evidence/failure-root-causes/20261020-01/`，manifest SHA-256 `88e2f8c06b22b748912a0ff0c7962f280ca6953fcb38f82530518d6c32299d05`。相关源码/配置/资源与原隔离副本 LF 规范化后一致；本轮没有完整 release、Linux 安全测试、真实财务模型或业务库操作。三个产品问题与 S19 全分母质量阻塞不因本次归因解除。

### E-REVIEW-03：S16—S20 Review 与入口故障复现

- 当前源码 `8736a9041cf10caaaa5273f52fddadf2f5fcfb8e`，详细位置、触发条件和修复建议见 [review-s16-s20.md](review-s16-s20.md)。R1/P1 为旧入口的名称/代码转换不一致；R2/P1 为 S17 更新沿用已过期 deadline；R3/P2 为排队 source hash 提前去重导致失败后无法重试。仅登记问题，没有提交产品修复。
- 当前定向 Vitest 140 passed，44 PG 用例在普通命令跳过后通过独立 PG16 runner 全部实跑通过；评测输入和阶段保护 8 passed。旧数据库兼容、33 迁移及重复 deploy 通过。六组实时解析查询和两个合成 PG 反例均与源码推断一致，正常测试通过不能替代失败反例的修复。
- 证据目录 `data/research-agent-upgrade/evidence/review-s16-s20/20261020-01/`，manifest SHA-256 `acfc31f65a2537fbffd3784098ba75ef0b5a91fd6cd174ec49470dfad181edae`。隔离 PG `S05/rehearsal-de4ac63a-3042-4cca-9812-54b6587f4fce/manifest.json` 的 outcome=passed、nativeClusterStopped=true。没有付费模型、业务库操作或日常服务重启。
- S17 从 done 重开为 in_progress；原固定案例和验收证据保留，当前总计 17/20。S16/S18 未发现新的确定性缺陷；没有重演真实 SIGKILL。S19/S20 原 blocked 不变，没有重新读取保留题、放宽门禁或重置真实任务预算。

### E-S19-02：用户核查确认与保留缺答计分

- 2026-10-20 / `2026-10-20-s19-human-review-and-s20-inventory`；起点 `0f6e50f`，工作区干净。用户在本会话明确确认“核查过了，都没有问题”，对应前文两份最终保留报告、18 数值、6 问和全部实质结论/来源的核查请求。本次直接登记该确认，不要求重复确认，不虚构实际复核时间或审核人身份。
- 原审核包 SHA-256 `928ca22a13c49d6893b19d73889153fdd98f3b128e126bae995e7583817c76e7`、inputs、freeze、results、两 task/source 原件与 canonical report hash 均核对；4 原始 PDF 的 bytes 和冻结 rubric 也一致。外部 `annotations/holdout-continuation-02/confirmation-01/acceptance.json` SHA-256 `32999fdd71e25d581ad90233ecdc97038bdfa1bcea9081bed3abad119dd0878f` 保存直接用户确认及逐项呈现状态；原未签署审核包和机器结果保持不变。
- 脱敏计分 `S19/human-review-20261020-01/acceptance-summary.json` SHA-256 `4ef77c8302b2b51afe505f8658971e32a25570d4fe5b188fed0c39f3ae36e67b`。holdout-1 原报告无 facts、3 条 evidence_gap；确认诚实缺口不等于补齐答案，故数值 0/9、问题 0/3、冻结 claim 支持 0/3。holdout-2 的 9 数值、3 问与 3 supported claims 获确认。合计 9/18、3/6、3/6，均为 50%，硬门无已知错误；冻结评分器 gatePassed=false，S19 仍 blocked，原因改为质量门未过。
- 计分依据是用户对实际呈现值、解释和缺口分类的确认，不为缺失的 9 个数值编造独立参考；claim 分母沿用原评分器，包含 3 条 evidence_gap，不能表述为发现 3 条虚假断言。机器 completed 仍为 1/2，原 partial 不改写。旧 referenceMissing=true/summary=null 保留为确认前产物，新回执/计分独立版本生效。没有新模型、OCR、数据库或预算重置；若依据已见保留失败优化须另备未见集合。

### E-S20-02：35 个失败逐项清单与字节定位

- 同会话从 `s20-release-03.log` 原字节提取 35 个唯一失败项、21 个测试文件；SHA-256 仍为 `c32ed342f47e627197157fcb7eaa4f9025204d33ebab4b5cc448619fd9c5e84b`。结果为 1418 passed / 35 failed / 71 skipped；发布门前 17 项通过。当前没有重跑完整发布门。
- [完整失败清单](release-failures.md) 保留原测试名、文件/定位行、日志行与实际错误；分类为 19 符号链接创建 EPERM、9 路径/平台分支、3 CRLF/LF、1 旧品牌断言、1 Skill 5026/5000 超预算、2 用例 5000ms 超时。19 项在准备阶段即失败，不代表安全断言已通过或已经证明越权。
- 本地 `S20/failure-inventory-20261020-01/inventory.json` SHA-256 `4a18962fd8df63e8432107e9b5b3da29699db79b3c6c8c988e4ce053de1392e0` 绑定全部日志位置及副本核对：迁移 marker/regex 在 CRLF 副本上失败、LF 归一化后命中；图表隔离副本有 232 处 CRLF，归一化后与模板相同。只定位文本差异，不宣称相关完整测试通过；其余预算、超时和平台分支仍需复验。源码、测试、预算和门禁均未修改。

### E-S19-01：冻结开发配对、候选取舍与保留验收

以下保留人工确认前的运行与收尾记录；当前核查结论和独立计分以 E-S19-02 为准。

- 2026-10-20 / `2026-10-20-s16-s20`。实现可信 Skill 程序参数、报告 method 指纹、精确十进制评分与配对 runner；生成器不接收参考答案，HTTP 不接受 prompt 覆盖，默认研究 Skill 未发布变更。开发分母 36 数值 / 12 问题及全部实质 claims；硬门逐次复验，缺答、partial、失败与未知费用保留。结果和方法见 [配对评测](evaluation-results.md)。
- 第二批 protocol SHA-256 `b27293733d83c33f301c5275e6de865b621817379f1327002f9bdfa7f27720b1`，基线结果 `6b4bb7eba5b597534ae7abf3db7f45b437afb5a34a92d22bfa0e43a42dcd31ca`：36/36 数值、11/12 问题与支持，整公司 3/4，开发门通过；PG 批 `S05/rehearsal-1eb25cea-3f94-4e60-bba1-49d3a553e3e7` 退出 0 且已停。首批四次失败不作跨批 Skill 增幅，S12 修复见 E-S12-02。
- 唯一候选 `financial-change-v2-candidate-1` 的 JSON SHA-256 `8d84c92ef14b251a6f1700f7e49ab14eca8c43670ed258aa03e251582d2f8059`，prompt `6f7d3900789203d4a0feede9fb891cb18200e605dee74252d0e8268b6423d5aa`。候选四次退出 0，但问题/支持均 9/12、整公司 2/4，质量门失败；结果 SHA-256 `b581b4a3a10bdaea6824cd8796144dcdc510d1cdb3b24d62db3fa136256cf63d`。工具 146→127 不抵消质量回退，冻结选择 baseline（原 freeze `cbbab81475c4b65d266ed9f3c970a17a01be2ae515660f92f3940f7e9da3c684`）。
- `s19-phase-guard.log` 4/4；`s19-phase-guard-preflight.json` 证明重复 candidate 在 PG/模型前拒绝、未新增 PG 目录。开发对照始终使用同一 130 份冻结源码，原字节归档 SHA-256 `fb0282bdd4e44b4cd5dfc53d38aaf91648a9a448d50840d8128e795f816a83c2`。其后两次保留启动在创建任务/调用模型前失败；按 D31 只修复 runner 预检/扁平输入合同，129 份原核心源码未变，4 项 adapter 反例和 4 原件/2 题组/6 问的完整无模型预检通过，原失败标记和集群停止证明保留。
- 最终保留使用 holdout-continuation-02，protocol `0bb5111af048901f9617fe36d9f8c6dc2b2201a923f8fbc12054eb0bdf949c9e`、freeze `a04d0ed12a34609597f4265c464c8e4cb17ac0e217823c698725826f67f5d91a`。结果 `d7019a031f99a4a408f253b3ccd553f0bb3b863ab59a57b5948d2b04480796be`：1 completed/1 partial、66 工具、硬门无已知错误，referenceMissing=true/summary=null。PG manifest `cfa12434689133a5389a4e5c1b052d21e9ff9b7ac4ca20e0eed37cf88dd80933`，退出 0 且已停。总模型任务 14，不再重开该实验。
- 外部 annotations/holdout-continuation-02/review.md 与 inputs.json 已生成；未签署审核包 SHA-256 `928ca22a13c49d6893b19d73889153fdd98f3b128e126bae995e7583817c76e7`，覆盖 18 必需数值、6 问和全部实质结论/原文，未代填人工通过。`s19-input-guards-final.log` 8/8；真实预检和最终 helper 全部执行。总账见 evaluation-results，费用 unknown。S19 因独立人工参考/验收缺失保持 blocked。

### E-S20-01：交付材料与真实认证用户旅程（综合验收受阻）

- `S20/journey-0a0cbf89-189f-4558-aa5c-4b6a68b51d9a/` 保存 replay/runtime/Next 日志、刷新/取消截图与 journey-results。额外保存的 AX 查询仅返回无变化 diff，不冒充完整 AX 存档；交互依据为实际浏览器观察、截图和 HTTP 日志。用首批 S19 已完成贵州茅台报告原样恢复，保留 task/report/reviews/hash，只替换隔离库 actor；重新验证确定性与语义发布检查通过。不是新的模型生成或人工验收。
- 实际启用认证的 Next/API/PG 浏览器旅程：匿名 401、登录、报告 200、原件第 5 页/披露日期/真实文本定位、修订风险问题返回 202、计划 v2、刷新恢复同一问题与 31/40 累计用量、旧报告提示、取消终态。首次检查发现两个兄弟组件 key 相同导致重复计划编辑器，已用 plan/update 前缀修复，修复后重载只显示一个入口。错误截图单独保留，未用作最终截图。
- 图片与 4 分钟演示进入 [交付说明](delivery.md)，S17 差异图明确标合成。认证实验 PG manifest SHA-256 `e06fee46a267b9cc49d766b2eb609b7fde9dfded75c4dbf26167a2dbf808b082`、replay SHA-256 `6ecc54bbc2edd030709b123d58987404de961289c7d61523edab1672eef8fcf3`；Next 6472 与 PG 已停，S17 两个自有 QA 服务 7338/7759 按命令行和 PID 核对后停止；用户 3000 保持运行。
- S20 不标 done：S19 配对/冻结后保留已运行，保留人工参考仍缺失。发布检查在独立 checkout 与依赖 junction 上执行，第三轮清单为 `S20/validation-snapshot-v3.json`；未复制凭据、不与日常服务共用 `.next`。`s20-release-03.log` 前 17 项通过，全量前端 1418 passed/35 failed/71 skipped，整体门失败。失败不靠跳过、放宽或伪造 symlink 解决；WSL 只有 Docker 内部发行版，当前无可用开发 Linux。
- 后续独立检查：`s20-types-standalone.log`、`s20-backend-lint-full.log` 退出 0；`s20-backend-tests-full.log` 为 308 passed/22 skipped；`s20-production-build-02.log` 生产构建退出 0，`s20-lint-closeout.log` 定向 lint 退出 0。首轮生产构建暴露旧 CompanyResearchClient 通过 contracts barrel 引入 Node-only 模块，已改为类型导入及 UI 本地展示常量；未改冻结领域源码。`validation-snapshot-v4.json` 纳入该 UI 修复及新 helper 后，`s20-types-closeout.log`、`s20-boundaries-closeout.log` 退出 0。Quality 的 Node 锁文件/Python 依赖审计没有扩展处理。
- 最终新增保留输入适配后，`validation-snapshot-v5.json` 对应的 `s20-types-adapter-final.log`、`s20-lint-final.log` 均退出 0；暂存审查发现三个新抽取文件末尾空行，已仅去掉多余空行，差异检查通过。最终快照为 `S20/validation-snapshot-v6.json`，校验清单为 `S20/verification-summary-v2.json`；不把这些独立通过项合写成 release 全通过。
- 最终文档检查 `s20-docs-final.log` 退出 0：74 Markdown / 485 本地链接。原 74 / 482 日志保留。最后仅修改交接/结果/交付文档及三个抽取文件的末尾空白，未重跑模型或重复已通过的源码检查；52 文件的原始字节与隔离 checkout 副本由 v6 逐项核对。

### E-S12-02：S19 暴露的行内单位缺口补验

- 2026-10-20 / `2026-10-20-s16-s20`；原 E-S12-01 与 E-REVIEW-02 保留。本次首批四公司真实基线数值 20/36、问题 4/12、实质结论支持 4/9，只有 1/4 completed；结果 `S19/paired-20261020-01/baseline/results.json` SHA-256 `d726b8e29465e067c3886d9b5b79741aa4913332365da9ac25b129b43c33bb3c`。该批不生成候选，不与修复后基线计算 Skill 增幅，费用 unknown。
- 原实现不能识别摘要当前指标后的“（元）”；修改前反例日志 `s19-inline-unit-before.log` 为 1 failed/12 passed。修复精确绑定当前指标标签后的人民币元/千元/万元/亿元；保留全局单位冲突、其他行单位、错误年份列和负号拒绝。reviewer prompt/校准未变。
- `s19-inline-unit-after2.log`：claim/financial/evidence/version/scorer 五文件 46/46；`s19-inline-unit-replay2.log`：五粮液/美的首批 47 个失败 record_fact 输入，按原 task spec/原 S07 页重建事实，47/47 通过全部 numericFactErrors。回放证据 `S19/inline-unit-replay.json` SHA-256 `cf7d8f8538d9ecee176c38c7666e60449e5ef189157272dc3e052d64d12f2a7a`；只证明数值模块修复，不新增模型/发布/人工验收。
- `s19-types-freeze.log`、`s19-lint-freeze.log` 均退出 0；第二批 PG `S05/rehearsal-1eb25cea-3f94-4e60-bba1-49d3a553e3e7/database-tests.log` 为 44/44，最终 manifest 已核对 nativeClusterStopped=true。第二批 `paired-20261020-02` 的 4 基线+4 候选及最终续跑的 2 保留均已结束，连同首批累计 14 次真实任务，原失败耗用不清账；最终结果见 E-S19-01。

### E-S18-01：运行观测与真实进程恢复

- 2026-10-20 / `2026-10-20-s16-s20`；S18 文件为 observability、financial-runtime 接线、reliability.integration、interrupt-financial-worker、PG runner 和 reliability 文档。S17 补验提交 `1c9f5b8` 已同步，S18 自身独立提交。
- [可靠性矩阵与复现](reliability.md) 区分真实 PostgreSQL/进程、协议故障注入、既有浏览器与 OCR 容器证据。stdout 只记 task/attempt/request/plan/report/generation、阶段、耗时、usage 完整性和进程资源；不输出原文/参数/错误正文或隐藏推理。复用当前 stdout/Alloy/Loki。
- `s18-pg-interruption3.log` 退出 0：44/44 PG、兼容升级、真实进程 SIGKILL、中断后自然 lease 接管、旧 checkpoint/heartbeat 被 fencing 拒绝；原 startedAt/deadline 不变，工具从 1 到 3，报告只提交一次。自然等待 63514 ms、全实验 67280 ms；已知 Token 小计 300/30，另有 1 次未知请求。原件/manifest 位置与 SHA 见 reliability.md，集群已停止，未碰业务库。
- 模型 transport timeout 注入后 partial/unknown=1；损坏 PDF 保留原件；工具额外 actor/task/instruction 参数被严格 schema 拒绝；已有取消/接管晚回调、权限、SSRF、SSE 状态与恶意文本回归包含在 `s18-unit.log`（134 passed / 44 DB skipped）。收尾 observability/diff/依赖 8/8（s18-observability-final.log）。解析服务 `s18-parser-tests.log`：3/3，协议替身级停止/保留页验证，未重跑真实 OCR 压测。
- `s18-types-final.log` type-check、`s18-lint.log` 定向 ESLint、文档/差异收尾均按实际退出记录。先前磁盘满、Docker 无响应、过短 deadline 未进入模型和错误 Token 断言的失败日志完整保留，不删失败或修改预算。费用 unknown，RSS 是结束时进程样本，不是峰值。

### 2026-10-20-s16-s20 / S18

- 完成 S18 并承接 S19。当前 C 盘仍满，验证使用 D 盘任务临时目录及 npm cache；Docker 失败后采用仓库已有可信原生 PG、每轮全新集群。未停止用户 localhost:3000 服务，没有部署或修改业务资料。S17 只读 QA 服务在本会话验收期间使用，收尾按实际进程清理。

### E-S17-01：主动更新、不可变历史与确定性差异

- 日期 / 会话：2026-10-20 / `2026-10-20-s16-s20`。实现提交 `c0028c9a982e9ef3cc0de4bfd68a0145f475025e` 已推送；接续检查发现最新 asOf 用例未重跑 PG、证据条目遗漏，补验与修正不覆盖历史证据。
- 用户显式发现/导入公告后，用 request/plan/report 三个 expected revision 和幂等键请求更新；仅已核实披露且不晚于新截止时间的新 hash 排队。追加 request/plan/generation，保留旧报告及原 spec。预算、tokens、开始时间与 deadline 不重置，无新证据返回 no-op。已检查但未引用的 hash 由持久事件去重；同一原件不能反复触发交付。
- 受影响原件的直接事实、期间依据和 `derivedFrom` 传递依赖失效；无关事实及 supportingFacts 保留，新版本结论重新审查。差异包含规范化金额、会计/期间口径、结论修订/新增支持/撤回及 periodEvidence 引用；仅原文单位表达变化不伪造金额变化。历史选择只在加载成功后切换，离开任务会中止未完成请求；候选保留发现页码，当天截止按当前时刻而非未来日末提交。
- `s18-unit.log`：研究/API/UI 134 passed、44 DB-only skipped（含 S18 新测试）；S17 专项 diff/依赖 6/6。`s18-types.log` 的 type-check 退出 0；S17 定向 ESLint 无 error，后续将 cleanup ref warning 修正；收尾结果见本轮最终检查。当前没有依赖变更。
- 隔离原生 PostgreSQL 全新集群 44/44（含 S17 更新/no-op/旧版保留和 S18 故障），33 迁移、重复 deploy、独立 Client、旧 reader/Worker 兼容均通过。manifest `S05/rehearsal-276ea846-dabb-485a-8602-00fd4319f6d7/manifest.json` SHA-256 `6bcd79e6e5e19fba97d507011d3ed0b4f5149c797ef97eb715b47c268e03fdee`，nativeClusterStopped=true；未触及业务库。最初 ENOSPC、Docker 无响应和新增测试断言失败留存于对应 followup/native/interruption 日志。
- 浏览器在实际 React 组件与只读保留来源上验证 v1/v2 切换、旧版提示、撤回差异和 390×844 布局；DOM body/root 375，viewport 390。截图、AX、bundle 在 `S17/ui-1792431044456/browser-final/`，fixture 明确标“合成差异”，不是新模型报告；原 S13 人工验收报告未改写。fullPage 截图 API 不可用，实际视口截图已保存。报告/证据 fixture 的支持与推翻分别测试，不当作真实模型质量成绩。

### 2026-10-20-s16-s20 / S17 接续补验

- S17 实现已同步后补齐本条证据；修复未引用来源重复更新、派生依赖、期间引用、等值单位、分页导入、历史失败选择与当日截止。S18 运行观测与真实子进程中断演练独立提交，S19 尚未消费保留集。C 盘空间为零，测试临时目录与 npm cache 显式指向本任务 D 盘目录；没有清理其他项目数据。

### E-S11-01：双期 PI 执行与预算恢复

- 日期 / 会话：2026-10-19 / `2026-10-19-s11-s15`，起点 ea9ce2595b02fcf8ecd5a3207ee1db9a075da117，分支 codex/research-agent-s11-s15，起点干净。文件范围见当前交接，详细版本/实验见 [本轮验收证据](s11-s15-validation.md)。
- 同一 PI 引擎与研究 Worker 交替处理新旧任务；三问公开计划、检查点、受信检索/事实/审查/提交工具、heartbeat/fencing、工具/模型用量、截止时间继承和无进展停止均接线。耗尽任务接管只能封存 partial，取消后旧写入失效；不存模型对话或隐藏思维。恢复/重复/缺资料的确定性协议 fixture 与真实 PG 分别记录，不冒充真实进程崩溃实验。
- 最终 `npm run test:unit -- src/lib/company-research src/app/api/company-research/tasks src/app/company-research/financial` 退出 0：113 passed/29 DB skipped；日志 evidence/s11-s15-unit-closeout2.log。DB 默认跳过由专用 runner 另行全部实跑。types/定向 ESLint 退出 0（types-closeout2、lint-closeout3）；QA helper 的后续独立 lint 退出 0（s11-s15-qa-lint.log）。
- 最终 PG `S05/rehearsal-236e7660-1fd1-41f8-a198-8b3d719c10ce/manifest.json` SHA-256 `931eff763c247fec6b6f94106412d220462e5442ae7d2d64a270e2b95c32e754`：29 passed，33 迁移/重复 deploy/独立 Prisma/旧 reader/Worker 兼容/migration status 全部退出 0，116 个源码 hash 与收尾一致，containerRemoved=true。应用/生产库未迁移；新增检查点、review/acceptance 表只在测试库实跑。既有三项模块超限失败保留，完整构建/CI 未运行。
- 收尾 `npm run check:docs` 退出 0（71 Markdown/441 本地链接，s11-s15-docs-closeout.log），`git diff --check` 退出 0。模块检查 s11-s15-modules-closeout.log 退出 1，仅原 chat/data-prefetch/market-data API 三项超限，没有新依赖错误；门禁未放宽。

### E-S12-01：分层核验与真实 reviewer 校准

- 身份/时间/原文/金额单位和期间列/冲突/语义分别核验；repository 发布也强制检查，局部修改只使相关审查键失效。真实 PG 覆盖直接发布绕过、错误单位/来源、冲突保留、无校准和局部修复；原有身份/asOf 负例回归通过。
- 真实校准 `S12/2026-10-19T05-12-55-698Z/calibration.json` SHA-256 `06508863de6498a109d794d44c74b030a0ab51fb6faf7c68e8fd1aec9543d350`，2 正例/6 反例共 8/8 通过；模型 gpt-6.1-sol/high，回执绑定 reviewer prompt。明确 same-model separate-call，有限校准不当作全分布准确率。后续生成上下文修复没有修改该审查 prompt。

### E-S13-01：最终完整报告、诚实 partial 与原人工待核查快照

- 原件 `S13/2026-10-19T06-06-19-135Z/`。完整 task a316d272-71e8-4ec2-a793-6d5475b9b8c3，completed、24/40 次、6/6 金额、3/3 问题解释支持；204071 ms，输入 388673/输出 6788、unknown requests=0。canonical report hash `22bc9651bcc672ec227fd1af1205e351525f19342097f2cb77b9546ee88d3be5`，人工作用域为 report v1。
- 缺后期 task cf1d6b73-7549-420a-bbf0-c5ef4f680b51，partial、27/40 次、3/6 金额，三个 2024 金额为空且资料只有 2023；没有用参考答案/零填充缺口。固定完整公开 PDF+S07 解析，真实模型/PI/检索/存储，不是实时公告发现 E2E。每任务原 40 次/20 分钟，不重置失败预算。
- 真实模型 PG 清单 `S05/rehearsal-002e3f6c-437a-4e26-856d-4e5a4f6969f3/manifest.json` SHA-256 `212578e1b78e166e06bd6e39caf51e5b36f02a2c857feab70d24fd90d5e8cba1`，所有阶段退出 0、containerRemoved=true。后续只读 QA helper 增加合成回放，执行/审查代码未变；最终全源码 PG 复验见 E-S11-01。
- 七轮×两场景的失败、成功、上下文回归和提交循环失败均保留；各轮实现不同，不作为同算法重复率或对 S03 的改善率。`development-experiments.json` SHA-256 `7cc52eeb1e557e99ef01142261714f78d8100b04c7942fb074348d462d25a06b` 绑定 14 份任务结果。实际费用 unknown，包含失败；旧 cache usage 误分类留痕，没有覆写旧记录。rubric/原件/人工参考确认 hash 不变，未读保留集。
- 同目录 `human-review.md` SHA-256 `1fbc7a6c562966855332244ead7e294b985da50c68c2ee67a90d76d9b1148fec` 给出新报告逐字解释、6 金额/3 增幅和原 PDF 链接。已向用户请求本人核查，尚无确认；源自 plan S13 的人工要求，保留 in_progress，不把已有参考答案确认代替新报告验收。

### E-S13-02：新报告人工确认与 S13—S15 依赖结清

- 日期 / 会话：2026-10-19 / `2026-10-19-s13-human-acceptance`。用户针对原核查问题明确回复 **“已逐项核对，通过”**，范围为新报告的 6 个金额、3 个增幅、现金流原因和风险比较。登记时间 `2026-10-19T13:55:42.668Z`（北京时间 21:55:42），不是用户另行提供的实际复核完成时刻。
- 确认绑定 task `a316d272-71e8-4ec2-a793-6d5475b9b8c3` / report v1 / canonical SHA-256 `22bc9651bcc672ec227fd1af1205e351525f19342097f2cb77b9546ee88d3be5`。当前合同解析前后 canonical hash 均一致；不将序列化文件 hash 或既有 S02/S08 的确认代替此次验收。
- 独立回执 `data/research-agent-upgrade/evidence/S13/2026-10-19T06-06-19-135Z/human-acceptance-01/acceptance.json` SHA-256 `644ce4083c9e83c30f83b5b986fcc30eb97a152d70b8ab526110827dde8c0709`；可读副本 acceptance.md SHA-256 `d168a4c4334834c35267d3f7f3afed119fa53fac625b0fa56026f6f09ae387ff`。原 human-review.md、报告/来源 snapshot、closure 与截图保持确认前状态，当前人工结论以本独立回执为准。
- 绑定复验 verification.json SHA-256 `4562e23e063903317985e521004e8604a714a4b07fa7ff04968f11c49f041c0b`：回执登记时，78 个原收尾清单未变文件、116 个源码、24 个浏览器材料、2 份原始 PDF 的 hash 全部一致；已修改的 progress.md 明确排除。原 closure SHA-256 `fee64860fef7548d756c957634cea688da350b3f26d665d7f2f7ac443ca6947a` 保留。随后仅更新本文件和 s11-s15-validation.md，独立收尾复核其余 77 个历史文件及全部源码/浏览器/PDF 仍一致，确认回执和原快照未变。
- S13 的必需人工验收满足；结合 E-S14-01/E-S15-01 已通过的自身验证，S13/S14/S15 标 done，总完成数 15/20。仅为开发验收登记，未向应用/业务库补写验收，未重跑模型/OCR、读取保留集或改变 partial/OCR 质量门；S16 未启动。
- 本次 `npm run check:docs` 退出 0（71 Markdown / 441 本地链接），日志 `human-acceptance-01/docs-check.log`；`git diff --check` 通过，15 项 done / 5 项 pending 与当前交接一致。仅核对既有证据和两份文档，没有重新运行源码测试、数据库迁移或完整构建/CI。

### E-S14-01：工作台、刷新与浏览器事件恢复

- 新 `/company-research`，旧报告 `/company-research/legacy`，旧 `?run=` 兼容重定向。组件拆分、权威快照、带序号/generation 的 SSE、epoch/abort/旧流关闭、终态与草稿/partial 均实现；不安装或声称兼容 AG-UI。
- 状态/路由 fixture 覆盖重复、乱序、旧 generation、跨任务和终态快照。真实浏览器在实际 React/Tailwind + 保留 repository 响应上验证刷新恢复、切换/取消草稿/partial；桌面 1280、手机 390×844 无页面横向溢出。
- `--stream-replay` 合成任务在真实 Browser EventSource 上注入缺序/重复/晚到事件并主动断线；日志记录首次断线后自动第二次连接、终态 snapshot sequence=104。另一任务断线后切换至真实报告，旧重连被清除、没有第二次连接或跨任务覆盖。合成事件不写数据库、不调用模型、不贡献财报质量成绩。
- 最终 S13 的 `workbench-qa/verification.json` SHA-256 `070ce5066f22e8d40a2c6fc087648eb297f0e726c28af3b2554fc621a73cd306` 绑定截图/AX/bundle/事件日志。Next Link 有替身，auth/DB 门分别测试，不冒充完整 Next/auth/live Worker 旅程。实现及自身 QA 通过；原先等待 S13 人工验收的依赖已在 E-S13-02 结清，当前标 done。

### E-S15-01：原文阅读器、扫描与注入防护

- 金额/结论按原 document version/hash 读取；2024 收入 p5、现金流原因 p9、无坐标页/文本高亮均实际点击核对。dialog 初焦点为关闭、Escape 返回原按钮；已有较新版本也读取原引用，跨 actor 拒绝。合成恶意 script/img 正文按文本展示，实际 DOM script=0/img=0/unsafe links=0。
- 实际 S08 OCR 派生扫描 SHA-256 `2837fa338de71223de8285ceee2183bfc3cc7307c005471ee38ca0f0488afbc6`，选中 row1/col1 的 `170,899,152,276.34`，坐标来自真实 Docling/RapidOCR 回执。保留 needs_review、未知披露时点及合成派生范围，未冒充自然扫描年报或已核实业务事实。原件/解析/阅读器回执与截图保留。
- 桌面/手机阅读器及单元格高亮通过；body/dialog 375、viewport 390，表格内部滚动不溢出页面。自身验证通过，S13/S14 依赖已在 E-S13-02 结清，当前标 done；QA 服务/标签、测试 PG 已在实现验收收尾时清理，公共服务未动。

### E-REVIEW-01：S01—S10 四项缺陷修复与回归

- 日期 / 会话：2026-10-19 / 2026-10-19-review-fixes。起点 cc13f567c3e24e27021b60acd2d37730dd65b007，工作区干净。Review 的独立 PostgreSQL 反例曾确认 unreadable 身份失败资料仍能发布 known/supported；本次按用户指令修复四项，未开始 S11。相关步骤暂时重开，验收后恢复 done，旧记录不删除。
- 发布入口同时检查文档和 v2 解析回执，拒绝不可用状态/身份失败，覆盖仅有 claim 的报告。表格行以本行和公共表头索引，不把行标题广播到其他行；v4 索引按新版本追加，实测现金流命中第 40 行且可读取正确单元格，旧 v3 不复用。HTML source-ranges-v2 计入换行和块数量，50 万字符/1 万块边界返回 partial。
- 财务合同新增可选 periodEvidence 与 supportingFacts：真实期间标签允许后续可比报告的前期重述值；单季资料仅开放所需同年累计输入。发布重算派生金额、期间、口径和完整引用，拒绝伪造标签、缺输入、环、错误金额和任意额外期间。注册/发现/导入/检索/报告统一期间范围；actor、asOf、原文及 OCR 门保持，语义归属仍留 S12。D23 说明选择，未新增 SQL 迁移。
- 最终单测命令 npm run test:unit -- src/lib/company-research src/app/api/company-research/tasks 退出 0，100 项通过、22 DB 默认跳过；unit-final.log 留存。npm run test:research:postgres 另行退出 0，22 项真实 PG 测试通过，包含四项新集成回归；旧库 30→32 迁移、重复 deploy、独立 Prisma、旧 reader/Worker 兼容通过。原件 S05/rehearsal-affb1a23-9868-4949-92c4-91290b006bdf/manifest.json SHA-256 ab67db9d493494a42da258380c4298e6dabefa29067bcfc6c9e5914fe3b85533，84 个源码 hash 与收尾一致，containerRemoved=true。早期 21 项通过批次另存 e8ef73c2，不算最终源码验收。
- 固定开发资料回归：verify-financials.ts 退出 0，24/24 金额、12/12 变化；S09/2026-10-19T04-45-53-068Z/report.json SHA-256 d21bf98f3d47223fe526ac417b364a2da94adb39ef9a9948bccad947e4487f15。verify-retrieval.ts 使用 S07/2026-10-18T17-44-58-299Z 解析语料，退出 0，v4 仍为 k=5、23/24 来源页、完整 11/12 题，21005 ms；S10/2026-10-19T04-43-38-302Z/report.json SHA-256 0de8e3874b797517fb38eced9c4f50ec651422212877eff33702e0afc3e4819f。未修改题目、评分、原件或保留集；这些不是模型质量或性能提升成绩。
- types、定向 ESLint、docs（70 Markdown/435 本地链接）均退出 0。module 门退出 1，仅既有 chat 4161/4100、data-prefetch 2211/2040、market-data API 1541/1540；这些文件本轮未改，未放宽门禁。完整构建/CI/研究 LLM E2E 未运行，依赖未改，暂缓的 Quality 工作未展开。
- 本轮日志与汇总位于 data/research-agent-upgrade/evidence/review-fixes-20261019/，acceptance.json SHA-256 为 23c7e569b0d29042af14bbef39efc8a272037b8eb620e1d0758de5943bf28db6，源码 hash 收尾复核无漂移，git diff --check 通过；归本升级任务保留至 S20/受控归档。两次自建 PG 均清理，业务库及共享服务未改。S08 Python/模型/人工材料未变，TS 发布质量门由本轮 PG 再验。原业务 needs_review、参考答案 3 题 partial、S11/S12 后续验收边界保持。

### E-REVIEW-02：S11—S15 review 修复与回归

- 日期 / 会话：2026-10-19 / `2026-10-19-s11-s15-review-fixes`。修复前 HEAD `37b693fc3a916cb2ad3bd52c4c3cd8a635d5610c`，本轮只改研究执行、核验、阅读器、回归测试及本升级文档；未启动 S16，未修改固定资料、历史报告、人工回执或依赖。
- 数值核验：新增共享 `numeric-evidence.ts`，按明确的表头年份选择金额列，拒绝标题年份、缺失/重复/调整列等歧义；金额引用按完整 token 校验，保留括号负数、ASCII/Unicode minus 和全角数字。倒序年份、正负号、缺表头、跨行泄漏等反例均有单测和 PG 发布回归。
- 执行 fencing：import/parse/register 接收受信 attempt token，在任务锁内入口和 artifact I/O 后、元数据 INSERT 前再次核验。取消、接管、下载中取消和写入期间租约过期均不产生晚到文档 metadata；替代 attempt 可正常完成解析。
- 阅读器：新增 NFKC/空白归一引用到 UTF-16 原文坐标的映射，长文本引用不再从首 9000 字符开始截断；归一匹配只提供上下文，不伪造逐字 highlight。覆盖换行、组合字符、兼容字符、代理对、精确/缺失/空引用。
- 实际验证：`npm run test:unit -- src/lib/company-research src/app/api/company-research/tasks src/app/company-research/financial` 退出 0，121 passed、36 DB skipped；`npm run test:research:postgres` 退出 0，6 个测试文件、36 passed，含 7 个本轮真实 DB 回归；type-check 与定向 ESLint 退出 0。固定报告确定性 replay：完整案例 6 known facts/14 citations、资料不足案例 3 known facts/7 citations，均无错误；没有新模型调用或人工验收。
- 证据目录：`data/research-agent-upgrade/evidence/review-s11-s15-fixes/20261019-01/`，保留 `unit.log`、`postgres.log`、`types.log`、`lint.log`、`module.log`、`retained-report-replay.json`、`review-manifest.json` 和脚本。PG manifest 为 `S05/rehearsal-4dd1a779-f1b4-4317-be4b-b91129d1cb13/manifest.json`；36 项测试及 33 条迁移/重复 deploy/旧兼容均成功，containerRemoved=true。
- 限制：module boundary 仍只有原有 chat 4161/4100、data-prefetch 2211/2040、market-data API 1541/1540 三项失败；未运行完整构建/CI、真实模型重跑、浏览器新截图、保留集或生产部署。旧模型报告和人工验收继续作为历史证据，不被本次确定性回放替代。

### E-S08-04：当前 CPU 镜像与隔离容器验收

- 日期 / 会话：2026-10-19 / `2026-10-19-s08-container-acceptance`。用户要求验收 S08；起点 `77d3ce34989ac9db3b3d238cbd16b6e9d2d4768b`，工作区干净。解析源码、锁文件、评测输入和既有人工作业未改；本次只更新四份状态/专题文档，原件归本升级任务所有，在 `data/research-agent-upgrade/evidence/S08/container-acceptance-20261019/` 保留至 S20/受控归档。
- 构建前按 history/父链/时间和旧日志核实任务归属，只回收本次失败解析器构建的三个精确 cache ID，Docker 报告释放 12.6 GB；没有全局 prune、删除卷或迁移数据盘。释放的是 VHDX 内部空间，Windows C 盘未因此缩小 VHDX。当前 `docker build --progress=plain --tag wolfbot-document-parser:dev services/document-parser` 退出 0，导出与解包全部完成；Dockerfile SHA-256 `abb87a691a53d863d41fa059628215f9c95c13d09f4f763c72c1b2da8215148b`，实际执行 `uv sync --frozen --no-dev --no-cache`。
- 镜像 `sha256:b3d37ad1d460b9784aa2de70137c3aefc20ea79d6afb7193b5f7b8d21aacf376`；`docker inspect .Size` 为 511862681 bytes，这不是完整磁盘占用或解压空间估计。镜像内七个 Python/依赖文件 hash 与当前源码逐项匹配。实际 Docling 2.140.0、RapidOCR 3.10.0、ONNX 1.31.0、Torch 2.14.1+cpu、torchvision 0.29.1+cpu，CUDA build=null / available=false、Torch 2 线程、UID 10001。
- 禁网 probe 使用 `--network none`、2 CPU/4 GiB/128 pids、只读根、只读模型和独立证据挂载；三个公开样本退出 0。`verify-ocr.ts <本批>/probe-container` 退出 0，**18/18 指标行/年份列/金额**匹配，实际框与 needs_review 保留；单页 73659/29232/13149 ms，不是受控性能对照。cgroup 内存峰值 2293723136 bytes（约 2.14 GiB），oom/oom_kill 均为 0。
- HTTP 使用独立 Compose 项目 `wolfbot-parser-s08-20261019` 和空缓存，沿用当前编排的资源/非 root/只读模型约束，仅映射 `127.0.0.1:7821`。最初 internal 网络的容器已 healthy，但本机 Docker 未发布宿主端口，协议探测 ECONNREFUSED；保留该失败，改验收专用普通 bridge 后通过，不把 HTTP 运行宣称为禁网验证。六项真实协议检查通过：缺失/错误鉴权 401、健康 200、非 PDF 415、页数越界 422、未知任务 404。
- `verify-parser-service.ts` 退出 0，原件 `S08/service-2026-10-19T04-06-33-475Z/`：两页合成表 **12/12 指标行/年份列/值**通过，万元、真实单元格框和三列合并表头可定位。实际取消为 cancelled_partial，8049 ms、保留第一页、第二页截断；本次独立断言排除了脚本允许的“抢先完成两页”分支。超时 warning 明确，扫描页重放与首次回执 deepEqual，命中耗时 792 ms，不称冷启动。
- 本地 `partial-recovery.mjs` 进一步用新 bytes 先完成/缓存第一页，再在第二页解析中触发 1 秒预算：实际 1382 ms 停止自己的模型进程，第一页完整保留、第二页显式截断；随后重新启动模型进程，55695 ms 完成两页，第一页与先前完全一致，warnings/failedPages/truncatedPages 清空。并发提交正确返回 429；`partial-recovery-report.json` 保存逐阶段结果。HTTP cgroup 峰值 1827225600 bytes（约 1.70 GiB），无 OOM，最终 healthy。
- 沿用 E-S08-02 的用户确认，acceptance.json 与其绑定的 18 个原始材料 hash 重新核对一致。新 Linux 三组真实样本与已确认版本的表格单元格字段/坐标一致，两页合成表也一致；不要求整份 JSON/PNG 字节相同，美的页渲染存在细微像素差异，原件 PDF bytes 相同。新输出是机器复核，不冒充新一次真人签字。已知“合并口径”→“合井口径”误字保留，所有业务 needs_review 和 known 事实拒绝门保持。
- 常规复验：uv lock、ruff、pytest **3 项**退出 0，parser TS **4 项**通过。最初 TS 命令还指定了不存在的 API 测试文件，实际只匹配 parser，未把 API 计为执行。`npm run test:research:postgres` 退出 0，**18 项真实 PG**通过（含未复核 OCR 拒绝发布 known）；旧库升级至 32 迁移、重复 deploy、独立 Prisma、旧 reader/Worker 兼容均通过。原件 `S05/rehearsal-a74617af-df81-4ddd-adfa-7ceb9fa40ff0/manifest.json` SHA-256 `088f7f187a87df97090c29b7d9d3b33e512893108651805fe4a0b1c2e18b3b66`，containerRemoved=true，应用库未改。
- 本批不可变汇总 `container-acceptance-20261019/acceptance.json` SHA-256 `cd79e5f706427aca400db299deb927ba7909f3d8d77189228c737d8c78443d63`，绑定 78 个日志/配置/结果原件、源码身份、镜像、资源和旧人工确认；生成前独立强断言全部通过。自己的 probe、HTTP 容器/网络及测试 PG 均已清理，镜像/模型/缓存/证据保留；knowledge-hub 七服务仍停止，wolfbot 两个依赖 healthy。C 盘收尾 2030854144 bytes（约 1.89 GiB），未证明历史 SIGBUS 根因。
- 收尾独立 hash 复验退出 0：78 个原件、14 个源码/配置文件全部匹配，closure-check.json 留存；`npm run check:docs` 退出 0（70 个 Markdown、435 条本地链接），`git diff --check` 退出 0。同步前发现 HEAD/远端并行推进到 de56c27，仅修改 NGA watcher，与 S08 源码无交集；保留该提交和其后的五个 NGA 未提交文件，本次仅提交四份相关文档。
- 结论：S08 必需验收通过，标记 done、总数 **10/20**；S11 未开始。有限开发样本不代表任意财报准确率，不解除业务审核，不算研究 LLM E2E/完整报告/生产发布验收。旧三项模块超限、暂缓的 Quality 依赖问题和三题 partial 未改，完整 CI 未运行。

### E-S08-03：Docker 引擎恢复与容器验收前提复查

- 日期 / 会话：2026-10-19 / `2026-10-19-docker-recovery`。起点 `c75af7e409cd01a956fe757acb1a7fcf3f8c1a1e`，工作区干净；本次排查用户的 knowledge-hub Compose stop 500，未改源码、质量门或人工确认。原件归本升级任务所有，在 `data/research-agent-upgrade/evidence/S08/docker-repair-20261019/` 保留至 S20/受控归档。
- 故障核实：后台 `/ping` 持续超时，VM 日志有 2026-10-18T18:06:28Z 的 containerd SIGBUS，WSL 内核也记录运行组件 signal 7；最初 C 盘仅约 1.6 GB，数据 VHDX 位于 C 盘。SIGBUS 的根因未证明，不能把空间不足直接写成已证实原因，也不能把报错末尾的 API 版本提示当作版本不兼容。
- 恢复动作：官方重启卡在关闭阶段，终止 `docker-desktop` WSL 实例及卡住的已核实 Docker Desktop 进程；随后官方退出成功。新启动暴露失效的 sailor-ingest/Secrets Engine socket；在应用完全退出、核实目录仅含零字节通信端点后，将相应运行时目录改名留作备份并重建目录，再通过官方 CLI 启动。备份位于本机 LocalAppData 的 `Docker/run.before-repair-20261019-1141`、`Docker/run.before-repair-20261019-1143`、`docker-secrets-engine.before-repair-20261019-1143`；未重置 Docker、删除容器/镜像/卷、迁移数据盘或清理其他 Python/uv 任务的缓存。
- 实测 `docker version` 退出 0：Desktop 4.89.0、Engine 29.7.2，客户端/服务端 API 均 1.55。使用原项目编排对 knowledge-hub 执行 stop，退出 0，七个服务均为 exited；停止前后 10 个容器 ID/名称/本地卷数量一致。Elasticsearch/PostgreSQL 本次退出码为 137、OOMKilled=false；仅记录容器状态，未把停止成功当作业务数据完整性验收。wolfbot TimescaleDB/Redis 均 healthy。
- 复查现存 parser:dev：`sha256:f424de2b6636ce5cac5e31eceeae4f488381f22c6a4139b813ee25ba974f8304`，inspect size 958405334 bytes，但 history 的依赖层仍为 `uv sync --frozen --no-dev`，缺当前配方的 `--no-cache`。收尾磁盘快照 C 2.19 GB / D 103.90 GB；本次未再次构建、启动 parser 或运行 OCR，不能凭这个旧 tag 记为当前容器验证通过。下一动作先解决主机存储余量，再重建与实测，S08 和完成数保持 in_progress / 9/20。
- 汇总 `docker-repair-20261019/recovery.json` SHA-256 `13c90edfe69ffb0f918ee320d1d9abc6b8122684e881aa5b169dc04c6bc6f110`，含关键日志与快照 hash；53 个证据文件 hash 与恢复断言独立复核通过，实际命令/退出结果分别保留在同目录。`npm run check:docs` 退出 0（70 个 Markdown、435 条本地链接），日志同目录 docs-check.log；差异检查通过。本次未重跑既有应用、数据库、OCR、模型或完整 CI。

### E-S08-02：用户确认 OCR 样本人工抽查通过

- 日期 / 会话：2026-10-19 / `2026-10-19-s08-human-acceptance`。起点 `4cd24e5d741e31154db142836d58bf848f14a4a1`，工作区干净；本次只更新人工确认和相关交接，不修改解析结果、质量门、开发 fixture 或旧 S02 人工标注。
- 用户对已展示的 S08 抽查问题明确回复 **“已逐项核对，通过”**。据此记录本批四组样本/五张页图的人工抽查通过：元/千元/万元、2024/2023 年列、括号负数 (1,234.50)/(12.34)、-56.78、0.00、小数点和合并表头；不再要求重复确认或代填手写签字。登记时间 `2026-10-19T03:22:24.052Z`（北京时间 11:22），不是另行提供的实际复核完成时刻。
- 本地确认 `data/research-agent-upgrade/evidence/S08/human-review-01/acceptance.json` SHA-256 `8d1d4336d4fe85267beb16150762e8998ab99fcefeef8718d15f012efe8b804a`；可读副本 acceptance.md SHA-256 `134aa0b5b16b01e82c043b863be18dedc0c96227d504cb18b483195c81227452`。原 review.md SHA-256 `f367b538c19e33c522885822a89e4548312b0fe29849e28f9b909bed2a9fe0eb`、manifest SHA-256 `4f4fc44365d3a11f76976e3a7d745a8a6515c5451506c541a01282d3ba4c7dfa` 保持不变；原材料的 pending 为确认前快照，最新结论以 acceptance 为准。原件保留至 S20/受控归档，不提交大样本和原文。
- 独立核对 18 个材料文件 hash 全部一致，3 组 CPU 回执表格单元格/框坐标与抽查版 deepEqual、对应原图 hash 一致；结果随 acceptance.json 留存。没有重跑模型或 OCR，没有把金额机器命中重新计算为人工准确率。
- 边界：样本人工抽查通过，已知“合并口径”→“合井口径”识别错误仍保留；不宣称整表/任意财报完全正确，不自动解除业务资料 needs_review。Docker 容器验证仍未完成，S08 保持 in_progress、总完成数仍为 9/20；真实研究模型质量和旧三题 partial 不因本次确认改变。
- 环境只读复查：`docker version --format {{.Server.Version}}` 15 秒无响应，仅停止本次查询客户端；C 盘 2.21 GB、D 盘 103.71 GB。`human-review-01/docker-recheck.json` 记录 exited=false，未得到可用服务端版本；不把之前 500/SIGBUS 当作本次的新返回，也没有重启共享 Docker 或进行全局清理。本次未具备容器构建验收条件。
- 本次 `npm run check:docs` 退出 0（70 个 Markdown、434 条本地链接），`git diff --check` 通过；日志在 human-review-01/docs-check.log。纯记录/文档修改，没有重跑应用、数据库、OCR 或完整 CI。

### E-S10-01：任务证据索引、权限与检索对照

- 日期 / 会话：2026-10-19 / `2026-10-19-s05-s10`。S09 已提交推送 `e7707a952c50687e36888e380b685e99f4ec1f57`，核对远端一致。S10 范围：lexical-index、evidence-index-store、evidence-retrieval、检索单测/PG 集成、evidence route/权限测试、Prisma 追加迁移、PG runner 原生备用参数、检索 runner/v1 基线与 API/数据/生命周期专题。最终验证源码 hash 记录于 PG manifest 与检索报告，不把单独 HEAD 当作工作树身份。
- `npm run test:unit -- src/lib/company-research src/app/api/company-research` 退出 0，94 项通过、18 项 DB 默认跳过；日志 `S10/unit-closeout.log`。覆盖超过 8 份来源的早期资料、分块重叠、中文/拆行指标与两期覆盖、字段先筛选、参数边界，以及 evidence API 的同源/权限/actor-asOf 注入拒绝、私有缓存与无权 404。
- `npm run test:research:postgres -- --native-postgres=<本机可信 PG16 bin>` 最终退出 0，真实 PG 18 项通过；旧 30 条迁移建库/旧代码写入 → S05+S10 共 32 条迁移 → 重复 deploy → 独立 Prisma 客户端 → 旧 reader/Worker 兼容 → DB 测试 → migration status 全通过。索引缓存命中与未命中都先校验 actor/完整元数据，12 来源、未来/未知日期、伪造元数据、不可变触发器、精确续读及较新 unreadable 抑制旧解析均通过。原件 `S05/rehearsal-8719d8e8-1ed4-4e41-9a8e-e188b2a50d8b/manifest.json` SHA-256 `088800916b014a144942c5b7a4ccc2ce5fd21951c0873f7055e412de1ba23335`；nativeClusterStopped=true，应用库未改。先前 fixture/hash 失败与 Docker 失败保留，不覆盖。
- 检索实验固定四家公司/八份原件/12 个问题/24 个来源文件页、k=5：v1 `S10/2026-10-18T18-11-48-582Z/report.json` 10/24、完整 2/12；v2 `18-25-28-450Z` 13/24、5/12；v3 `18-27-30-957Z` 23/24、11/12；v1 `18-35-17-506Z` 重放 10/24（以上目录日期前缀相同）。增加 hash 清单后复验结果不变；最终命令 `node --import tsx scripts/research/verify-retrieval.ts data/research-agent-upgrade/evidence/S07/2026-10-18T17-44-58-299Z` 退出 0，报告 `S10/2026-10-18T18-55-26-021Z/report.json` SHA-256 `4854d6ea40322b21e032a840ea342867054e2d4354ae15527a402bd4fc73507f`，23/24、11/12、18898 ms。包含原件/解析/fixture/源码 hash，v1 源码保留可重放。
- 局限：所有算法调整只在同一开发集，未读保留集；剩余美的 2024 风险 p65 未入 top5，p64 起始页已命中。来源页 Recall 不能证明正确定位到每条具体结论或解释因果；无模型、embedding、reranker 调用，CPU 成本未计量。S11 尚未注册到 PI，S08 人工/容器 pending 仍不允许未复核 OCR 成为 known；未运行真实研究 E2E、完整构建/发布/CI。
- 收尾 types、定向 ESLint 退出 0（S10/type-closeout-02.log、lint-closeout.log、lint-closeout-02.log）；docs 70 文件/433 链接、差异检查通过。模块检查退出 1，仅 chat 4161/4100、data-prefetch 2211/2040、market-data API 1541/1540 三项既有超限（module-closeout.log）。未放宽门禁，既有 Quality 修复继续暂缓。当前源码与最终 PG manifest 的 sourceHashes 逐项一致。临时 parser 与自建 PG 都已停止，原始证据/模型/缓存保留。

### E-S09-01：金额规范化、比较与累计转单季

- 日期 / 会话：2026-10-19 / `2026-10-19-s05-s10`。S08 提交 `d3b7311` 后独立归档；范围为 exact-decimal、financial-normalization、financial-comparison、financial.test、document-contracts 可选字段、verify-financials 与本步文档。S10 工作树改动保留，不混入本提交。
- `npm run test:unit -- src/lib/company-research/financial.test.ts` 退出 0，16 项通过；涵盖元/千元/万元/亿元、括号负数、未知/零、非法分组/百分数/每股、精度、超大金额、单位只换算一次、零/负基数、范围/半年/重述冲突、缺失和 Q1—Q4 推导。指标限定不得被括号清洗抹去；非法小数输入返回 schema 错误而非抛出未捕获计算异常。日志 `data/research-agent-upgrade/evidence/S09/financial-tests.log`。
- `node --import tsx scripts/research/verify-financials.ts` 退出 0，四家公司 24/24 金额、12/12 变化复算。最终 `S09/2026-10-18T18-47-49-619Z/report.json` SHA-256 `fcd7dd42836a644e2efc3fa18ae2f89276db0cafb5d0d67a2671c3eb8196a663`，包含源码 hash 与固定 development fixture hash。费用/LLM 调用为无调用，本机 CPU 成本未计量；不读取保留集。
- 收尾 `npm run type-check` 与定向 ESLint 退出 0（日志 `S10/type-closeout.log`、`S10/lint-closeout.log`，覆盖共同工作树）；docs 70 文件/431 链接通过，`git diff --check` 通过。本步不声称完整构建、CI 或业务 E2E 已运行。
- 这是 reference_input_arithmetic_only、modelEvaluation=false，不能算模型抽取、因果解释或完整报告成绩。原披露时间字段继续可选兼容，原文存在性由存储层检查，语义支持在 S12 验收；S08 未人工复核数据保持拒绝发布，容器待验收不在本步被消除。原件保留至 S20/受控归档。

### E-S08-01：CPU OCR、表格、停止与质量边界

- 日期 / 会话：2026-10-19 / `2026-10-19-s05-s10`。代码范围：独立 `services/document-parser`/uv.lock/compose、ocr-parser/parse-service、v2 nativeText、报告已知事实质量门、相关 API/测试与专题。验证工作树同时含后续 S09/S10，源码 hash 清单在下述 PG manifest，不把 HEAD 单独当作验证身份。
- 运行：Windows 11、Python 3.12.14、Docling 2.140.0、RapidOCR 3.10.0、ONNX 1.31.0、Torch 2.14.1+cpu/torchvision 0.29.1+cpu；CUDA build=null，实际 CPU、2 线程/单模型 Worker。`data/research-agent-upgrade/evidence/S08/runtime.json` SHA-256 `bfe74f09794a7ba4d27d4ef45c6028149d2c0aa2a2c388eaf5c155e6ef8f3fa5`。模型预置、运行离线；不改 market-data 环境。
- 真实样本：`DOCUMENT_PARSER_PROBE=.../S08/probe-02`，`uv run --no-sync --project services/document-parser python services/document-parser/probe.py` 与 `node --import tsx scripts/research/verify-ocr.ts .../S08/probe-02` 均退出 0。派生茅台扫描页、茅台原生 p5、美的原生 p9 共 **18/18 行/年份列/金额**匹配，实际框与 needs_review 保留；耗时分别 63328/27125/15094 ms。verification.json SHA-256 `d21c903c8c19782f2d2fdf6a5a0633ed83dd033be4da6e39e8c0615ef01dd088`。早期 probe-01 也保留，不当成额外独立样本。
- HTTP 实跑：`verify-parser-service.ts` 退出 0；最终 `S08/service-2026-10-18T18-38-21-646Z/report.json` SHA-256 `e95c3819b36fc1990c08b96b6ba5f137d10663f1923fcb394e7dabd21293a101`。两页合成压力表金额按指标行/2024 与 2023 年列 **12/12** 命中，括号负数、负号、小数、零、万元和三列合并表头可定位，保持两个独立表。第二页“合并口径”被识别成“合井口径”，不自动纠正。`service-2026-10-18T18-18-19-285Z/cancelled.json` 实际保留第一页/第二页截断，cancelled_partial，8406 ms；后续缓存重放两页可能在取消前已完成，记录为竞争完成，不能重复算取消成功。timeout_partial 停止进程后下一任务/缓存复用通过；页缓存命中耗时不称冷启动耗时。
- 常规：ruff、pytest（3 项）、uv lock --check 均退出 0；普通研究 TS/API 89 项通过/18 DB 跳过。独立 PG 实跑 18 项（含 known 事实拒绝未复核 OCR）通过：`S05/rehearsal-b666636c-669e-48b8-81cb-63dfac568ace/manifest.json`，SHA-256 `1e2dc97c0a1d0620d4e8c62afdaa86052a8f6b379bba9689b3426fae52f9e968`。类型检查退出 0。完整 PyPI audit：130 可查包无已知漏洞、2 个 +cpu 包跳过；audit-upstream.json 另查 2.14.1/0.29.1 上游无记录，非二进制完整审计。
- 人工：`S08/human-review-01/review.md` 与 manifest.json 初次准备时为 pending，后续用户确认通过见 E-S08-02；manifest SHA-256 `4f4fc44365d3a11f76976e3a7d745a8a6515c5451506c541a01282d3ba4c7dfa`。cpu-reconciliation.json 确认最终 CPU 与材料的原图、单元格文本/坐标一致；不需要重新核对旧 S02 原生标注，不把 AI 看图当真人。
- 未通过 / 边界：Docker 构建停在解包，随后 API 500，containerd SIGBUS，失败时 C 盘约 2.3 GB；docker-build-cpu.log/docker-engine-failure.log 保留。仅停止自己启动的构建客户端，未重启共享 Docker/已有容器。修订 Dockerfile 为 no-cache 后尚未完成镜像重建/容器健康/峰值资源验证，故 S08 保持 in_progress。没有真实模型 E2E；合成样本不计入真实财报准确率。

### E-S06-02：修订内容的披露隔离补丁

- 同会话在 acquisition-service 增加 replacement_disclosure_unverified：同来源换 bytes 时不沿用旧已核实公告日；重试保持 unknown，原版本不变。D22 记录保守原因。
- 18 项 PG 实跑中的独立用例通过；第一次新增用例的假披露依据 digest 未绑定测试 evidence，正常被存储拒绝，修正 fixture 绑定后再过，未放宽存储检查。失败 manifest `S05/rehearsal-cae7a294-9189-4610-a8ca-626aa660211f/manifest.json` 保留；最终通过原件见 E-S08-01。

### E-S07-01：可替换解析器与定位回执

- 2026-10-19 / 同会话，S06 已提交推送 `6f6d48d` 并核对远端 SHA。新增 parsed-document、text-parser、parse-service、citation-locator 和 parse API；旧 v1 页回执继续可读，新 v2 严格绑定原件/版本/页/块/结构表/质量。源文档不可变，解析通过新版本保存，缓存含解析器配置。
- `node --import tsx scripts/research/verify-parsing.ts` 实际八份财报 32/32 冻结引文在正确文件页复现，重复解析块 ID 稳定、截断页显式、HTML 有可复核原文范围；茅台 2023 p35→p36 污水厂跨页段落两处分别定位，不合造新页/坐标。最终印刷标签规则调整后复跑仍通过，原件在 `evidence/S07/2026-10-18T17-44-58-299Z/`，日志 parsing-final.log。
- `npm run test:unit -- src/lib/company-research src/app/api/company-research` 68 通过/15 DB 默认跳过，`npm run test:research:postgres` 独立 15 通过（新增 HTML 存储/缓存/权限/伪造 locator 发布拒绝）；PG 原件 `evidence/S05/rehearsal-b7a82b86-677d-4fff-a2f0-dacf3cb212b2/manifest.json`。`npm run type-check` 退出 0，日志 `evidence/S07/`。
- 边界：原生文本没有表格几何、OCR 或视觉质量证明；HTML 仅静态 UTF-8 源文范围，未执行 JS/推测 DOM。未运行模型研究/保留集/生产部署，既有模块尺寸门失败继续保留。

### E-S06-01：原件、日期与 S05 复核

- 2026-10-19 / `2026-10-19-s05-s10`，起点 `7ae788b`，干净工作区；保留分支。S05 重跑专用旧库升级/兼容演练，13 PG 测试通过，原件 `evidence/S05/rehearsal-8582d8cf-fdae-49ba-b117-e4b08913ee73/manifest.json`；未碰应用数据库和用户服务。
- 实现 filing-acquisition/acquisition-service、来源清单/导入 API、公网固定 DNS 下载与 provenance 合同；原件/日期依据保留 actor 私有内容寻址，修订追加，重试复用。手动链接不能自称日期已核实。单测涵盖内网重定向、流式大小、非法类型、日期冲突、未来/未知时间；PG 新增导入权限、幂等、原件修订/旧版保留验证。
- `npm run test:unit -- src/lib/company-research` 59 通过/14 DB 默认跳过；`npm run test:research:postgres` 另行真实 14 通过，含旧 schema 升级/旧代码回读，原件 `evidence/S05/rehearsal-7f8bac5a-a139-4d38-ae1a-8af771116f5a/manifest.json`；`npm run type-check` 退出 0。日志留 `data/research-agent-upgrade/evidence/S06/`，归本研究批次保留至 S20/受控归档，不自动清理。
- 公网命令 `node --import tsx scripts/research/verify-acquisition.ts` 退出 0：巨潮实时找到两份目标年报；重下载 3,563,819 bytes，hash `2125ff97a452ea79b0d784e2432f7d224b6aecc330b644b593477d69e22f4ed1` 与冻结原件一致。八份公告日期按上海时区均比冻结 UTC 截取日期晚一天。成功原件 `evidence/S06/2026-10-18T17-30-39-491Z/report.json`；初次无标题筛选没找到候选的失败记录也保留，随后加入报告标题筛选。冻结 fixtures/人工记录未改。
- `check:module-boundaries` 退出 1：已有 chat/page 4161>4100、data-prefetch 2211>2040、market-data/api 1541>1540 的尺寸债务，本轮未修改这些文件，也不放宽门禁。其余依赖边界未报告新增违规；完整 CI 和先前 Quality 问题未在此修复。
- S07/S08 的解析/OCR 尚不能由本步证明；真实模型质量未验收，无模型/搜索费用（本次公网成功走巨潮）、未读取保留集、未部署。

### E-ANNOT-02：人工确认与机器复验

- 日期 / 会话：2026-10-19（北京时间）/ `2026-10-19-annotation-acceptance`。用户在本会话明确回复“我已亲自核对原文并确认”；按当前用户指令记录为人工复核依据，无需重复要求同一次确认。记录时间 `2026-10-19T00:51:40.000+08:00` 是确认登记时间，实际复核完成时刻未另提供；不代填手写式签名。
- 工作区身份：起点 `346840e64bbc82e347dac60ffc725cab59b58e46`；开始时 progress.md 已有同批次 AI 标注交接，本轮保留并追加，不将其当作干净工作区。其余源码和冻结 fixtures 未改。
- 人工结果版本 `human-review-v1`：4 家/12 题已核查，9 题完整、3 题 partial（五粮液/美的/万华 q2 原因解释缺证）；完整人工参考公司为 1 家茅台，不能写成 4 家全部完整。23 项语义记录保留 20 项支持/3 项缺证；这些是参考标注状态，不是模型指标。
- 本地原件位置：`data/research-agent-upgrade/annotations/2026-10-19-ai-assisted-01/`。用户确认前原稿 SHA-256 `bfdc2651f9cee6a5a2f92a79fc640299931c98cf23fa7e2e44423edcaf158b39`，副本在 `machine-check/acceptance-20261019/review.before-bfdc2651f9cee6a5.md`；最终 `review.md` 的 §十三登记会话确认与复验，SHA-256 `02479bdb7d080300143a6870d8835fe6064cef8bfd5da27a770996be50054746`。
- 确认清单：同目录 `acceptance.json`，SHA-256 `2995da80c309a7852ad9a866f1db26b0808c63ed336eb1f68e29699eb16ff427`，绑定确认前/后稿件、用户确认来源、冻结输入 hash、机器证据与逐题状态；结果 hash 保存在外部清单，避免文件内部自引用。以上原件在忽略目录保留至 S20 及归档，换机需受控恢复；仓库仅含脱敏摘要。
- 原批次命令 `node data/research-agent-upgrade/annotations/2026-10-19-ai-assisted-01/machine-check/annotation-check.mjs` 退出 0，生成 report.json/summary.txt。随后运行同目录 `machine-check/acceptance-20261019/verify-acceptance.mjs`，退出 0；独立精确检查 4 个冻结 JSON、8 份 PDF bytes/页缓存 hash 与顺序、24 原值/换算、12 变化率、32 原引用及 9 补充引用，全部必需项通过，原始结果在该目录 verification.json。
- 发现与处理：原脚本仅按输出字符串统计失败，不覆盖“恢复 manifest 副本字节相同”项；严格检查首次发现该项为 false。独立比较确认 JSON 内容完全一致、仅序列化字节不同；权威冻结清单 hash 严格匹配，副本未用作冻结输入，两份均保留，不修改冻结 hash 或覆盖副本。部分补证使用标题/省略摘要，已在 §十三及 supplemental-citations.json 展开为可匹配原文，保留初稿并记录三个涉及项目；财务结论未改变。
- 时间边界：八份披露日与公告时间戳相差一天的初稿备注保留；本次固定 asOf 下两种日期都早于截止，不影响当前题。S06 需澄清后才能用于更靠近披露日的历史时点；不静默修订冻结时间。
- `npm run check:docs` 退出 0（70 个 Markdown 文件、425 条本地链接）；差异检查退出 0。最终原件/清单绑定与逐题覆盖检查退出 0，证据为 `machine-check/acceptance-20261019/closure-check.json`，核实用户确认来源、确认前/后稿件 hash、机器证据与冻结输入 hash、9 approved/3 partial/1 完整公司的一致性。
- 未执行模型研究验收、保留集读取、困难样本实际行为、业务测试或部署。现有验证器不读取该清单，冻结 v1 仍保留原 pending；后续须显式接入人工版本。S01—S05 维持 5/20，S06 未开始。

### E-S02-02：人工标注说明与待填写数据

- 日期 / 会话：2026-10-19（北京时间）/ `2026-10-19-human-annotation-docs`；类型：文档交付与只读数据一致性核对，不是人工金标或真实模型验收。
- 代码身份：起点 `54ff77cc7a99b416bc062c138994eb6f350586ec`，工作区干净；本轮仅新增本目录 `human-annotation.md`、`human-annotation-worksheet.md`，更新本目录 README/evaluation/progress 与 `docs/README.md`，最终身份随本次文档提交记录。
- 产物：手册说明输入范围、逐项核对流程、判定标签、计算容差、补证/争议处理、最终答案和签字、结果版本与恢复；填写表展开 4 公司/8 年报/24 原值/12 增幅/32 引文/12 题，并列出 9 个困难样本的预期和待填写行为证据。
- `npm run check:docs`：退出码 0，70 个 Markdown 文件、421 条本地链接。`git diff --check` 与最终 `git diff --cached --check` 均退出码 0；暂存初检提示填写表末尾多余空行，移除后通过。新增文件的行末空白、换行与代码围栏另由下述只读检查覆盖。
- 一次性只读 Node 核对：退出码 0。逐项对照冻结 JSON 与 Markdown 的数值、单位、规范化元值、增幅、原文、文档 ID、页码和风险草稿；核实 8 份本地 PDF 的 bytes hash/长度；确认 24+12 个数值、32 条引用、12 个最终答案填写位、9 个困难项齐全。仅清理引文行末空白，原始字符串仍在 JSON；这项核对不是人工阅读或语义判断，未新增项目命令。
- 输入 hash 未变：`development.json` 为 `000f1fdbdaad9f48d98c632bbe6afa3f602a5c550a3ffc8b95e2f0a35d101cf8`，`documents.json` 为 `4483c948d7649a4eecd805e5131cc07ad2e7b3ed2fd443bcba72d02015b0e53c`，`rubric.json` 为 `81df0d53f38650a955957896c6c9883030588dc455cb482b95eff2ac7e0f0d45`；完整输入身份也在填写表登记。
- 未执行：实际人工核对/签字、保留集读取、模型/搜索调用、运行时/数据库测试及部署。现有验证器不会读取 Markdown；人工结果接入评分器需后续显式实现，不能声称已自动生效。
- 承接：人工复制填写表至本地受控批次目录后，逐项核对 F/C/D/A 并记录结果文件/hash，脱敏摘要回填本进度；当前人工 golden 仍为 0，冻结 pending 状态、模型评分和 5/20 开发进度未变。

### E-ANNOT-01：开发集 AI 辅助人工标注核对（非人工签字）

- 日期 / 会话：2026-10-19（北京时间）/ `2026-10-19-ai-assisted-annotation`；类型：AI 辅助标注核对（只读对照冻结原件页缓存 + 本地记录写入）。**不是真人签字、不构成 human golden、不是模型质量验收。**
- 代码身份：起点 `346840e64bbc82e347dac60ffc725cab59b58e46`（工作区干净）；未改源码、fixtures、计划模板与评测合同；产物位于忽略目录 `data/`，仅本进度文件进入提交。
- 产物：`data/research-agent-upgrade/annotations/2026-10-19-ai-assisted-01/review.md`（批次登记、8 份文档检查、F 24 项、D 12 项、C 32 条、A 23 条、12 题答案草拟、新增引用 9 条、困难样本预期核对、人工签字区留空）与 `machine-check/annotation-check.mjs`（核对脚本：hash 重算、十进制精确复算、引文归一化复验）。
- 核对覆盖（只读）：24 个原值逐项在引用页命中（行内容与单位表头）；32 条引文定位核对，8 条风险引文读全文补证；现金流原因章节定位 9 处（茅台 p9×2、五粮液 p18/p19、美的 p53/p54/p55-56、万华 p16×2）；披露时间与重述口径逐份核对；困难样本预期与 `adversarial.json` 逐条一致。
- 未执行 / 待补：`node tmp/annotation-check-20261019/annotation-check.mjs` 因执行工具阶段性临时故障未运行 → 冻结 JSON/原件/页缓存 hash 独立重算、12 个变化率精确复算、引文整块归一化复验、review.md SHA-256 均待补；九个困难样本的实际行为无运行证据（pending）。
- 边界：人工 golden 仍为 0；q2 原因缺口 3 处（五粮液/美的/万华）已登记、整题建议 partial；须真人对照原件抽查并在 review.md §十二 签字后方可登记“已审核数量”。
- 承接：工具恢复后先运行脚本回填 review.md 待补列；评测维护者抽查 → 签字 → 按手册在本文件登记审核结果；未签字前不得将本批次引用为准确率证据。

### E-SETUP-01：计划与跨会话入口

- 日期：2026-10-18；类型：规划文件静态核对，不是开发或研究 E2E。
- 产物：根规则、Cursor 入口、README、20 步计划、开发规范、决策与本进度文件，及文档总索引新增导航。
- 修改前检查：`npm run check:docs`，退出码 0，60 个 Markdown 文件、360 条本地链接。
- 修改后检查：`npm run check:docs`，退出码 0，65 个 Markdown 文件、385 条本地链接。
- 结构检查：一次性只读 Node 校验，退出码 0；S01—S20 各出现一次且有序，计划/进度依赖一致且无环，全部状态为 pending；7 个新增文件无行末空白且以换行结束，入口文件存在，根规则少于 50 行。
- 差异检查：`git diff --check -- AGENTS.md .cursor/rules/research-agent-upgrade.mdc docs/plans/research-agent-upgrade docs/README.md` 退出码 0；未跟踪文件的格式另由上述 Node 检查覆盖。`docs/README.md` 差异显示原有 3 行新增均保留，本轮只添加升级导航一行。
- 复验方式：在项目根重跑文档命令，并核对计划 20 个 `## Sxx` 标题与步骤表编号、依赖和状态。一次性检查未新增到 package scripts，不能把它当作已安装的项目命令。
- 工作区边界：只新增上述规则/计划文件，在已有 `docs/README.md` 上增补一行；保留其原有 3 行未提交修改。
- 局限：没有开展功能开发；没有验证应用、数据库、模型或新研究链路。没有把未提交文件自动带到其他 worktree/电脑。

### E-MIGRATION-01：wolfbot 更名与源码快照

- 日期 / 会话：2026-10-18 / `2026-10-18-wolfbot-migration`；类型：品牌兼容验证与当前源码同步，不是研究功能或生产发布验收。
- 代码身份：本文件所在迁移提交；以 `git log -1` 和目标 `main` 为准。快照包含此前未提交的公司研究、行情/战法平台、NGA watcher、测试和计划；目标原提交 `8a3ab560d89aa5ccf1c74b69b0720f94434db468` 作为父提交，目标文件树由当前源码完整替换。
- `npm run type-check`：更名前后均退出码 0。
- `npm run check:docs`：退出码 0，65 个 Markdown 文件、387 条本地链接。
- `npm run check:skills`：退出码 0，12 个 canonical Skills、14 个可执行脚本通过完整性与语法/help 检查；已发布 Skill 标识和内容 hash 保留。
- `npm run brand:icons`：退出码 0；从狼头 SVG 生成 7 个 PNG 图标，尺寸由品牌测试核对。
- `npm run test:unit -- src/lib/branding src/lib/utils src/lib/auth src/lib/config src/lib/services/pi-agent-prompts.test.ts src/components/chat/personal-memory-client.test.ts src/proxy.test.ts src/lib/company-research src/lib/agent/pi/run-engine.test.ts`：退出码 0；23 个文件通过、1 个文件跳过；177 个测试通过、2 个数据库集成测试跳过。日志在本机忽略目录 `tmp/wolfbot-migration/unit-tests.log`，新环境可用相同命令复验。
- `npm run check:module-boundaries`：退出码 1，3 个文件超过硬上限：Chat 页面 4161/4100 行、`data-prefetch.ts` 2211/2040 行、market-data `api.py` 1541/1540 行。Chat 与 API 的改名前备份行数和当前相同，`data-prefetch.ts` 未被本轮更名修改；不放宽预算，后续基线应记录并安排拆分。
- 兼容：环境变量、数据/服务/协议命名保留；网站、PWA、桌面、生成页面展示名和公共图标切换为 wolfbot。匿名访问图标的路由规则已同步，并通过现有认证代理测试。
- 发布范围：遵守忽略规则，排除本机凭据、业务数据、构建缓存与临时日志；保留原许可证和作者归属。
- 未运行：完整生产构建、全量 E2E、真实模型/搜索评测、数据库迁移和生产部署。本轮通过结果不代表这些检查通过，20 步仍为 0/20。

后续步骤按以下格式增加证据，不把模板中的占位值当真实结果：

```text
E-Sxx-01 / 日期 / 会话标识：
对应验收项：
代码身份：commit + 本步未提交/未跟踪文件清单 + 版本/hash（如有）
资料 / 模型 / Skill / 工具 / rubric / 环境版本：
实际命令或人工动作、执行目录：
退出码 / 逐项结果 / 实际样本数与分母：
证据原件位置、hash 与恢复方式：
未通过 / 未运行 / 已有问题及其依据：
结论及适用范围：
```

## 会话历史

### 2026-10-24-u-block1 / U00

- 用户授权实现板块 1，开发子 Agent 指定 gpt-6.1-sol/max。核对实际源码、历史质量证据、Git 状态及 origin，同步目标为 wolfBot 新工作分支。
- 完成 U00 分支、状态表和入口导航；计划中的 U01—U05 开工登记随后单独更新。后续主线与真实模型实验不由本次授权自动展开。

### 2026-10-20-review-fixes / R1

- 入口修复和边界回归完成；继续同一用户授权范围的 R2/R3。历史报告、预算、模型成绩与原发布失败记录未改，未部署生产。

### 2026-10-20-failure-root-causes

- 用户要求详细解释 review 已确认的问题与 release-failures.md 中错误的原因、性质及是否需要协助。本轮核对 35 项历史失败与源码，补充 Skill 换行和归档 mode 的确定性证据，并保留两个历史超时的归因限制；没有实施产品修复。
- 当前不缺用户凭据或原批次人工确认。工程修复可继续自主处理；只有坚持 Windows 原生真实链接验收且权限持续受限时，才可能需要系统权限协助。未来新财务样本的独立人工核查属于后续质量验收，不能复用已见保留集刷通过。
- 仅同步 progress.md 与 release-failures.md，原始证据留本地。下一动作仍为修 R1 入口及 S17 的 R2/R3，再处理测试平台适配、Skill 文本规范化与有界并发诊断；原门禁、历史成本、S19/S20 blocked 和暂缓审计边界不变。
- 本轮文档检查通过（77 Markdown / 537 本地链接），`git diff --check` 通过；检查日志在本轮 evidence 的 docs-check.log，源码同步与 CI 结果分别报告。

### 2026-10-20-review-s16-s20

- 用户要求 review S16—S20，并反馈“安迪苏 / 601919”开始研究被身份校验拒绝。确认错误发生在创建前的带交易所后缀查询；当前行情服务可解析名称/六位代码，带后缀返回空结果。S20 存档旅程绕过创建入口，未覆盖该问题。
- 在专用临时 PostgreSQL 中补充过期更新和模型首轮失败两个反例，已确认 S17 行为不满足可用更新/重试；重开状态并保留原验收材料。本轮只同步 README/progress/review 三篇文档，源码未改，受控原始证据不提交。
- 后续修复优先 R1，随后 R2/R3 与正式回归；不能把恢复预算直接清零，也不能把排队回执当作来源检查成功。S19 全分母质量、S20 原发布失败与暂缓审计按既有边界处理。
- 本轮文档检查通过（77 Markdown / 536 本地链接），`git diff --check` 通过；日志位于本轮 evidence 的 `docs-check.log`。按仓库同步规则仅提交三篇 review/交接文档，具体提交和远端核对在会话答复报告。

### 2026-10-19-s11-s15-review-fixes / E-REVIEW-02

- 用户要求修复 S11—S15 review 发现的四项缺陷。本轮完成数值列/符号核验、attempt 写入 fencing、长引用偏移映射，加入单测和真实 PostgreSQL 回归；未进入 S16，未重跑模型或修改历史验收材料。
- 121 项定向单测、36 项真实 PostgreSQL 测试、types、定向 ESLint 通过；固定报告确定性回放保持完整 6 facts/14 citations、资料不足 3 facts/7 citations 且无错误。模块门保留原三项失败，完整构建/CI 未运行。
- 更新 E-REVIEW-02、D27、公司研究专题和当前交接；提交 `b076b2b70e52f1ed49a24b5eecfefa94e41dfb6f` 已推送到 `origin/codex/research-agent-s11-s15`，远端 SHA 已核对一致。临时测试 PG 已由 runner 清理，应用/生产库和共享服务未动。

### 2026-10-19-s11-s15 / 实现与机器验收交接

- 用户授权实现 S11—S15；按原计划和起点 ea9ce25 承接，没有子 Agent、没有进入 S16。交付执行检查点/工具/核验/报告/人工验收、同一 Worker、追加迁移、API/SSE、工作台及阅读器，规则与入口同步。代码和本轮相关文档一并提交，原件/截图/日志/校准与模型凭据不进 Git。
- E-S11-01—E-S15-01 保存最终单测/29 项真实 PG、校准 8/8、完整真实案例 24 次/6 金额/3 问、缺后期资料 partial，以及桌面/手机/原文/安全/事件恢复。七轮开发失败保留，费用 unknown；最终执行与审查代码有精确源码身份。既有模块门/Quality 暂缓不变，未全量构建、未部署或迁移应用库。
- S11/S12 标 done；S13 新报告人工核查仍 pending。S14/S15 实现与自身 QA 通过，但依赖 S13，保留 in_progress，总数 12/20。具体材料为最终 S13/human-review.md，已发核查请求；不能代签或用旧 S02 确认充当通过。
- 全部自建 PG 容器、QA server 与临时浏览器标签已清理，viewport 已恢复；共享服务未动。下一动作只承接用户针对新报告的确认/问题并结清 S13—S15，不自动执行 S16。

### 2026-10-19-review-fixes / E-REVIEW-01

- 按用户指令修复本会话 review 四项，补足真实 PG 发布、期间输入检索、行/单元格检索与缓存失效回归；100 单测、22 PG、types/lint/docs 及固定资料算术/检索通过。
- S04/S05/S07/S09/S10 重开后恢复 done，合计 10/20；本轮未开展 S11 或模型验收。同步合同、数据字典、公司研究和 D23；原证据、人工确认与业务 needs_review 保留。
- 同步前核对 origin 与本地起点一致，仅提交本轮相关文件；模块门原三项超限及暂缓 Quality 问题继续单独保留。提交/推送身份以 Git 为准，不把推送成功当 CI 通过。

### 2026-10-19-s08-container-acceptance / E-S08-04

- 按用户要求验收 S08，核实起点/任务缓存归属，精确回收失败构建缓存后完成当前 no-cache 镜像构建；解析源码及冻结输入未改。禁网 18/18、HTTP 合成 12/12、协议、实际取消、超时保留第一页、冷进程恢复和单槽并发全部通过，资源峰值未超过 4 GiB，无 OOM；3 Python/4 parser TS/18 真实 PG 通过。
- 保留 internal 网络端口探测失败和旧引擎/构建失败；沿用用户已确认人工批次，重新绑定原材料与新表格单元格/坐标，不要求重复签字、不解除业务 needs_review。“合井口径”误字和既有 partial/研究 LLM 验收缺口不变。
- 更新 progress/decisions、parser README 和公司研究专题；本批汇总及恢复脚本位于忽略证据目录。S08 标记 done，10/20；下一开发步 S11，本轮未执行。自己的验收容器/网络和测试 PG 已清理，已有 knowledge-hub 停止状态和 wolfbot 健康依赖保持，镜像/模型/缓存/证据保留。
- 文档 70 文件/435 链接、差异与 78 原件/14 源码 hash 校验通过；同步前核对并保留并行 NGA 提交 de56c27 及其未提交改动，只归档本轮四份文档。完整 CI 与既有 Quality 暂缓事项分别报告，不因推送成功宣称 CI 通过。

### 2026-10-19-docker-recovery / E-S08-03

- 排查 knowledge-hub 停止报错，保存 Docker/WSL 证据，恢复 Desktop 引擎，并通过原编排停止七个服务；wolfbot 两个依赖恢复 healthy。客户端/服务端均支持 API 1.55，先前 500 不能归因为版本不兼容；SIGBUS 根因仍未证明。
- 保留零字节失效 socket 目录的可恢复备份；未重置 Docker、迁移数据盘、删除卷或清理其他任务。记录 Elasticsearch/PostgreSQL 退出 137，不声称业务内容已验收。
- 现存 parser 镜像为旧构建配方，C 盘仅约 2 GB，本次不重试解包；S08 容器验证仍待补、9/20 不变。更新进度、parser 使用说明与排障入口，后续先处理存储再补当前镜像验收；S11 未开始。

### 2026-10-19-s08-human-acceptance / E-S08-02

- 用户回复 S08 OCR 抽查问题“已逐项核对，通过”；登记本批人工抽查通过，无需再次确认。原 review/manifest 的 pending 作为确认前快照保留，新增本地 acceptance.json/acceptance.md 绑定原材料 hash、用户回复及核对范围；18 个材料 hash 与 3 组最终 CPU 表格单元格/框坐标对照通过。
- 更新当前交接、S08 证据、D19/D20 的验收状态、公司研究和 parser README。样本已知“合井口径”误字保留，业务 needs_review 不解除；旧 S02 标注/partial 与真实模型质量状态不变。
- 只读 Docker 版本查询 15 秒无响应，C 盘 2.21 GB；停止本次查询客户端，未重启共享服务。容器构建/健康/资源验收仍待补，所以 S08 保持 in_progress、完成数 9/20；未开始 S11。
- docs 与差异检查通过；四份相关文档按原分支提交推送，原始材料/确认留在受控忽略目录。下一动作是 Docker 环境恢复后的容器验收，不再要求本批人工复核。

### 2026-10-19-annotation-acceptance / E-ANNOT-02

- 用户告知标注完成；读取实际批次后，用户进一步明确已亲自核对原文并确认。保留 AI 初稿与已有未提交进度，补跑旧核对脚本，新增独立严格复验并记录用户确认，未再要求重复签字。
- 归档 36 数值、32 原引用、9 补充引用的复验结果；9 题完整，3 题保留 partial；人工结果以 human-review-v1/acceptance.json 与 review.md §十三承接，原 fixtures/rubric/模型基线不改。恢复清单序列化差异、补证省略写法与披露日期差异均留痕。
- 同步评测说明、标注手册与空白模板的状态说明。后续接评分器时显式选该人工版本；继续产品开发仍从 S06 核对依赖，不自动展开本轮范围外开发。

### 2026-10-19-ai-assisted-annotation / E-ANNOT-01

- 用户要求按 human-annotation.md 与 worksheet 对开发集进行标注。本轮以 AI 辅助核对方式完成批次 `2026-10-19-ai-assisted-01`：登记批次身份，逐项对照冻结原件页缓存核对 24 原值/12 变化率/32 引用/23 语义结论并拟就 12 题答案，新增 9 条引用补证；review.md 已保存到本地忽略目录。
- 核对期间执行工具（Bash/PowerShell/Agent）出现阶段性临时故障，machine-check 脚本未运行；hash 独立重算与变化率精确复算列为待补（review.md §十一）。未代填真人签字，human golden 保持 0；未运行 S06、未读保留集、未调用模型。
- 下一动作：恢复工具后运行脚本回填待补列；评测维护者对照原件抽查并签署 review.md §十二；签署后在本文件登记审核数量与结果 hash。

### 2026-10-19-human-annotation-docs / E-S02-02

- 用户要求把待标注数据、方法、流程与结果形式落实到 Markdown；本轮完成一份手册和一份包含全部开发集候选数据的填写表，并接入文档索引与评测入口。
- 开始时本地和 origin 工作分支均在 `54ff77c`，工作区干净。文档及逐项数据/原件 hash 检查通过，冻结题目、参考答案和 rubric 未改；实际人工审核保持 pending。
- 只做文档交付，不执行 S06，不查看保留题，不重启 Worker，不把既有网关校准当业务质量验收。下一次人工复核从手册和本地批次文件承接；下一次开发仍从 S06 的实际依赖核对开始。

### 2026-10-18-gateway-calibration / E-S03-02

- 用户指定同一研究网关的新凭据、`gpt-6.1-sol` 和 `high`；凭据只写已忽略的本机环境文件，不进入源码、证据或 Git。开始时工作区干净，HEAD `305327f`。
- 本轮范围：支持显式 high 推理配置，验证实际请求参数与真实网关，再用独立测试库运行一个固定资料校准案例。新模型运行单独标记，不改冻结 rubric、题目、预算或旧失败记录；S06 未开始。
- 配置实现：允许明确的 high/max，runtime 与 provider 使用同一配置；非法值在请求前失败。普通 baseline 同时核对冻结模型和 reasoning；只有 `--calibrate --config-calibration` 可另存用户指定配置，且只跑一个案例，保留原 4 工具/360 秒预算。
- 真实探测 `gateway-probe-1792337184425/manifest.json`：一次 HTTP 200 流式返回 OK，输入 4227 / 输出 5 tokens。真实研究原件 `config-calibration-1792337305831/manifest.json`：SHA-256 `64a660ad53a5a070628e81ed0a217e5780c313b2252a7cbb57e759fbed1bd5f0`，一个开发案例 11491 ms，3 次模型请求全部 200、usage 完整（输入 19259 / 输出 94）；公司解析、覆盖检查、报告提交三个工具完成。
- 校准终态 partial、sources=0：四次工具额度触发既有 finalizing 策略，未进入财报正文研究。这只证明新配置可进入现有循环，不证明完整研究、实时搜索、双期变化或业务质量；`comparableToFrozenBaseline=false`，原 rubric/资料/401 证据保持不变。
- 数据与执行隔离原件 `data/research-agent-upgrade/evidence/S03/gateway-calibration-session-2e14c27f-0e96-4109-8abb-4e08f29e56d8/manifest.json`：专用 localhost PostgreSQL 上应用 31 条迁移、单案例校准、容器删除均成功；应用/生产库未改。以上探测/校准目录均在 `data/research-agent-upgrade/evidence/S03/` 下。
- 验证目录 `data/research-agent-upgrade/evidence/S03/config-switch-1792337184425/`：59 项研究/API 测试通过（13 项 DB 默认跳过）、types、定向 lint、docs、两项拒绝冻结配置变更的检查及新旧结果离线核验通过。首次 types 暴露返回对象字符串类型拓宽，补充经过运行时校验的 high/max 类型声明后通过；真实请求行为未改变。模块检查仍只含三项既有超限，未处理暂缓的 Quality 问题，未做完整发布/构建。
- 生效边界：已有本地开发管理器和研究 Worker 未重启，仍在原启动环境；新配置由本次独立进程实测。下次维护开发栈时需重新加载 `.env.local`。OpenAI Docs 两个官方域名的本次文档抓取均 403，未据此推断该网关别名的官方可用性；保留用户指定模型，并以实际请求结果验证。
- 后续从 S06 承接；完整成功案例仍在 S13，独立人工金标待核对，本轮不增加完成步骤数。

### 2026-10-18-foundation-s01-s05 / S05 与最终交接

- 完成追加迁移 `20261018140000_research_version_foundation`，七张版本表、关系/部分唯一约束与五类不可变 UPDATE 触发器；旧四表和历史迁移未修改。实现可信 actor 下的任务幂等、计划/报告竞争写、文档版本、受控原件/页 receipt、attempt lease/fencing/预算继承及私有读取/取消 API。需求编辑、执行器、生产导入/OCR/UI 留给对应后续步骤。
- E-S05-01：`npm run test:research:postgres` 退出 0，13 项真实 PostgreSQL 测试通过；自动创建/删除专用容器，旧 30 条迁移 → 旧代码写报告与排队任务 → 追加第 31 条 → 重复 deploy → 独立 Prisma 生成/ORM smoke → 新旧代码读旧报告及旧 Worker claim/checkpoint → 集成测试 → migrate status，全部退出 0。旧代码取自 `d17ac89` 的真实文件，没有伪造旧 reader。
- 最终迁移原件 `data/research-agent-upgrade/evidence/S05/rehearsal-1eaa9b48-40c0-4d4c-9fae-92a2cc164304/manifest.json`，SHA-256 `13d98a56f745fafd85ec9b4219f7d4627bcf0bece7f4b7e2a8e960c84c1f08f8`；包含 HEAD、48 个相关文件 hash、逐阶段日志摘要和容器清理结果，可用同一命令重新演练。
- `npm run test:unit -- src/lib/company-research src/app/api/company-research` 退出 0，57 通过、13 DB 默认跳过；后者由上述专用命令全部实跑。`npm run type-check`、定向 ESLint、Python 采集脚本语法、Prisma validate、资料 hash/引用验证、docs 与差异检查通过。日志在 `data/research-agent-upgrade/evidence/S05/`；评测输入与 rubric hash 未改变。
- 检查过程发现并修复：报告验证原件 I/O 期间可能失去租约，发布前再次 fencing；API 测试移入 API 层消除本轮引入的反向依赖；ready 文档必须有解析产物与 parser 元数据。模块检查仅剩三项已有超限，未放宽规则。首次使用 `.cjs` 触发已有 ESLint 插件适用范围问题，改为仓库常规 `.js` 后定向检查通过。
- 环境局限：默认 `prisma generate` 因运行中 DLL 锁 EPERM 失败，没有终止用户服务；同 schema 在独立目录完整生成并实测通过。未做生产部署、未对业务库迁移、未运行完整 release/build/CI；Node 锁/Python 审计按原授权暂缓。
- 归档边界：原件、模型失败、迁移日志归本升级任务所有，保留至 S20/稳定归档；测试原件是合成持久化 fixture，不冒充真实财报解析证据。S03 起始测试容器和演练容器均清理，应用进程未动。
- 下一步 S06：先读入口、核对实际 Git/证据与开发库迁移前提，按新 document schema 统一发现/导入/披露时间；用户本轮仅授权 S01—S05，不自行执行 S06。后续修复模型凭据另存基线；人工核对后才能将参考答案晋为 golden。

### 2026-10-18-foundation-s01-s05 / S04

- 新增 task/document/revision 三个合同模块和 compatibility 读取，现有 contracts 导出新合同；新增实际行为测试和共享测试工厂。详见 contracts.md。
- E-S04-01：`npm run test:unit -- src/lib/company-research` 退出 0，51 通过、2 旧 DB 测试跳过；`npm run type-check` 退出 0；`check:docs` 通过（68 文件、388 链接）。原件日志 `data/research-agent-upgrade/evidence/S04/`。首次暴露的 Zod 联合判别及测试工厂类型问题已修复后复验。
- 已实现结构/关系/时间与引用存在性检查；没有将其宣称为语义证明或完整双期研究交付。模型鉴权问题仍在，不影响离线合同测试。
- 下一步 S05；新表与存储不接入旧 Worker 调度，避免旧代码按错误任务语义执行新请求。S16/S17 再开放完整修订和更新。

### 2026-10-18-foundation-s01-s05 / S03

- 实现研究专用封闭资料适配器、真实网关 runner、离线原件核验命令；设置仅 localhost `research_test*` 空库与随机 actor，未接触业务任务。增加 `.gitattributes` 固定评测 JSON 的 LF，防止跨平台换行破坏 hash。
- E-S03-01：校准 1 次，开发 4 次；实际网关均 401，终态 failed，无工具执行/无模型答案/usage unknown/费用 unknown。12 个双期问题按旧合同单独分类 unsupported，不计算可比质量提升。脱敏摘要 `fixtures/company-research/baseline-v1.json`；原件目录和复验命令见 baseline.md。
- 开发 manifest SHA-256 `5e59b94618ff77385c739296129fc4387af9bfc573dc7fae4fff5bf69dec9a01`。`verify-baseline.ts` 离线核验 4/4 通过；`npm run type-check` 退出 0。完整模型质量验收未通过，原因是鉴权；并非 S04/S05 的实现阻塞。
- 下一步 S04。测试容器仍运行用于 S05，未启动新业务服务；研究模型凭据需要维护者修复后才能取得成功模型基线。

### 2026-10-18-foundation-s01-s05 / S02

- 新增采集、提取、验证脚本和 `fixtures/company-research/` 固定输入；6 家/12 年报，4 开发/2 仓库外保留，无公司交叉。真实原件与派生扫描样本明确区分。
- E-S02-01：`node --import tsx scripts/research/verify-fixtures.ts`（带外部路径）退出 0，8 开发文档、24 原始数值、32 引用、12 问题；保留 hash/隔离通过。原件 `data/research-agent-upgrade/dataset-v1/`；验证 `data/research-agent-upgrade/evidence/S02/verification.json`。开发答案 hash `000f1fdbdaad9f48d98c632bbe6afa3f602a5c550a3ffc8b95e2f0a35d101cf8`；rubric hash `81df0d53f38650a955957896c6c9883030588dc455cb482b95eff2ac7e0f0d45`。
- 验收分层：已完成资料和评分准备、确定性引用核查；人工 golden=0，独立人工标注待执行，保留答案 pending；没有宣称真实模型质量通过。准备脚本首次曾因运行格式/引用转录错误失败，已按原文修正后复验，不改变验收门槛。
- 新建 disposable 容器 `wolfbot-research-test-20261018`，端口 55439；只用于本轮研究验证，旧迁移 deploy 成功。业务库/服务未改。继续 S03。

### 2026-10-18-foundation-s01-s05 / S01

- 用户授权完成 S01—S05。本步核实调用链、actor 归属、模型/数据依赖和现有缺口，冻结单公司双期三问场景；创建 `baseline.md`。
- E-S01-01：源码起点 `d17ac89`，27 个文件 hash 清单在 `data/research-agent-upgrade/evidence/S01/workspace.json`，SHA-256 `4e4d54717b28f0270e301164f901ed74512392bca8f4c102888879195e1b20dc`。研究单测 43 通过/2 DB 跳过；文档通过；模块检查三个既有超限失败，详见 baseline。日志与清单归本升级任务所有，保留至 S20/归档。
- 本步未启动服务、未调用模型或修改业务数据。现有端口 3000/8000/5432 在监听；Docker 可用。接下来 S02，文件范围为计划文档、研究 fixtures 和采集/验证脚本。

### 2026-10-18-plan-setup

- 用户目标：将已选方向拆成 20 步，建立开发规范，并让新会话能接续。
- 已完成：静态核对当前研究代码与规则，建立计划、入口、规范、状态和决策；未执行任何开发步骤。
- 重要变化：核对到搜索已迁移为 DeepSeek Search/Fetch，后续必须从实际源码承接。
- 下一动作：用户启动开发后执行 S01。不存在需要新会话自行补猜的“已经做完一半的功能”。
- 验证：见 E-SETUP-01。

后续每次会话结束追加一段，至少包含：会话标识、对应步骤、改动文件、已完成/剩余、验证证据 ID、阻塞、下一具体动作、启动或遗留进程。上方“当前交接”同步更新，但不重写旧历史。

### 2026-10-19-s05-s10 / S08 收尾

- 用户授权连续实现 S05—S10；S05 复验、S06 和 S07 已独立提交/推送。现提交 S08 CPU 服务、TS 适配、质量门及 S06 修订披露隔离补丁；S09/S10 文件留在工作树，继续分别归档同步。
- 验证见 E-S08-01/E-S06-02；机器 OCR/停止/数据库检查通过，人工样本抽查 pending。Docker 构建引擎故障和合成表头误字已登记，S08 不标 done。模块检查只有既有 chat/data-prefetch/market-data API 超行数失败；未调整预算和既有 Quality 门。
- 独立临时原生 PG 已停；仅关闭自己创建的构建客户端，没有重启用户服务。parser 回环进程在最终交接前清理/登记；资料/模型/测试证据在 data 中保留。下一动作是完成 S09/S10 专题与提交，再补人工/容器验收。

### 2026-10-19-s05-s10 / S09 收尾

- S08 已提交推送 `d3b7311`，远端 SHA 核对一致。S09 独立交付 decimal-v1、金额/指标规范化、可比性与累计转单季、兼容事实合同和复算脚本；D20 说明边界。S10 文件继续保留，不混入本提交。
- E-S09-01：16 项边界测试、24 金额/12 变化复算、types、定向 lint、docs 与差异检查通过；原输入/源码 hash 已记录。本步为确定性计算模块验收，未调用真实模型，也未解除 S08 人工/容器待验收。
- 下一动作：完成 S10 API/索引/数据生命周期专题、检索证据和独立同步；范围止于 S10。既有用户进程不变，临时 parser 在最终交接前停止，独立 PG 已停。

### 2026-10-19-s05-s10 / S10 与最终交接

- S09 `e7707a9` 已提交推送并核对远端一致。S10 交付任务私有索引、作用域/asOf/字段过滤、中文词法排序、有界 search/read、API 权限边界、追加迁移、保留的 v1 基线和原生临时 PG 备用 runner；D21 与 API/数据/生命周期文档已同步。
- E-S10-01：94 项 TS/API、18 项真实 PG、旧库升级/旧代码兼容、types、定向 lint、docs 与差异检查通过；最终 k=5 命中 23/24 页、完整 11/12 问题。保留基线/调参/剩余风险续页漏项，未读取保留集、未调用模型或部署生产；旧模块三项超限仍失败。
- 本轮授权 S05—S10 的源码与专题按步提交，S08 明确仍为 in_progress，9/20 完成。待用户核对新 OCR 样本（不是重签旧 S02）、Docker 恢复后补镜像/容器/资源验收；没有启动 S11。业务 OCR needs_review 不因样本核对自动解除。
- 收尾核对并停止自己的原生 parser 根进程及模型子进程，7821 已无监听；最终独立 PG 停止且无本研究临时 postgres 进程。只停止自己创建的构建客户端/测试服务，没有重启用户 Docker、Web、market-data 或 Worker。原图、人工对照材料、失败记录、模型和缓存全部保留在受控忽略目录；人工材料未被覆盖。

### 2026-10-18-wolfbot-migration

- 用户目标：项目更名为 wolfbot，将当前进度同步到 `xuwenjun2001/wolfBot`，覆盖目标仓库当前文件。
- 实施：统一网站、登录、桌面/PWA 名称、生成页面品牌、图标、包与仓库元数据、文档和会话入口；已有源码/测试/计划进入同一迁移快照。
- 兼容边界：保留 `QUANTPILOT_*`、数据库/服务标识、Python 包、已发布 Skills 和外部作用域，继续使用已有本地资料；本机目录仍为 `D:/QuantPilot`。
- 同步方式：以当前工作区构建完整目录树，替换目标分支的文件内容；目标旧文件不合并进来，原目标提交作为父提交保留。原 QuantPilot 远端不接收本次提交。
- 开发进度：仍为 0/20，下一步 S01。更名与仓库迁移不算研究功能升级完成。
- 验证：见 E-MIGRATION-01；本轮未启动应用服务或改变运行进程。后续从 S01 核实基线，先处理或登记已有模块尺寸债务。

### 2026-10-18-github-sync-rules

- 用户目标：暂缓处理 Quality 失败，将后续 GitHub 同步约定写入根 `AGENTS.md`，供新会话承接。
- 已完成：明确 wolfBot 为默认同步目标、按任务提交和推送、工作分支与已有改动边界、忽略项、并行提交处理、验证与远端 SHA 核验；旧项目远端仅供参考，首次覆盖授权仅用于首次迁移。
- CI 事实：迁移提交 `0943107` 的 [Quality 运行](https://github.com/xuwenjun2001/wolfBot/actions/runs/39125367729) 失败。3 个 Node 任务在 `npm ci` 因 `@emnapi` 相关锁文件项缺失/不一致中止；Python 后端在安全审计因 5 个包的 10 条漏洞记录中止。后续测试和构建不能按已通过记录。
- 暂缓范围：用户明确要求先不处理这次失败；保留检查门禁，不把同步规则改动扩展成依赖升级、CI 修复或生产发布。下次涉及依赖修改时仍验证安装与审计。
- 验证：`npm run check:docs` 退出码 0（65 个 Markdown、387 条本地链接）；`git diff --check` 退出码 0。本轮只修改文档，未重跑代码测试或完整 CI。
- 开发进度：仍为 0/20，下一步 S01；本轮未启动应用或 Worker。

### 2026-10-19-s13-human-acceptance / S13—S15 结清

- 用户针对已展示的新报告核查问题明确回复“已逐项核对，通过”；依据本次人工确认保存受控 human-acceptance-01/ 回执，绑定 task/report v1/canonical hash。登记时间为北京时间 21:55:42，未推测实际复核完成时刻，也没有重复要求确认或代签。
- 起点 2964ee7598ace01cfa984766a2f1bb49526bbc0f，分支 codex/research-agent-s11-s15，工作区干净；本次仅修改 progress.md 与 s11-s15-validation.md。E-S13-02 记录报告、原资料、源码和浏览器证据 hash 核对，原人工待核查材料及 closure 作为历史保留，未向应用/业务库补写验收。
- S13 人工要求满足，S14/S15 已通过的自身验证与依赖结清；S01—S15 共 15/20 完成。没有新模型/OCR/DB/浏览器执行或源码变更，既有模块尺寸债务、暂缓 Quality 和完整 E2E/CI 的边界保留。
- 文档检查 71 Markdown / 441 本地链接、差异与回执绑定复核通过，见 E-S13-02；确认材料与日志留在忽略目录，未新增服务进程。本次止于验收归档，下一工作包为尚未启动的 S16。

### E-S16-01：请求修订与安全重新规划

- 日期 / 会话：2026-10-20 / `2026-10-20-s16-s20`。起点 HEAD `ac70c7e3a53e89511c1c37aa979a8212d19118fc`，分支 `codex/research-agent-s11-s15`，起点干净；本轮只提交明确相关文件。
- 实现：新增同源 `POST /api/company-research/tasks/{id}/revise`，要求认证的 `research.report.run`、`Idempotency-Key`、`expectedRequestRevision` 与 `expectedPlanRevision`。严格允许修改三问、两期和 `asOf`；不接受公司或预算字段，变更期间边界必须换 ID。事务内追加不可变 request/plan、使活跃 attempt superseded 并推进 generation、重置为新版本 checkpoint 后排队。取消优先；晚到 worker 写入受 fencing 拒绝。任务预算、工具数、tokens、开始时间和 deadline 不变；耗尽预算时新 attempt 只封存 partial。已导入文档保留；旧报告与其原 request spec/asOf 继续可读。工作台展示修订状态、编辑表单和旧报告提示；SSE 事件后重新拉取权威快照。
- 单测：`npm run test:unit -- src/lib/company-research src/app/api/company-research/tasks src/app/company-research/financial` 退出 0，18 files passed / 6 skipped，123 tests passed / 40 DB-only skipped。定向 API 合同/同源测试包含在通过数中。
- PostgreSQL：`npm run test:research:postgres` 退出 0；40 项数据库测试通过，包含新旧 revision 并发、同键重试、取消与修订竞争、过期 worker fencing、耗尽预算修订、旧报告及 asOf 保留、旧库升级与旧 reader 兼容。runner 专用 Docker 容器已移除，未迁移应用/生产库。原始 manifest：`data/research-agent-upgrade/evidence/S05/rehearsal-aed7d5c5-55bb-4c83-bd36-a563236aa609/manifest.json`，SHA-256 `2f72e082cea2e8c3567421f6d61c8dcef6050acfc4507e6307dc4c507e326d23`；共享 runner 当前将证据目录固定写入 S05。
- 其他验证：`npm run type-check`、本步 TS/TSX 定向 ESLint、`npm run check:docs`（71 Markdown / 443 本地链接）和 `git diff --check` 退出 0。`npm run check:module-boundaries` 退出 1，报告既有 `src/app/[project_id]/chat/page.tsx`、`src/lib/quant/data-prefetch.ts`、`services/market-data/src/quantpilot_market_data/api.py` 三个与本步无关的尺寸超限；没有本步新增路径错误。
- UI 检查：用保留 S13 报告启动只读 `serve-financial-workbench.js`，打开报告并展开修订表单；窄屏可见三问、年度区间、截止日和提交按钮，无布局重叠。QA 服务已关闭；未提交表单、未写 API/数据库。QA 文件在 `data/research-agent-upgrade/evidence/S13/2026-10-19T05-19-41-904Z/workbench-qa/`。
- 限制：未调用真实模型、OCR 或实时公告；本步验证的是 fixture/PG/API 合同和只读 UI，不冒充真实模型更新验收。下一步 S17 核查新公告检查、来源去重、报告历史及 claim/evidence 差异。

### 2026-10-20-s16-s20 / S16

- 用户要求开始实现 S16—S20；本会话先完成 S16 并按每步顺序推进。S16 代码、测试、文档、交接按仓库规则完成提交和远端核对后，再登记 S17。
- 当前 S16 状态为 done；S17—S20 仍为 pending，未预先计入完成数。生产部署、真实模型运行和保留集优化不包含在 S16。

### 2026-10-20-s16-s20 / S19—S20 收尾

- 完成 S19 精确评分/可信 Skill 实验/报告指纹、四公司配对及唯一候选拒绝、最终两家保留与未签署人工材料；补验 S12 行内单位缺口。14 个真实任务覆盖 6 家公司，完整总账保留；两次零模型输入失败按 D31 另存，不覆写、不重置任务预算。证据 E-S12-02/E-S19-01。
- S20 交付架构、演示、五张真实或明确标注合成截图、认证存档旅程与专题文档已完成；本轮修复 Windows 检查启动、职责尺寸、品牌 guardrail、UI 重复 key 与 server-only 导入。完整发布门仍失败，独立 build/types/lint/后端等通过，证据 E-S20-01。S19/S20 保持 blocked，总验收 18/20。
- 下一会话先核对 Git 和已保存证据，读取外部审核包完成实际人工参考/评分；不得再开当前保留任务。S20 在可用 Linux 环境跑原质量门并解决实际失败，暂缓的锁文件/依赖审计不顺带展开。所有本轮测试服务已停，用户 3000/pid14248 保留；未部署、未触碰业务库。本轮只同步已审查的相关源码、测试、规则和文档，原始证据/私有题仍受控保存。

### 2026-10-20-s19-human-review-and-s20-inventory

- 用户已核查并确认两份最终保留报告的呈现内容和缺口；登记 E-S19-02 独立回执，原机器结果/未签署包均不改写。计入缺答后为 9/18 数值、3/6 问题、3/6 冻结 claim 支持；S19 仍因质量门失败 blocked，原“等待人工核查”阻塞已结清，总验收保持 18/20。
- 依据用户要求整理 S20 全部 35 个失败，21 文件、分类总数与原日志一致；原测试名和位置进入 release-failures.md，副本字符串核对保存本地清单。本次只更新 5 篇文档；不启动新模型、完整发布门、业务数据库或日常服务。后续依据真实失败安排修复，不把清单整理当作测试已经通过。
- 本次 `npm run check:docs` 退出 0（76 Markdown / 534 本地链接），日志 `S20/failure-inventory-20261020-01/docs-check.log`；`git diff --check` 通过。只检查本轮文档与证据一致性，没有重跑应用测试或发布门；记录原通过项时保留其历史版本和适用范围。

### 2026-10-20-review-fixes / R2-R3

- 更新预算、来源检查/重试、追加迁移和工作台本轮/累计用量显示已完成；46 项 PG 回归通过后恢复 S17 done。D32 取代首次 deadline 限制，保留旧模型实验约束。接下来修原发布失败中的平台/fixture 适配。

### 2026-10-20-review-fixes / 发布测试适配

- 修复路径夹具、CRLF 文本比较、wolfbot 截断文案断言和恶意 tar 夹具原始权限；preview 的 Linux 监听接管与非 Linux 安全回退分别断言，不修改生产沙箱策略。
- Windows 定向验证：6 文件 28 passed / 4 平台分支 skipped；图片路径定向 1 passed；恶意包 source lock 漂移定向 1 passed，均退出 0。定向名称过滤未执行的用例不算通过；19 个符号链接权限用例仍等待 Linux 真实文件系统验证。
- 正在准备隔离 Linux 测试环境；随后修 Skill 读取规范化与测量并发。原 release-failures.md 的历史结果保持不变，S20 继续 blocked。

### 2026-10-20-review-fixes / Skill 换行与超时

- Skill source/package 文本统一 LF，LF/CRLF 上下文和资源 hash 等价回归通过；冻结 5000 字符场景实测 4986。定向 8 项通过，types 和 Skills registry/14 脚本检查通过；源码提交 2867253。
- Vitest 采用实测的 2 worker 并发，原两项超时在整套中为 2013/635 ms，保留 5000 ms 限制。Windows 新发现 25 项临时短路径夹具失败；规范化路径后 27 项定向通过。19 项链接权限测试等待 Linux，不跳过安全断言。
- 受控日志/JSON 已从 tmp 转存 release-repair-01，原始全量失败和历史模型成本保留。Linux npm ci 的既有 @emnapi 锁漂移按原用户边界暂缓；隔离依赖验证不等于可复现安装门通过。正在补真实认证、行情解析、create/start HTTP 旅程并准备最终验证。

### 2026-10-21-review-fixes / 财报质量门重验

- 已完成四个登记开发案例，保留全部 partial/失败和 136 次工具消耗；全分母数值 36/36、问题与支持结论均 9/12，后两项门槛失败。补写 E-FIX-QUALITY 与逐公司结果/原件 hash；没有重跑旧保留集或扩充模型任务，旧人工确认继续有效。
- 真实认证入口旅程与第三次 46 PG/34 迁移回归已通过，临时 PG 已停止。Windows 完整 release 的 17 个前置检查通过，单测停在 19 个 symlink EPERM；后续独立 types、后端 lint/308 测试和生产构建通过。首次 types 内存不足保留日志，有界内存重验通过，没有修改测试超时上限。
- Linux 副本对应 5659ecf，原生用户命名空间已实跑；依赖缓存、Python 3.14 与 Prisma/编译器正在隔离环境准备，安全测试和完整 release 待执行。S19/S20 保持 blocked，生产和业务库未操作。

### 2026-10-21-review-fixes / Linux 测试夹具补充

- 首轮 Linux 完整单测执行了全部 19 个原 symlink 用例，发现两项此前被 Windows 分支遮住的夹具问题。当前只修改 generated-project-sandbox.test.ts、workspace-files.test.ts 与交接；Linux 定向六项和 Windows 过滤定向三项通过，准备重验完整 release。首次完整日志/JSON 保留，不覆盖为绿色结果。

### 2026-10-21-review-fixes / 最终工程与质量交接

- 按用户指定顺序完成 R1—R3、平台测试、Skill LF 和有界并发修复；最终 a4b5a64 的 Linux 默认 release 22/22 通过，1465 前端测试通过/76 跳过，后端 308 通过/22 跳过。两公司真实解析→创建→开始入口及 46 PG/34 迁移已通过；工程通过不改变财报质量失败结论。
- 本次只收尾 progress.md、release-failures.md、delivery.md，保存 E-FIX-RELEASE-FINAL 的原件 hash 和适用范围；旧 35 失败、后续 Windows EPERM、Linux 首次夹具/依赖准备失败全部保留。代码门没有提高超时、字符/工具预算或跳过安全反例。
- 财报 36/36、9/12、9/12，S19/S20 继续 blocked、18/20。下一轮质量工作先改善原因证据与核验完成度，再独立安排未见样本验收；本批不追加模型。暂缓依赖门未修，未部署或迁移日常库。
- 自有容器按完整 ID 核对后移除；PG/QA server 均已停，受控证据和临时 checkout 保留。文档检查 77 Markdown/539 本地链接通过，差异检查通过；按仓库规则提交/推送本次三份交接，远端身份以实际核对结果为准。

### E-FULLSTACK-HTML-01：全栈面试 HTML 教学

- 日期 / 会话：2026-10-21 / `2026-10-21-fullstack-tutorial`。起点 `0864b35983558c31430aa4ffec42e72437f71f5e`、工作区干净，分支 `codex/research-agent-s11-s15`。本次只做用户要求的教学页面与文档入口，不启动研究开发步骤。
- 交付：[财报研究工作台全栈面试课](../../learning/09-financial-research-fullstack.html)，单文件离线 HTML，无外部脚本、字体或服务依赖。14 章覆盖请求流转、数据合同、SSE、幂等与事务、租约接管、解析计算、原文与语义、报告更新、安全、测试、观测与扩展取舍。6 组演练使用合成状态；36 道题各含口述答案、机制、误区与追问，支持筛选、随机抽题、60 秒计时、自评和打印。
- 源码核对：15 份节选按起点提交逐行抽取并固定 GitHub SHA/行号；与当前对应源文件的 LF 规范化内容核对一致。明确 SSE 是失效通知加权威快照；revise 幂等保证不重复追加，路由仍重读当前快照；D32 真正新来源可开独立预算轮次，pending 重试/修订/接管不增额。区分当前实现、教学简化、后续方案及模型质量限制。
- 浏览器：Playwright 1.60 / Chromium，真实 `file://` 打开并关闭网络，87 项行为与结构断言通过；覆盖六组演练的竞争/故障分支、输入拒绝、题库、计时、本地记录恢复/清除、存储拒绝降级、打印展开及恢复。HTTP 请求 0、浏览器运行错误 0。桌面/手机截图已人工查看；微调手机标题后，最终 320/390/768/1024/1440 五种宽度无页面横向溢出，手机标题为两行，源码与内部锚点复核通过。
- 证据：`data/research-agent-upgrade/evidence/fullstack-tutorial-20261021/` 保存浏览器 JSON、复核脚本、源码范围及五张截图。`verification.json` SHA-256 为 `a1e58146989a868a585af014f4de65569bd35bdb5630b0125b9b2735ae21e52b`；最终样式复核 `final-visual-check.json` 为 `ad19e7b79f6fb70b11abf0a2d744fff31d72a1bb3cae2777ab338be2e616389c`；最终 LF HTML 为 `7b0e84ec6da9ddfd67062ea9e6bc7fdd3a1aa3d87da91e37a8935f43f738bdf9`。这些受控本地 QA 产物不纳入 Git，页面与导航正常提交。
- 文档索引：`docs/README.md`、`docs/learning/README.md` 与 `delivery.md` 已加入入口；`npm run check:docs` 退出 0，77 Markdown / 544 本地链接通过。暂存差异在本次同步前检查，原日志保存在同一证据目录。
- 验证范围：没有修改产品源码/依赖、运行数据库或模型、重跑产品测试/完整 CI、部署或操作业务数据。原 18/20 与 S19/S20 blocked 保留；原质量与依赖门限制不变，教程中的合成演练不冒充产品验收或生产数据。

### 2026-10-21-fullstack-tutorial / 教学交接

- 用户目标是把已实现模块的逻辑与技术细节做成教学 HTML，用于全栈面试。页面按业务场景、实现、故障反例、真实源码与口述训练组织，默认浏览器直接打开；学习记录只存在当前浏览器，不作为能力评分。
- 后续继续研究升级时仍按原计划与质量阻塞承接；本次不改变步骤状态。维护教程时先复核实现变化，再同步文字、模拟行为、固定源码 SHA 与题库，避免将旧预算语义或未来架构写成现状。
- 本轮仅提交教学页、两个索引、交付入口与本进度；验证与远端 SHA 在收尾核对。没有新增服务进程，离线浏览器均已关闭。

### 2026-10-24-agent-interview-proposal / 升级提案交接

- 用户要求把此前的 Agent 升级建议落实为 Markdown 供审阅。新增 [Agent 升级提案](agent-upgrade-proposal.md)，核对起点 e79eac2 的单研究循环、独立同模型审查、公开 checkpoint、预算与历史评测；清楚区分已有能力、拟议实现和历史验证。
- 草案覆盖 P0—P3 优先级、三个研究员与协调器、局部重规划、父子任务权限/预算/故障、主动审查、上下文与人工介入，以及 A/B/C/D 对照实验。R0—R6 是未开工的候选工作包，每项列依赖、产物与完成标准；面试问题对应所需的实际证据。
- 同步研究计划入口与 docs 总索引。npm run check:docs、差异检查通过；没有修改产品源码/依赖、操作数据库、运行真实模型或重跑完整 CI。按仓库默认规则仅同步本次四份文档，推送与远端 SHA 在收尾核对。
- 下一动作是由用户审阅范围与优先级；若后续进入实现，按指定范围登记新实验合同和当前源码起点，不重开历史模型预算或将已见样本视为未见。原 S19/S20 blocked 与 18/20 状态保留。
