# Contributing to WolfBot

感谢贡献。WolfBot 当前包含 `wolf-dashboard` 本地监控与策略服务；贡献前请先阅读 [AGENTS.md](AGENTS.md) 和 [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md)，并保持代码、测试、运行文档和变更记录一致。

## 开发流程

1. 从最新 `main` 创建主题分支，避免在 `main` 上积累未评审改动。
2. 阅读 [AGENTS.md](AGENTS.md) 和 [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md)，确定代码入口、影响范围和验证方式。
3. 先实现最小可用改动，再补充边界处理、错误路径和必要测试。
4. 执行受影响的测试和静态检查，并运行 `git diff --check`。
5. 结构变化同步更新项目全景图；每个提交同步更新 `COMMIT_LOG.md`；`feat` 或 `fix` 另外更新 `CHANGELOG.md`。
6. 按提交规范创建小而完整的提交，提交前复核暂存区内容。
7. 发起评审时说明背景、行为变化、验证结果、兼容性和已知风险。

## 本地开发

在 `wolf-dashboard` 下创建虚拟环境并安装后端依赖：

```powershell
cd wolf-dashboard
python -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt
Copy-Item .env.example .env
```

本地服务默认监听 `127.0.0.1:8787`，使用 `.\scripts\start.ps1` 启动。不要把真实 `NGA_COOKIE`、`OPENAI_API_KEY`、`wolf.sqlite3` 或运行日志加入提交；`.env`、数据库、WAL 文件和日志已在 `.gitignore` 中排除。测试应使用假客户端或临时 SQLite，不调用真实 NGA/AI 服务。

## 验证命令

提交前至少执行受影响模块的测试；涉及 dashboard 后端或前端时执行：

```powershell
cd wolf-dashboard/backend
$env:PYTHONPATH=(Get-Location).Path
python -m pytest -q
python -m compileall -q app
node --check ../frontend/app.js
cd ../..
git diff --check
```

NGA 采集改动应覆盖作者过滤参数、跨页发现、游标推进、迁移失败重试和 `(tid,pid)` 去重。策略改动应验证引用 PID/规则 ID 的服务端校验；长时间 AI 请求不得阻塞状态、发言和事件接口。

## 提交规范

提交标题采用：

```text
<type>(<scope>): <简短、明确的摘要>
```

允许的 `type`：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`build`、`ci`、`perf`、`revert`。

提交正文必须包含：

```text
Why: 触发原因、用户影响或维护背景
How: 关键修改和取舍
Validation: 命令、测试或手工检查及结果
```

`feat` 和 `fix` 还必须生成 `WB-YYYYMMDD-NNN`，在 `CHANGELOG.md` 增加一行，并在提交正文末尾加入：

```text
Change-Id: WB-YYYYMMDD-NNN
```

所有类型的提交都必须在提交前向根目录 `COMMIT_LOG.md` 增加记录，至少包含提交标题、日期、类型、范围以及 `Why`、`How`、`Validation`。`CHANGELOG.md` 只登记 `feat` 和 `fix`；`docs`、`chore` 等提交通过 `COMMIT_LOG.md` 和 Git 历史双重追溯。

## 文档与全景图

任何新增模块、入口、外部依赖、配置、数据流或测试命令，都必须在同一提交更新 [项目全景图](docs/PROJECT_MAP.md)。只要用户行为或使用方式发生变化，也要更新 README。

NGA 分页、游标迁移、AI 超时或环境变量变化同时更新 `wolf-dashboard/README.md` 和根目录 `README.md`；用户可见的 `feat`/`fix` 还要在同一提交更新 `CHANGELOG.md`。

提交原因记录统一维护在根目录 [COMMIT_LOG.md](COMMIT_LOG.md)；新增提交时按时间倒序追加，并确保不写入任何凭据或本地运行数据。

## 评审检查

- 是否只修改了任务需要的文件？
- 是否覆盖主流程、边界和失败路径？
- 是否有回归测试或清楚记录了无法自动化的原因？
- 是否暴露密钥、个人数据、原始数据或生成物？
- 是否同步了文档、全景图和 `feat`/`fix` 变更表？
- 提交正文是否包含 Why、How、Validation，且验证结果可复核？
- 暂存区是否只包含本次任务文件，且没有 `.env`、数据库、WAL、日志或缓存？
- 提交标题是否符合 Conventional Commits，`feat`/`fix` 是否有唯一 `WB-YYYYMMDD-NNN` 和 `Change-Id`？
- 是否已在 `COMMIT_LOG.md` 记录本次提交的 `Why`、`How`、`Validation`？

没有运行测试时必须明确写出原因；不要把“代码看起来正确”当作验证结果。
