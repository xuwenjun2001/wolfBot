# Changelog

本表只登记用户可见或行为相关的 `feat` 和 `fix`。每行的变更 ID 必须与对应提交页脚的 `Change-Id` 完全一致；`docs`、`chore`、`refactor` 等提交请通过 Git 历史中的 Why/How/Validation 追溯。

## 记录格式

| ID | 日期 | 类型 | 范围 | 摘要 | 原因 | 修改方式 | 验证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WB-20260901-001 | 2026-09-01 | feat | wolf-dashboard | 增加带交易时点、板块身份、快照、宽度和成分证据的板块趋势研究能力 | 原有单标的行情工具无法可靠回答“某板块今天走势如何”，缺少北京时间交易阶段、有效交易日、板块消歧、宽度覆盖率和可区分的上游失败语义，容易形成无依据结论 | 新增可注入时钟的交易日历、EastMoney 板块 Provider、SQLite 板块存储与 5 条固定 API；宽度仅由同一时点的有效成分行情计算并记录依据和覆盖率；Sidecar 无条件注册 5 个板块工具、白名单透传错误码并机械校验最小证据；同步前端卡片、内置 skill、README、项目地图和计划状态 | backend `python -m pytest -q`（154 passed，2 warnings）；sidecar `npm.cmd run typecheck`、`npm.cmd test`（38 passed）、`npm.cmd run build` 通过；`node --check frontend/agent.js`、`git diff --check`、102 个 Markdown 文件本地链接检查和待提交路径安全检查通过 |
| WB-20260831-001 | 2026-08-31 | fix | wolf-dashboard | 收紧 Agent 工具契约并修复错误归因、终端证据引用和真实 Provider 运行可靠性 | 通用行情入口、不可用 Skill 工具和模糊失败事件会诱发重复猜测并耗尽预算；终端调用缺少可复制的成功 call ID，标准启动也未把 `.env` Provider 配置传给 sidecar | 以 8 个固定端点市场工具替代通用入口；按 Skill 模式裁剪工具并限制引用；重构 PI 生命周期、前置校验、批次/预算/连续失败语义；成功结果返回精确 `tool_call_id`，Schema 错误移除完整参数；同步 backend artifact、前端候选回填、Provider smoke 和启动配置白名单 | sidecar typecheck/build 通过，Vitest 27 passed；backend pytest 79 passed、2 warnings；前端与 smoke 脚本 `node --check`、PowerShell parser、`git diff --check` 通过；真实 Provider smoke run `0aaf70118a2e4028a16323c4135455fc` completed，5 次调用全部成功且无错误码 |
| WB-20260830-002 | 2026-08-30 | fix | wolf-dashboard | 修复启用 skill 时 Agent 请求被 sidecar 以 HTTP 400 拒绝，并恢复 skill 正文与引用读取 | FastAPI 下发的 skill 摘要包含受 sidecar 严格校验遗漏的元数据字段，且仅传元数据时工具无法取得正文和引用，导致分析请求失败或无法完成 | 扩展 sidecar skill 元数据校验；`load_skill` 和 `read_skill_reference` 通过固定本地 FastAPI 只读接口按需获取内容；补充协议与工具回归测试和运行约束文档 | backend `pytest`（77 passed，2 个已有 warning）；sidecar `typecheck`、测试（9 passed）和 `build` 通过；`git diff --check` 通过 |
| WB-20260830-001 | 2026-08-30 | feat | wolf-dashboard | 增加 Agent 研究工作台、skill 管理、行情与确定性选股能力 | 用户需要在本地提出独立研究问题，查看受控工具轨迹、证据、终态结论和候选股图表，而不是只使用原有监控页 | 增加 PI Agent sidecar、FastAPI Agent/SSE/取消与持久化、EastMoney 股票池导入、腾讯行情/日线/指标、SQLite 与筛选器；新增 Agent 和 `/skills` 页面，保留 `/monitor` 并补齐启动脚本与文档 | `python -m pytest -q`（77 passed）；sidecar 测试（8 passed）和构建通过；前端语法检查、Playwright 桌面/移动端检查及 `git diff --check` 通过 |
| WB-20260828-003 | 2026-08-28 | fix | wolf-dashboard | 修复 NGA 作者发言增量检查不更新的问题 | 普通帖子页码与 `authorid` 过滤页码不是同一套游标，旧游标会一直扫描错误的页区间 | 请求固定携带 `authorid`/`opt=262144`；游标记录作者过滤页码并在无新发言时推进；旧普通页游标首次从 `NGA_INITIAL_PAGE` 重扫并去重 | `python -m pytest -q`（16 passed）；`python -m compileall -q backend`；`node --check frontend/app.js`；`git diff --check` |
| WB-20260828-002 | 2026-08-28 | fix | wolf-dashboard | 支持 AI 思考强度配置、最长 1200 秒超时并避免任务请求阻塞页面 | 兼容模型的长推理请求可能超过默认超时，阻塞同步 API | 新增 `OPENAI_REASONING_EFFORT`/`OPENAI_REQUEST_TIMEOUT`（上限 1200 秒），策略/爬取任务通过线程池执行；补充请求体回归测试 | `python -m pytest -q`（13 passed） |
| WB-20260828-001 | 2026-08-28 | feat | wolf-dashboard | 增加 NGA 增量监控、可追溯策略版本、行情快照和本地仪表盘 | 将作者发言、历史规则和盘前观察放入可复核的本地工作流 | FastAPI + SQLite；`last_page-1` 重叠扫描；AI 输出强制 PID/规则引用；无凭据时显式降级 | `python -m pytest -q`（12 passed） |
| （暂无） | - | - | - | - | - | - | - |

## 维护规则

- ID 格式固定为 `WB-YYYYMMDD-NNN`，同一天从 `001` 开始递增。
- 新记录按日期倒序排列；同一天按提交时间倒序排列。
- 原因写清用户影响或缺陷背景，修改方式写清关键实现，验证写命令和结果。
- 只做文档整理或仓库维护时不要伪造 `feat`/`fix` 记录。
