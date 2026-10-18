# 财报研究 Agent：进度与会话交接

这是唯一的当前进度来源。计划见 [plan.md](plan.md)，规范见 [development.md](development.md)，选型见 [decisions.md](decisions.md)。更新时间使用北京时间。

## 当前交接

| 字段 | 当前值 |
| --- | --- |
| 最后更新 | 2026-10-18（北京时间） |
| 计划版本 | v1 |
| 总体状态 | S01—S05 基础实现及相关验证完成；真实模型成功验收和独立人工金标未完成，分别保留失败/待核对状态 |
| 已完成开发步骤 | 5/20 |
| 当前进行中步骤 | 无 |
| 下一步骤 | S06：财报发现、导入与时间证据（本轮范围至 S05，尚未开展） |
| 下一具体动作 | 下次继续时先核对本分支、S05 追加迁移与原件目录；按 S06 扩展 discovery/connectors/network，复用新文档版本存储，不把测试采集器当生产导入器 |
| 当前会话登记 | 2026-10-18-foundation-s01-s05：核实、数据评测、现状测量、合同、持久化 |
| 工作区 | `D:/QuantPilot`；在其他电脑以实际项目根为准 |
| 当前参考分支 / HEAD | `codex/research-foundation-s01-s05`；源码起点 `d17ac89`，各步骤改动随本文件提交，最终身份见 `git log -1` |
| 目标仓库 | `https://github.com/xuwenjun2001/wolfBot`，默认分支 `main` |
| 本轮涉及文件 | 本计划与专题文档；`fixtures/company-research/`；`scripts/research/` 与隔离 DB runner；研究合同/版本 store/原件存储、`api/company-research/tasks/`；Prisma schema/新追加迁移；TS 排除证据目录、package 验证命令、评测 JSON LF 规则 |
| 已有改动提醒 | 开始时干净；本轮相关改动按 S01—S05 分步提交到工作分支；下次仍以 `git status` 和远端 SHA 核实，不盲信旧记录 |
| 运行环境 / 进程 | 未启动或终止业务应用/Worker；本轮校准与迁移专用 PostgreSQL 容器均已删除，证据原件保留；应用/生产库未执行新迁移 |
| 模型与数据费用 | 1 校准 + 4 开发，共 5 次真实网关请求均 401；无 usage，费用 unknown；公开年报采集无付费 API；未运行真实搜索 E2E |
| 阻塞 | 成功模型验收受网关凭据 401 阻塞；独立人工金标待核对。S06 准备不依赖模型成功。Windows 共享 Prisma DLL 正在被开发服务使用，原位置 generate 失败；独立目录客户端生成和 ORM smoke 通过 |
| 最近验证 | 57 项单元/API 测试通过；13 项真实 PG 集成通过；旧 schema 升级、重复 deploy、新旧代码回退读取通过；types/lint/docs（68 文件、401 链接）通过。模块检查仅剩 S01 三个既有超限；Quality Node/Python 审计暂缓，未宣称全量 CI/构建通过 |
| 受控资料恢复 | 开发资料在 `data/research-agent-upgrade/`；本机 `RESEARCH_HOLDOUT_ROOT=D:/QuantPilot-private-evals/research-v1`，换机须经受控归档恢复并核对登记 hash；这里不记录保留题/答案 |
| 范围提醒 | 完成 S01—S05；不展开 S06 之后产品能力或生产部署；已有 Quality 问题按用户要求暂缓 |

## 步骤状态

状态：`pending` 未开始；`in_progress` 正在实现或等待必需验证；`blocked` 有具体外部阻塞；`done` 本步验收通过且证据齐全。依赖未完成的 pending 不自动算 blocked。被重开的步骤保留原证据并记录原因。

| 步骤 | 工作包 | 最低依赖 | 状态 | 证据 / 阻塞 |
| --- | --- | --- | --- | --- |
| S01 | 现状核实与首版场景 | 无 | done | E-S01-01；baseline.md |
| S02 | 固定资料、人工答案与评测合同 | S01 | done | E-S02-01；evaluation.md；参考答案 source-checked，独立人工签字 pending，不是 human golden |
| S03 | 实测基线与失败记录 | S01、S02 | done | E-S03-01；5 次网关请求均 401，无模型答案；unsupported 与鉴权失败分开记录 |
| S04 | 版本化领域与事件合同 | S01、S02 | done | E-S04-01；contracts.md；51 测试通过/2 DB 跳过；types 通过 |
| S05 | 持久化、隔离与迁移 | S04 | done | E-S05-01；七张版本表、actor repository/原件存储/API；13 项 PG 测试和旧库升级/旧代码兼容通过 |
| S06 | 财报发现、导入与时间证据 | S05 | pending | — |
| S07 | 文本 PDF / HTML 定位解析 | S06 | pending | — |
| S08 | OCR 与表格结构解析 | S07 | pending | — |
| S09 | 财务口径与变化计算 | S07、S08 | pending | — |
| S10 | 证据检索与按需上下文 | S07、S08、S09 | pending | — |
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

## 本次核对得到的事实

- 公司研究已使用 DeepSeek Search/Fetch，当前模型与搜索凭据分别配置；旧会话中的 Tavily 描述已过时。
- 当前研究合同主题为主营业务、上下游和近期财报；双期变化研究仍是拟新增能力。
- 已有来源 hash、引用存在性校验、研究状态、Worker fencing、SSE 与取消；不能因此声称升级步骤已完成。
- 扫描件 OCR、检索任意已读来源、结构化计划编辑和报告版本差异需按计划实现。
- S01—S05 新增可复验的基线、评测、版本合同和持久化基础层；新请求先保存 draft，S11 才接入双期执行。旧 Worker 不领取新表。
- 本轮真实网关基线全部在鉴权前失败，未取得模型研究答案；开发参考答案与独立人工金标分开登记，不能报告质量提升。历史看板/研究报告仅作背景。

## 验收证据

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
