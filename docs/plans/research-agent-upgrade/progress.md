# 财报研究 Agent：进度与会话交接

这是唯一的当前进度来源。计划见 [plan.md](plan.md)，规范见 [development.md](development.md)，选型见 [decisions.md](decisions.md)。更新时间使用北京时间。

## 当前交接

| 字段 | 当前值 |
| --- | --- |
| 最后更新 | 2026-10-19（北京时间） |
| 计划版本 | v1 |
| 总体状态 | S01—S07 完成；S08 代码及机器验收通过，人工抽查与容器复验待齐；S09—S10 已实现，正在独立收尾归档。既有人工作业仍为 9 完整/3 partial、完整参考公司 1 家，真实模型质量未验收 |
| 已完成开发步骤 | 7/20 |
| 当前进行中步骤 | S08；本会话用户授权范围 S05—S10 |
| 下一步骤 | 完成 S08 人工抽查/容器验证交接；本轮同步 S09—S10 后结束授权范围，S11 未开始 |
| 下一具体动作 | 人工检查 S08 human-review-01/review.md 并记录结果；Docker 引擎恢复后补容器构建/健康/资源验证。S09—S10 的计算与检索已在开发数据和独立 PostgreSQL 验证，正在更新专题及提交 |
| 当前会话登记 | 2026-10-19-s05-s10：起点 7ae788b，工作区干净，分支 codex/research-foundation-s01-s05；S05 复核、S06/S07 实现并同步，现收尾 S08—S10。修改范围为来源/解析/财务/检索应用模块、相关 API/迁移/测试、独立 services/document-parser、Docker 配方及交接文档；不读保留集，不部署生产 |
| 工作区 | `D:/QuantPilot`；在其他电脑以实际项目根为准 |
| 当前参考分支 / HEAD | `codex/research-foundation-s01-s05`；会话起点 `7ae788b`；S06 `6f6d48d`、S07 `45d70bc` 已推送；后续同步身份按各步骤记录与 `git log` 核对 |
| 目标仓库 | `https://github.com/xuwenjun2001/wolfBot`，默认分支 `main` |
| 本轮涉及文件 | `src/lib/company-research/` 的 acquisition/parse/OCR/financial/evidence 与测试；tasks 文档解析/检索 API；S10 Prisma 索引迁移及隔离 PG runner；`services/document-parser/` 与 compose；配置、公司研究、基础设施、数据/交接专题。真实样本、模型和报告留在忽略的 data 目录 |
| 已有改动提醒 | 本轮起点干净，无来源不明改动；S08—S10 按步骤暂存，不能把尚未提交的后续文件误当作已推送；最终以 git status/远端 SHA 为准。冻结资料、旧人工确认和保留集未改 |
| 运行环境 / 进程 | Windows/Python 3.12.14，Docling 2.140.0、RapidOCR 3.10.0、ONNX 1.31.0、Torch 2.14.1+cpu。启动过独立回环 parser；Docker 解包后接口 500/containerd SIGBUS，未重启共享引擎/服务。数据库改用新建独立原生 PG 16.14 集群，验收后已停止；未连接应用库执行迁移 |
| 模型与数据费用 | S06 有公开公告查询/原件下载，后续 OCR、计算和词法检索无 LLM/搜索调用；本地 CPU 费用未计量。历史模型 401 与四次校准的 unknown 费用记录保留，不并入本轮质量成绩 |
| 阻塞 | 新 OCR 真人抽查待回复；Docker 容器启动/资源待环境恢复（失败时 C 盘约 2.3 GB）。合成第二页“合并口径”识别为“合井口径”，保留 needs_review。既有三题 q2 缺因果证据、人工版本接入 runner 和真实模型验收仍未解决 |
| 最近验证 | 89 项 TS/API 单测通过，普通运行跳过 18 项 DB；独立 PG 旧库升级/旧代码兼容/18 项 DB 实跑通过，类型检查通过；parser pytest 3/ruff/lock 通过，真实 OCR 18/18、合成金额行列 12/12。S10 词法定位 23/24（k=5）；docs 70 文件/429 链接通过；模块门仍因三个未改旧大文件失败，未放宽门禁 |
| 受控资料恢复 | 开发资料在 `data/research-agent-upgrade/`；本机 `RESEARCH_HOLDOUT_ROOT=D:/QuantPilot-private-evals/research-v1`，换机须经受控归档恢复并核对登记 hash；这里不记录保留题/答案 |
| 范围提醒 | 本轮授权 S05—S10；不展开 S11 执行器、保留集、生产部署或既有 Quality 修复。人工确认和旧 partial 结论保持 |

