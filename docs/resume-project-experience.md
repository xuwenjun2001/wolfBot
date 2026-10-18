# wolfbot 项目经历与实测依据

本稿面向 AI 应用开发 / Agent 工程师岗位。只保留本人实际参与且能够解释的职责。评测日期为 2026-09-07，基于本地未提交工作区；Git HEAD 为 `2015ecdc8f3d891f81ff0a5a8d42a2d2f2dd0a5c`，不代表该提交本身的质量。

## 简历文案

**wolfbot | 面向金融投研的 AI Data Agent 平台**

技术栈：TypeScript、Next.js、Python / FastAPI、PI Agent、PostgreSQL、Redis、Playwright。

项目简介：面向自然语言投研需求，构建涵盖结构化意图解析、证券实体识别、真实数据准备、交互式看板生成及产物验收的 AI 应用。

- 基于开源 PI Agent 构建执行治理层，按任务选择标准确定性执行、模型定制与受限修复路径，通过类型化工具、执行预算和显式提交管理任务生命周期。
- 实现 PostgreSQL 持久化任务调度与独立 Worker 执行，结合事务 outbox、心跳租约、fencing token 和用户并发配额，管理任务恢复、重复执行及多用户资源竞争。
- 构建版本化 Skills 编译与上下文管理机制，支持完整性校验、工具结果摘要、关键消息保护，以及外部知识和用户记忆的使用追踪。
- 建立产物契约、事实证据、视觉交付与运行可靠性评测机制；在正常基线通过的前提下，对事实依据、安全、视觉、运行可靠性和快照共 5 类问题执行 10 项预设错误注入，10/10 被预期检查器拦截。

投 AI 应用开发岗位时，可将第二条替换为：

- 将金融业务能力封装为 Finance Domain Pack，通过结构化意图合同、独立证券解析与数据证据关联，衔接自然语言需求、真实数据服务和可验证的看板产物。

## 实测口径

| 检查 | 本次结果 | 能支持的结论 |
| --- | --- | --- |
| 错误注入评测 | 正常基线通过，10/10 拦截，5 类问题 | 已登记错误的预期检测器有效；不是任意错误的检出率 |
| 评测、上下文及意图解析相关单元测试 | 20 个文件、105 项测试全部通过 | 所选模块的确定性回归检查通过；不是 105 条真实 Agent 任务 |
| 数据集合同检查 | 公开用例 16 条，快照 6/6，隐藏集 0，回放集 0 | 数据集登记和快照合同检查通过；不代表 16 条 E2E 全部执行 |
| TypeScript 检查 | 通过 | 当前工作区通过类型检查 |

错误注入原始报告：`tmp/quantpilot-eval-mutations/mutation-report-1788761067503.json`。

真实 E2E 选择同一标的的标准看板与定制无卡片布局两条公开用例，模型为 `deepseek-v4-flash`，评测器为 `rule-strict@2.1.0`，单并发、每条一次。样本只用于诊断，不代表全量场景或线上用户分布。

首批 E2E 报告：`tmp/quantpilot-benchmark-reports/report-1788761191996.json`。两条均未通过，原因是本地行情服务未启动，证券 Resolver 请求失败后进入澄清分支；该批没有进入 Agent 执行，不能把缺失的 Agent 指标解释为零成本。模型语义提取成功不等于端到端交付成功。

启动行情服务后，原样重跑两条用例，报告为 `tmp/quantpilot-benchmark-reports/report-1788761590680.json`，最终仍为 0/2 通过：

- 标准看板：实际完成取数和确定性工具执行，但 `ChartPanel.tsx` 调用同源 `/api/market/quotes/session/` 与当前产物策略不兼容。检查器禁止代理路由文件之外的所有 `fetch()`，因此阻止预览。三次修复仍未通过，过程中出现上下文输入预算和输出 Token 预算错误。
- 定制看板：实际进入模型工具循环，但达到输出 Token 预算，Mission 以 `MAX_TOKENS` 失败，未正常提交。

这两条失败不是对模型整体能力的估计，也不证明端到端功能完全不可用；它们证明当前工作区在所选配置与用例下未达验收要求。失败报告未完整汇总 AgentRun 指标，即使报告显示零轮数或缺失 usage，也不能当作实际执行量或成本。此次没有放宽验收规则、提高预算或修改测试题来获得通过结果。

本次临时启动的行情服务已在评测结束后停止。两条测试项目的生成文件和数据库记录保留用于排查；首批重跑前的项目文件已由 runner 重建，首批 JSON 报告仍保留。

本次没有前后对照基线，不能声称成功率提升、成本下降或耗时降低。当前简历不写端到端成功率、平均生成耗时、自动修复成功率或每次成功任务成本。

## 复现命令

```powershell
npm run check:eval-mutations
npm run check:eval-datasets
npm run test:unit -- src/lib/eval src/lib/agent/core/phase-graph.test.ts src/lib/agent/context/context-manager.test.ts src/lib/domains/finance/query-rewrite.test.ts
npm run type-check
npm run dev:market
```

数据库和行情服务就绪后，在另一终端执行：

```powershell
npm run benchmark:quant:e2e -- --case stock-diagnosis-citic-custom-no-cards --case stock-diagnosis-citic-no-false-clarification --model deepseek-v4-flash --evaluator rule-strict --concurrency 1
```

E2E 会调用真实模型、写数据库和生成工作区。现有 runner 会重建所选 case 对应的 `benchmark-*` 测试项目；复跑前保留需要的证据。凭据使用本地配置，不写入文档。本次沿用本机已有的 Windows 开发执行配置，未验证 Linux namespace 隔离效果。

## 本次入口修复

`src/lib/domains/finance/index.ts` 对 `query-rewrite` 和 `intent` 的星号导出重复暴露同一个符号，触发 jiti 的 `Cannot redefine property` 错误。改为显式导出 intent 的独有成员，保留原有公开接口。修复后 E2E 能进入正式 act 链路，相关单元测试和类型检查通过。
