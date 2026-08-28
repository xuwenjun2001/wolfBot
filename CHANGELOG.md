# Changelog

本表只登记用户可见或行为相关的 `feat` 和 `fix`。每行的变更 ID 必须与对应提交页脚的 `Change-Id` 完全一致；`docs`、`chore`、`refactor` 等提交请通过 Git 历史中的 Why/How/Validation 追溯。

## 记录格式

| ID | 日期 | 类型 | 范围 | 摘要 | 原因 | 修改方式 | 验证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WB-20260828-003 | 2026-08-28 | fix | wolf-dashboard | 修复 NGA 作者发言增量检查不更新的问题 | 普通帖子页码与 `authorid` 过滤页码不是同一套游标，旧游标会一直扫描错误的页区间 | 请求固定携带 `authorid`/`opt=262144`；游标记录作者过滤页码并在无新发言时推进；旧普通页游标首次从 `NGA_INITIAL_PAGE` 重扫并去重 | `python -m pytest -q`（16 passed）；`python -m compileall -q backend`；`node --check frontend/app.js`；`git diff --check` |
| WB-20260828-002 | 2026-08-28 | fix | wolf-dashboard | 支持 AI 思考强度配置、最长 1200 秒超时并避免任务请求阻塞页面 | 兼容模型的长推理请求可能超过默认超时，阻塞同步 API | 新增 `OPENAI_REASONING_EFFORT`/`OPENAI_REQUEST_TIMEOUT`（上限 1200 秒），策略/爬取任务通过线程池执行；补充请求体回归测试 | `python -m pytest -q`（13 passed） |
| WB-20260828-001 | 2026-08-28 | feat | wolf-dashboard | 增加 NGA 增量监控、可追溯策略版本、行情快照和本地仪表盘 | 将作者发言、历史规则和盘前观察放入可复核的本地工作流 | FastAPI + SQLite；`last_page-1` 重叠扫描；AI 输出强制 PID/规则引用；无凭据时显式降级 | `python -m pytest -q`（12 passed） |
| （暂无） | - | - | - | - | - | - | - |

## 维护规则

- ID 格式固定为 `WB-YYYYMMDD-NNN`，同一天从 `001` 开始递增。
- 新记录按日期倒序排列；同一天按提交时间倒序排列。
- 原因写清用户影响或缺陷背景，修改方式写清关键实现，验证写命令和结果。
- 只做文档整理或仓库维护时不要伪造 `feat`/`fix` 记录。
