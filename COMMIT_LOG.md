# Commit Rationale Log

本文件记录仓库的每一次提交原因、实现方式和验证结果。它与 `CHANGELOG.md` 分工不同：`CHANGELOG.md` 只记录用户可见的 `feat`/`fix`，本文件记录所有类型的提交，包括 `docs`、`chore` 和维护性变更。

## 维护规则

- 提交前新增一行，提交标题作为提交标识；已知时可在标题前补充短 SHA。
- 每行必须写清 `Why`、`How` 和 `Validation`，验证结果必须是真实执行结果。
- 不把 Cookie、API Key、本地数据库、日志或原始敏感材料写入本文件。
- 新提交按时间倒序排列；提交标题、日期和正文应与 Git 历史一致。

## 提交记录

| 提交 | 日期 | 类型 | 范围 | Why（原因） | How（实现） | Validation（验证） |
| --- | --- | --- | --- | --- | --- | --- |
| `fix(wolf-dashboard): align sidecar skill protocol` | 2026-08-30 | fix | wolf-dashboard | 修复启用 skill 时 Agent 请求被 sidecar 以 HTTP 400 拒绝，并恢复 skill 正文与引用的按需读取。 | 扩展 sidecar 对 `scope`、`applicable_scope`、`source`、`content_sha256` 等 skill 元数据的校验与保留；`load_skill`、`read_skill_reference` 通过固定本地 FastAPI 只读接口读取缺失内容；补充回归测试和文档。 | backend `pytest`（77 passed，2 个已有 warning）；sidecar `npm.cmd run typecheck`、`npm.cmd test`（9 passed）、`npm.cmd run build` 通过；`git diff --check` 通过。 |
| `feat(wolf-dashboard): implement agent research MVP` | 2026-08-30 | feat | wolf-dashboard | 将现有监控仪表盘扩展为可追溯的本地 Agent 研究工作台，覆盖 skill、行情、筛选和证据闭环。 | 增加 PI Agent sidecar 与受控工具循环、FastAPI Agent/SSE/取消接口、运行持久化、EastMoney 股票池导入、腾讯行情与 SQLite 技术指标、确定性筛选器、skill 管理 API/UI、Agent 与 `/skills` 页面；保留 `/monitor` 并补齐启动、文档和许可说明。 | `python -m pytest -q`（77 passed，2 个已有 warning）；Agent API（15 passed）；EastMoney fixture（12 passed）；sidecar 类型检查、测试（8 passed）和构建通过；npm audit（0 vulnerabilities）；3 个前端 `node --check` 通过；Playwright 1440/390px 三页面无横向溢出和浏览器错误；SSE 恢复、候选切换、K 线/成交量/均线及 Skill UI 操作通过；`git diff --check`、Markdown 链接和敏感信息检查通过。 |
| `docs(repo): add commit rationale log` | 2026-08-28 | docs | repo | 仅依赖 Git 提交正文不便于在仓库内集中审阅所有提交原因。 | 新增本文件，并在 `AGENTS.md`、`CONTRIBUTING.md`、README 和项目全景图中登记同步要求及入口。 | `git diff --check` 通过；Markdown 本地链接检查通过；敏感路径检查通过；工作树检查确认仅包含本次文档变更。 |
| `8cd6ea5 fix(wolf-dashboard): repair NGA author pagination cursor` | 2026-08-28 | fix | wolf-dashboard | 普通帖子页码与作者过滤页码不一致，旧游标停在错误页区间，导致手动检查没有新发言。 | 固定 `authorid`/`opt=262144`，记录作者过滤页游标；无新发言时推进游标；旧游标首次从 `NGA_INITIAL_PAGE` 重扫并去重；补充贡献文档和回归测试。 | `python -m pytest -q`（16 passed，1 个已有警告）；Python 编译和前端语法检查通过；手动抓取首次 `new_posts=35`，重复抓取 `new_posts=0`。 |
| `43735c2 docs(repo): establish engineering governance` | 2026-08-28 | docs | repo | 让空仓库具备清晰的定位、维护、评审和扩展规则。 | 增加代理规范、贡献流程、项目全景图、feat/fix 变更记录和提交正文模板，并配置本地模板。 | 检查暂存范围、Markdown 链接、受跟踪文档内容和 `git diff --check`。 |
| `0176eee chore(repo): initialize clean repository` | 2026-08-28 | chore | repo | 建立干净且可预测的 Git 基线，便于后续加入应用代码。 | 初始化 `main` 分支和 `wolfBot` 远端，加入本地数据、凭据和构建产物的通用忽略规则。 | 确认目标远端无已有引用，并验证本地材料已被忽略且未进入索引。 |