## 步骤状态

状态：`pending` 未开始；`in_progress` 正在实现或等待必需验证；`blocked` 有具体外部阻塞；`done` 本步验收通过且证据齐全。依赖未完成的 pending 不自动算 blocked。被重开的步骤保留原证据并记录原因。

| 步骤 | 工作包 | 最低依赖 | 状态 | 证据 / 阻塞 |
| --- | --- | --- | --- | --- |
| S01 | 现状核实与首版场景 | 无 | done | E-S01-01；baseline.md |
| S02 | 固定资料、人工答案与评测合同 | S01 | done | E-S02-01/02、E-ANNOT-01/02；用户确认核查 4 家/12 题，9 完整/3 partial，完整人工参考公司 1 家；冻结 v1 字段保留原状态，人工批次另存 |
| S03 | 实测基线与失败记录 | S01、S02 | done | E-S03-01 原 401 基线保留；E-S03-02 新配置 4 次请求均 200，单案例工具调用可用、结果 partial；不作同题质量对照 |
| S04 | 版本化领域与事件合同 | S01、S02 | done | E-S04-01；contracts.md；51 测试通过/2 DB 跳过；types 通过 |
| S05 | 持久化、隔离与迁移 | S04 | done | E-S05-01；七张版本表、actor repository/原件存储/API；13 项 PG 测试和旧库升级/旧代码兼容通过 |
| S06 | 财报发现、导入与时间证据 | S05 | done | E-S06-01/02；公网原件/hash、八份日期修正；追加修订原件不能回溯旧披露日的隔离/重试实跑 |
| S07 | 文本 PDF / HTML 定位解析 | S06 | done | E-S07-01；八份原件/32 引用定位，v1/v2 兼容、HTML/截断/跨页与 PG 发布校验 |
| S08 | OCR 与表格结构解析 | S07 | in_progress | E-S08-01；CPU 服务与取消/超时/缓存实跑，真实金额行列 18/18、合成 12/12；真人抽查 pending、Docker 引擎故障；保留“合井口径”误字与 needs_review |
| S09 | 财务口径与变化计算 | S07、S08 | in_progress | decimal-v1 与边界单测、24 金额+12 变化复算通过；等待独立文档/提交收尾，OCR 未复核数据拒绝成为 known |
| S10 | 证据检索与按需上下文 | S07、S08、S09 | in_progress | 已实现版本化索引迁移、前置作用域/asOf 过滤、词法排序及有界读取；18 PG 与 k=5 的 23/24 页命中通过，正在独立归档；S11 未接线 |
| S11 | 研究计划与 Agent 循环 | S04、S05、S09、S10 | pending | — |
| S12 | 结论与证据分层核验 | S09、S11 | pending | — |
| S13 | 报告与变化表完整交付 | S11、S12 | pending | — |
| S14 | 工作台与事件流 | S04、S13 | pending | — |
| S15 | 原文定位与证据阅读器 | S07、S08、S12、S14 | pending | — |
| S16 | 修改计划与安全重新规划 | S04、S05、S11、S14 | pending | — |
| S17 | 新财报更新与报告差异 | S06、S09、S13、S15、S16 | pending | — |
| S18 | 恢复、隔离与运行观测 | S05、S11、S14、S16、S17 | pending | — |
| S19 | 评测对照与 Skill 改进实验 | S02、S03、S13、S18 | pending | — |
| S20 | 综合验收与面试证据包 | S01—S19 | pending | — |

`done` 数量与上方完成数一起更新。计划文件不复制状态；一旦状态矛盾，以实际证据核对后修正本文件，不静默选择较乐观的记录。

## 初始核对得到的事实（历史，当前状态见上表）

