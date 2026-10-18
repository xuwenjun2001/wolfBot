**GitHub 近一个月 Agent 项目调研与 wolfbot 迁移建议**

调研日期：2026 年 10 月 13 日，北京时间。调查窗口为 9 月 13 日至 10 月 13 日。

我的建议是保留 PI 执行内核，优先扩展金融研究工作流，以及基于失败样本的 Skill 改进流程。wolfbot 已经具备 Skills、上下文治理、持久任务、工具审批、隔离执行和交付验收。当前更值得投入的是把这些基础组合成更深入的研究产品，并用可比较的实验积累改进。

本报告对照了当前本地工作区源码，包括尚未提交的公司研究和战法复盘实现。外部项目核对范围包括 README、目录结构，以及文末列出的关键源码；没有运行外部项目，也没有测得迁移后的性能或质量收益。

**热度如何判断。**

使用两个入口：[GitHub Trending 月榜](https://github.com/trending?since=monthly)，以及 [9 月 13 日后新建、按 Star 排序的 Agent 仓库](https://github.com/search?q=agent+created%3A2026-09-13..2026-10-13+stars%3A%3E%3D200+archived%3Afalse&type=repositories&s=stars&o=desc)。另外搜索了新建 Agent framework，补充有技术价值但体量较小的项目。

下表“月新增”直接取自 Trending 的 `stars this month`，是 GitHub 的滚动月榜口径，并非逐条统计精确调查窗口内的 Star 事件。“新建项目”表展示总 Star，两个指标分别标注。数字是本次抓取快照，不能据此推导生产可靠性。采样主要发生在北京时间 17:02—17:16。

| 月榜项目 | 月新增 Star | 总 Star | 主要方向 | 对 wolfbot 的价值 |
| --- | ---: | ---: | --- | --- |
| [Hindsight](https://github.com/vectorize-io/hindsight) | 25,557 | 48,976 | 事实、经历、观察和长期知识模型 | 有来源、可修订、可解释的经验沉淀 |
| [Open Code Review](https://github.com/alibaba/open-code-review) | 24,317 | 46,698 | 确定性流程与专用审查 Agent | 按任务裁剪工具、独立定位和复核 |
| [ECC](https://github.com/affaan-m/ECC) | 22,583 | 278,144 | Skills、Hooks、工程工作流和持续学习 | 经验转 Skill、从新上下文复核改动 |
| [Paperclip](https://github.com/paperclipai/paperclip) | 20,601 | 101,194 | Agent 团队、目标、任务、预算和例行工作 | 跨任务目标、责任、成本及人工复核 |
| [WeKnora](https://github.com/Tencent/WeKnora) | 11,159 | 33,651 | 文档检索、推理、数据源同步和 Wiki | 持续维护的研究资料与企业知识 |
| [OpenShell](https://github.com/NVIDIA/OpenShell) | 7,457 | 16,035 | Agent 运行隔离、访问策略和凭据代理 | 将来扩展远程执行时的基础设施选项 |
| [Octop](https://github.com/TencentCloud/Octop) | 7,333 | 9,025 | 自托管多用户助手、专家、渠道和自动化 | 多入口任务体验、专家工作区、统一自动化 |
| [Financial Services](https://github.com/anthropics/financial-services) | 4,838 | 39,611 | 金融分析 Skills、具名工作流和连接器 | 最直接的领域能力迁移来源 |
| [Context Mode](https://github.com/mksglu/context-mode) | 4,706 | 27,651 | 工具输出索引、按需检索和会话事件 | 长文档研究的上下文取用方式 |
| [Agent Substrate](https://github.com/agent-substrate/substrate) | 3,104 | 4,993 | Kubernetes 上的 Agent 沙箱基础设施 | 大规模沙箱调度的远期参考 |

本次月榜共返回 22 个仓库，上表选取与 Agent 应用和本项目有关的部分。语音生成、逆向工程、地图等其他热门项目没有纳入架构迁移比较。

**真正近期新建的项目。**

创建日期已转换为北京时间。Star 数来自 GitHub 搜索接口本次快照。

| 新项目 | 创建日期 | 总 Star | 值得看的设计 | 迁移判断 |
| --- | --- | ---: | --- | --- |
| [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) | 9 月 17 日 | 22,786 | 依据当前 DOM 生成有编号的有限动作空间，执行前检查页面新鲜度 | 为将来的浏览器资料采集借鉴动作约束 |
| [magpie](https://github.com/yetone/magpie) | 9 月 24 日 | 10,974 | 本地多协议模型网关、模型选择与路由 | 与 ModelPort 有较大职责重叠，适合参考配置体验 |
| [ZCode](https://github.com/zai-org/ZCode) | 9 月 20 日 | 7,752 | 编码 Agent 的桌面、TUI、Web 和 UI Plugin | 可参考插件界面，替换执行框架的收益依据不足 |
| [OpenMuse](https://github.com/CopilotKit/openmuse) | 9 月 16 日 | 4,823 | 持久任务计划、结构化结果卡、人工接管与 AG-UI 事件 | 研究任务的可操作界面很值得参考 |
| [AntOmniEvo](https://github.com/ant-research/AntOmniEvo) | 9 月 15 日 | 940 | 从失败轨迹提出文件改动、比较候选、验证并保留改动谱系 | 与现有 Skills 和评测基础最容易形成增量 |
| [AgentEnv Framework](https://github.com/scaleapi/agentenv-framework) | 9 月 25 日 | 255 | 版本化环境、工具任务、产物和评分流程 | 适合扩充环境重放能力，成熟度需另做验证 |

AntOmniEvo 和 AgentEnv 的热度低于前几项；纳入它们是因为实现与本项目的问题吻合。OpenMuse 明确标记为 Alpha，当前部署还有单 owner、CopilotKit Intelligence 等约束。Jev 的速度展示基于很小的任务样本，不能外推为 A 股网站采集的成功率。

另外对照了 [Deep Agents](https://github.com/langchain-ai/deepagents)、[DeerFlow](https://github.com/bytedance/deer-flow) 和 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的当前文档，分别关注隔离子任务、研究工作台和经验生成 Skills。这些补充项目没有在本次月榜快照中出现，因此没有给它们编造月新增数据。

**我们目前具体有什么。**

| 能力 | 本地实现依据 | 对比较的影响 |
| --- | --- | --- |
| 执行内核与领域边界 | [PI 采用边界](pi-agent-migration.md)、[Data Agent 架构](data-agent-architecture.md)、[Run Engine](../src/lib/agent/pi/run-engine.ts) | 已采用 PI 0.82.1；Profile、Domain Pack 和 Delivery Pack 有明确组合边界 |
| 确定性与模型路径 | [PhaseGraph](../src/lib/agent/core/phase-graph.ts) | 标准看板走确定性路径；定制、修复和数据准备有各自预算。不能把生成路径的回合上限套到全部研究任务 |
| 持久化、审批和验收 | [PI 架构](pi-agent.md)、[EvidenceVerifier](../src/lib/agent/mission/evidence-verifier.ts) | Job/outbox、Worker、lease/fencing、operation ledger、审批和 accepted receipt 已存在 |
| Skills | [Skill compiler](../src/lib/agent/skills/compiler.ts)、[技能注册表](../.pi/skills.registry.json) | 当前有 12 个核心 Skill，具备版本、SHA-256、按阶段选择和有界参考材料注入 |
| 上下文管理 | [Context Manager](../src/lib/agent/context/context-manager.ts)、[受信上下文](../src/lib/agent/context/trusted-context-capsule.ts) | 已有预算、压缩、可信收据和历史事实处理。Context Mode 的增量主要在资料索引与按需检索 |
| 用户记忆与领域知识 | [PersonalMemoryPort](../src/lib/platform/memory/port.ts)、[知识使用与反馈](../src/lib/platform/knowledge/growth.ts) | Memory 已覆盖偏好、版本、recall、usage 和 outcome；AKEP 已有知识暴露与反馈归因，接入走独立 HTTP 契约 |
| 公司研究与历史经验 | [公司研究运行时](../src/lib/company-research/runtime.ts)、[公司研究说明](company-research.md)、[战法复盘](tactic-reviews.md) | 已有来源、原文引用核查、证据草稿、覆盖检查和恢复；战法复盘已会引用历史报告并限制未来信息 |
| 评测 | [评测数据集合同](../src/lib/eval/dataset-contract.ts)、[数据集注册](../benchmarks/quantpilot/datasets.json)、[快照清单](../benchmarks/quantpilot/snapshot-manifest.json)、[语义 reviewer](../src/lib/eval/agent-reviewer.ts) | 已有回归、可选 holdout/shadow、oracle fixture、变异测试和语义评分。配置里存在 holdout 不等于实际已经提供了独立隐藏数据 |
| 执行隔离 | [生成代码沙箱](../src/lib/security/generated-project-sandbox.ts) | 已有 namespace 隔离和固定目标的数据桥接；OpenShell 的额外价值是可管理的通用策略与远程执行基础设施 |

源码中 Run Engine 的工具执行是 sequential，PhaseGraph 声明 singleWriter。当前没有看到面向金融研究的通用父子 Agent 调度合同。公司的研究任务已有较长的证据循环，日报和战法复盘也已有自动化入口；下一步是组合和统一这些能力。

语义 reviewer 当前将 `independentFromGenerator` 标记为 false。因此，它已经提供语义检查基础，但不能作为已完成独立模型交叉验证的证明。

**优先迁移一：金融研究的完整工作流，优先级 P0。**

Financial Services 最有价值的是将分析师的工作拆成可检查的阶段：财报更新、同行比较、行业研究、催化剂跟踪，再明确每一阶段交付什么。以 `market-researcher` 为例，它会组织行业概况、竞争格局、同行估值和研究摘要；财报 Skill 强调本期相对上期发生了什么变化、数字出处以及假设修订。

wolfbot 已经能取财报、生成看板并完成三类公司研究主题。可以先增加一个“财报变化跟踪”能力：输入公司、报告期和截至时间，产出指标变化表、变化原因、证据原文、尚未解决的问题，以及相对上一份研究的结论修订。随后扩展同行比较与事件日历。

代码落点是 Finance Domain Pack、`src/lib/company-research/` 和 `.pi/skills/`；结构化计算继续交给 market-data，Mission 验收增加对应的业务检查。财报变化跟踪可以复用现有看板交付；需要研究简报、Excel 或文档时，再补充对应 Delivery Pack。

迁移时应把 SEC、CapIQ、FactSet 的假设映射为本项目实际可用的 A 股数据源；这些商业连接器的可用性不会随 Skill 一起获得。缺少一致预期时，相关比较明确标记不可用。估值情景沿用本项目已有合同。财报的报告期、披露时间、单位和可比口径要进入结构化事实。

收益在于用户能看到研究结论如何更新，以及每个变化由什么材料支持。验收应覆盖报告期错误、累计数误当单季数、无一致预期、历史截至时间和证据冲突；复用已有校验并补齐新工作流所需的断言。

**优先迁移二：基于失败轨迹改进 Skills，优先级 P0。**

AntOmniEvo 把可优化对象定义为一个文件目录。它比较父候选和子候选在相同训练批次上的结果，通过后再运行验证集，并保存候选、评测、分析和追加式 changelog。源码还提供了 PI Coding Agent proposer，但它使用的是 CLI；这与 wolfbot 当前嵌入的 PI core 并非同一个集成接口。

本项目具备大部分前置条件：可版本化的 Skill 文件、运行证据、评测集、结构化验证结果和发布完整性检查。可以建设一个离线改进工具，流程为：失败记录归类 → 生成 Skill 修改候选 → 与当前版本对比 → 独立验证 → 展示 diff 和实验结果 → 经现有发布流程更新 registry/lock。

首个试点只优化一个 Skill，例如财报研究或定制看板。候选只能修改实验目录中允许调整的 Skill 材料；评测器、隐藏用例和验收合同独立保管。生产运行继续使用已发布的版本。优化流程作为开发或评测工具接在外围，输出文件候选，再交给现有发布系统。

对比固定模型配置、输入快照、工具合同和预算，记录验收成功率、错误类型、Token、耗时和重复调用。独立 holdout 需要实际准备并启用；当前注册表里的可选项不足以替代它。发布条件应同时包括业务正确性不回退，以及目标指标在独立数据上达到预先约定的改善。

这能让“修过一次的问题”形成有实验依据的能力改动，帮助定位提示词变化究竟改善了什么。ECC 和 Hermes 的经验转 Skill 思路也值得借鉴；wolfbot 更适合复用自己的版本治理和评测流程。

**迁移三：有证据与有效时间的经验，优先级 P1。**

Hindsight 将事实、经历、观察和长期知识模型区分开来。其 observation 会携带原文引用、来源记忆和时间；后台 consolidation 会根据新证据支持、修订或反驳已有观察。可迁移的是这一类经验的生命周期，以及问题驱动的长期知识摘要。

wolfbot 的用户偏好继续走 Memory；研究方法、失败模式和领域经验可以通过 AKEP 的治理边界提供。战法复盘已有历史报告引用与时间约束，可作为首个试点，例如整理“这个结论出现过哪些支持样本、哪些反例、适用于什么观察区间”。

一个经验条目至少应包括适用任务、结论、原始证据引用、发生时间、可用截至时间、相关模型/Skill/数据版本和反例。生成通过验证可以产生执行事实；用户觉得有帮助仍要来自明确反馈。经验的检索与回写沿用 tenant/project/Space 隔离和现有 usage/outcome 收据。

本次没有审计独立 Memory/AKEP 服务的全部实现，因此不判断它们缺少 Hindsight 的所有能力。应先核对服务端已支持的能力，再扩展 wolfbot 对经验的使用方式。WeKnora 的文档同步与知识整理也更适合先在知识服务一侧评估，通过现有端口交付上下文。

**迁移四：可操作的研究任务界面，优先级 P1。**

OpenMuse 将任务计划、等待输入、审批、来源结果和产物放在同一任务中；Paperclip 增加目标层级、任务负责人、预算和例行工作。wolfbot 已有阶段状态、工具 trace、审批和运行记录，可以把这些真实状态组织成用户可操作的研究计划。

例如，研究任务按“已取得财报、待补竞争对手、待确认估值假设、已产出结论”显示。用户可调整未执行的研究范围，并只重新运行受影响的部分。已完成证据保留引用和版本。长期目标可以关联多次研究与日报，展示结论更新、失败和成本。

实现先复用现有 SSE/API、任务记录和审批合同，增加计划版本与变更事件。AG-UI 可以在需要接多种客户端时作为外部事件适配层；OpenMuse 的 React Native、身份和任务引擎整套迁移成本较高。新的暂停/继续语义应保持本项目的 replan recovery 规则，由持久化任务与证据恢复执行。

**迁移五：有边界的并行研究，优先级 P1，先做实验。**

Financial Services 的 market-researcher cookbook 将行业阅读、同行数据和写作拆成叶子任务，只有 note-writer 获得 Write 权限。这种职责划分与 wolfbot 的 singleWriter 很匹配。

可以选一个任务，允许两个或三个只读研究分支分别查财报、同行和公告，返回类型化证据，由一个主任务统一归并并写入产物。先比较串行与并行的完整交付耗时、成本和证据冲突率，再决定是否产品化。对标准看板继续采用现有确定性路径。

需要补齐父子任务 ID、上下文快照、共享预算、取消传播、配额和结果版本；每个分支绑定当前研究对象与截至时间。多实例 Worker 已有任务并发能力，但这不自动等价于任务内部具备协作编排。独立审阅可复用现有 evaluator，并如实记录它与生成端的独立性。

**迁移六：长资料按问题检索，优先级 P1/P2，取决于研究瓶颈。**

Context Mode 把大工具输出放入内容索引，返回按问题命中的片段。当前公司研究每轮会重建有界上下文，并选用最近八份来源的片段；通用 Context Manager 也已有可信收据。因此可增加一个检索已经读取资料的工具，让模型重新找到较早报告中的数字、注释和原文。

检索结果保留 source ID、定位信息、内容 hash 和截至时间，继续通过原文引用检查。财务聚合、排序和比较交给确定性程序，模型接收结果及证据。中文公司名称、数字单位和财务术语需要单独评估检索效果。

这里有实际的代码迁移限制：Context Mode 当前采用 [Elastic License 2.0](https://github.com/mksglu/context-mode/blob/1a1bed139906ecc048233583bb2fd29290603b7a/LICENSE)，对向第三方提供其重要功能的托管服务有限制。建议借鉴索引与片段检索设计，在现有工具和存储边界内独立实现。其 README 中的“98% reduction”是项目自述，未在 wolfbot 测得。

**暂放后面：通用浏览器、完整环境重放与沙箱集群。**

Jev 的动作编号、兼容目标集合和执行前新鲜度检查值得借鉴。若后续遇到必须交互才能读取的公开资料，可以提供 Browser Connector，将动作绑定到当前观察快照，再校验实际结果。它目前依赖 TypeSafe 服务，且对 frames、shadow roots、上传和复杂键盘控件等仍有范围限制；本项目可靠的结构化取数路径继续承担主要数据工作。

AgentEnv 的增量在于版本化环境与完整任务执行状态。wolfbot 已有数据 oracle fixture 和截至时间校验，后续可以扩展到工具响应、依赖版本、时钟、随机种子及环境镜像的实验快照，让候选版本面对更接近一致的环境。AgentEnv 近期新建，现阶段更适合作为设计参考和独立试验。

OpenShell 和 Substrate 适合未来多租户远程执行及较大沙箱规模。wolfbot 当前已具备生成代码隔离；引入通用网关、策略系统和集群调度会增加运维成本。可先定义执行后端端口，等实际资源规模和能力需求明确后再接入。

**建议的第一轮实施范围。**

| 顺序 | 做什么 | 复用什么 | 主要验收依据 |
| --- | --- | --- | --- |
| 1 | 一个财报变化跟踪工作流 | Finance Domain、company-research、现有财务合同和证据检查 | 截至时间、可比指标、原文引用、结论变化、缺失项 |
| 2 | 一个 Skill 的离线候选比较工具 | `.pi`、评测器、数据快照和版本发布 | 固定条件对比、实际独立 holdout、硬校验不回退、成本与质量记录 |
| 3 | 一个战法经验摘要与反例试点 | 现有历史报告、AKEP 接口和时间规则 | 来源可追溯、无未来信息、经验可修订、反馈可归因 |
| 4 | 一个可操作研究计划与两分支实验 | 持久任务、SSE、审批、Worker、singleWriter | 取消与重试一致、单一写入、结果版本、串并行交付对比 |

以上是建议的增量范围，不代表已经实现或已经测得收益。迁移优先级依据是业务相关性、现有代码复用程度，以及能否用独立证据判断效果。

**关键外部证据。**

以下链接固定到本次查看的提交，便于以后复查具体实现。热度原始 HTML、搜索响应和下载源码保存在本地被 Git 忽略的 `tmp/agent-landscape-2026-10-13/`。

- Financial Services：[财报更新 Skill](https://github.com/anthropics/financial-services/blob/574ed3624aebd0418c7e96cd101262f30210ab26/plugins/vertical-plugins/equity-research/skills/earnings-analysis/SKILL.md)、[催化剂日历](https://github.com/anthropics/financial-services/blob/574ed3624aebd0418c7e96cd101262f30210ab26/plugins/vertical-plugins/equity-research/skills/catalyst-calendar/SKILL.md)、[研究工作流](https://github.com/anthropics/financial-services/blob/574ed3624aebd0418c7e96cd101262f30210ab26/plugins/agent-plugins/market-researcher/agents/market-researcher.md)、[子任务与 Write 权限](https://github.com/anthropics/financial-services/blob/574ed3624aebd0418c7e96cd101262f30210ab26/managed-agent-cookbooks/market-researcher/agent.yaml)。
- AntOmniEvo：[候选比较与验证设计](https://github.com/ant-research/AntOmniEvo/blob/4dc3787ef25359ac9a6b282fa5340a3bb2110c48/docs/system-design.md)、[产物与改动归因](https://github.com/ant-research/AntOmniEvo/blob/4dc3787ef25359ac9a6b282fa5340a3bb2110c48/docs/workspace-artifacts.md)、[PI CLI proposer](https://github.com/ant-research/AntOmniEvo/blob/4dc3787ef25359ac9a6b282fa5340a3bb2110c48/antomnievo/proposer/pi_coding_agent_proposer.py)。
- Hindsight：[带原文引用的 Observation](https://github.com/vectorize-io/hindsight/blob/f843f173bb41f001e322cc83c917371639e47fbf/hindsight-api-slim/hindsight_api/engine/reflect/observations.py)、[后台 consolidation](https://github.com/vectorize-io/hindsight/blob/f843f173bb41f001e322cc83c917371639e47fbf/hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py)、[长期知识刷新](https://github.com/vectorize-io/hindsight/blob/f843f173bb41f001e322cc83c917371639e47fbf/hindsight-api-slim/hindsight_api/engine/mental_model_refresh.py)。
- Paperclip：[目标层级与负责人 schema](https://github.com/paperclipai/paperclip/blob/4a641d0980fdaffc4c4e805f6f0a8809eb5702f2/packages/db/src/schema/goals.ts)、[目标 service](https://github.com/paperclipai/paperclip/blob/4a641d0980fdaffc4c4e805f6f0a8809eb5702f2/server/src/services/goals.ts)。
- OpenMuse：[任务界面](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/mobile/src/agent-ui.tsx)、[验证范围与局限](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/docs/VERIFICATION.md)。
- Context Mode：[内容索引](https://github.com/mksglu/context-mode/blob/1a1bed139906ecc048233583bb2fd29290603b7a/src/store.ts)、[跨来源检索](https://github.com/mksglu/context-mode/blob/1a1bed139906ecc048233583bb2fd29290603b7a/src/search/unified.ts)、[许可证](https://github.com/mksglu/context-mode/blob/1a1bed139906ecc048233583bb2fd29290603b7a/LICENSE)。
- Jev：[动作执行循环](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py)、[DOM 观察快照](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/snapshot.js)。
- AgentEnv：[任务调度与步骤日志](https://github.com/scaleapi/agentenv-framework/blob/1e15cb3fc10e9904f2f79a6c75f7427b6531530c/src/agent_env/task/task.py)、[固定版本的环境组合](https://github.com/scaleapi/agentenv-framework/blob/1e15cb3fc10e9904f2f79a6c75f7427b6531530c/src/agent_env/artifact/artifacts/environment_universe.py)。

本次核对到 Financial Services 和 AntOmniEvo 使用 Apache-2.0，Hindsight 和 Paperclip 使用 MIT；WeKnora 的主体为 MIT，并列有第三方组件许可。Context Mode 使用上述 ELv2。这里的迁移判断主要针对设计与领域方法；实际复用代码时仍按对应文件与依赖的许可保留声明。