- 公司研究已使用 DeepSeek Search/Fetch，当前模型与搜索凭据分别配置；旧会话中的 Tavily 描述已过时。
- 当前研究合同主题为主营业务、上下游和近期财报；双期变化研究仍是拟新增能力。
- 已有来源 hash、引用存在性校验、研究状态、Worker fencing、SSE 与取消；不能因此声称升级步骤已完成。
- 扫描件 OCR、检索任意已读来源、结构化计划编辑和报告版本差异需按计划实现。
- S01—S05 新增可复验的基线、评测、版本合同和持久化基础层；新请求先保存 draft，S11 才接入双期执行。旧 Worker 不领取新表。
- 原 S03 网关基线全部在鉴权时失败；用户指定新模型后另存校准，4 次请求均 200，但提前收尾且无财报来源，不是质量提升证据。后续人工确认按 E-ANNOT-02 单独归档，不能反向把旧模型运行变为通过。

## 验收证据

### E-S08-01：CPU OCR、表格、停止与质量边界

- 日期 / 会话：2026-10-19 / `2026-10-19-s05-s10`。代码范围：独立 `services/document-parser`/uv.lock/compose、ocr-parser/parse-service、v2 nativeText、报告已知事实质量门、相关 API/测试与专题。验证工作树同时含后续 S09/S10，源码 hash 清单在下述 PG manifest，不把 HEAD 单独当作验证身份。
- 运行：Windows 11、Python 3.12.14、Docling 2.140.0、RapidOCR 3.10.0、ONNX 1.31.0、Torch 2.14.1+cpu/torchvision 0.29.1+cpu；CUDA build=null，实际 CPU、2 线程/单模型 Worker。`data/research-agent-upgrade/evidence/S08/runtime.json` SHA-256 `bfe74f09794a7ba4d27d4ef45c6028149d2c0aa2a2c388eaf5c155e6ef8f3fa5`。模型预置、运行离线；不改 market-data 环境。
- 真实样本：`DOCUMENT_PARSER_PROBE=.../S08/probe-02`，`uv run --no-sync --project services/document-parser python services/document-parser/probe.py` 与 `node --import tsx scripts/research/verify-ocr.ts .../S08/probe-02` 均退出 0。派生茅台扫描页、茅台原生 p5、美的原生 p9 共 **18/18 行/年份列/金额**匹配，实际框与 needs_review 保留；耗时分别 63328/27125/15094 ms。verification.json SHA-256 `d21c903c8c19782f2d2fdf6a5a0633ed83dd033be4da6e39e8c0615ef01dd088`。早期 probe-01 也保留，不当成额外独立样本。
- HTTP 实跑：`verify-parser-service.ts` 退出 0；最终 `S08/service-2026-10-18T18-38-21-646Z/report.json` SHA-256 `e95c3819b36fc1990c08b96b6ba5f137d10663f1923fcb394e7dabd21293a101`。两页合成压力表金额按指标行/2024 与 2023 年列 **12/12** 命中，括号负数、负号、小数、零、万元和三列合并表头可定位，保持两个独立表。第二页“合并口径”被识别成“合井口径”，不自动纠正。`service-2026-10-18T18-18-19-285Z/cancelled.json` 实际保留第一页/第二页截断，cancelled_partial，8406 ms；后续缓存重放两页可能在取消前已完成，记录为竞争完成，不能重复算取消成功。timeout_partial 停止进程后下一任务/缓存复用通过；页缓存命中耗时不称冷启动耗时。
- 常规：ruff、pytest（3 项）、uv lock --check 均退出 0；普通研究 TS/API 89 项通过/18 DB 跳过。独立 PG 实跑 18 项（含 known 事实拒绝未复核 OCR）通过：`S05/rehearsal-b666636c-669e-48b8-81cb-63dfac568ace/manifest.json`，SHA-256 `1e2dc97c0a1d0620d4e8c62afdaa86052a8f6b379bba9689b3426fae52f9e968`。类型检查退出 0。完整 PyPI audit：130 可查包无已知漏洞、2 个 +cpu 包跳过；audit-upstream.json 另查 2.14.1/0.29.1 上游无记录，非二进制完整审计。
- 人工：`S08/human-review-01/review.md` 与 manifest.json 已准备并请求用户核对，**pending**；manifest SHA-256 `4f4fc44365d3a11f76976e3a7d745a8a6515c5451506c541a01282d3ba4c7dfa`。cpu-reconciliation.json 确认最终 CPU 与材料的原图、单元格文本/坐标一致；不需要重新核对旧 S02 原生标注，不把 AI 看图当真人。
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
