# WolfBot

WolfBot 是一个从干净仓库起步的项目，当前包含可运行的 `wolf-dashboard` 本地监控与策略仪表盘。

## 文档入口

- [AGENTS.md](AGENTS.md)：代理和维护者必须遵守的仓库级工作规范。
- [CONTRIBUTING.md](CONTRIBUTING.md)：分支、验证、提交和评审流程。
- [项目全景图](docs/PROJECT_MAP.md)：当前文件定位、未来模块登记和文档同步规则。
- [CHANGELOG.md](CHANGELOG.md)：`feat` 和 `fix` 的可追溯记录。
- [COMMIT_LOG.md](COMMIT_LOG.md)：所有提交的原因、实现方式和验证记录。
- [.gitmessage](.gitmessage)：提交正文模板。

## 当前状态

- 仓库默认分支：`main`
- `wolf-dashboard` 默认监听 `127.0.0.1:8787`，启动、配置和测试命令见下文。
- NGA 需要有效 `NGA_COOKIE`；AI 需要 `OPENAI_API_KEY`，缺少凭据时服务会明确显示降级状态。

## 开始贡献

1. 阅读 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。
2. 查看 [项目全景图](docs/PROJECT_MAP.md)，先确认修改位置和影响范围。
3. 完成功能、修复或文档变更，并按仓库规范验证。
4. 需要时更新项目全景图；`feat` 或 `fix` 还必须更新 [CHANGELOG.md](CHANGELOG.md)。
5. 使用 Conventional Commits 提交，并在正文填写 `Why`、`How`、`Validation`。

## 设计原则

- 让代码、测试、文档和提交记录互相可定位。
- 优先小而明确的改动，避免无关重构和隐式行为。
- 不把密钥、个人数据或未经许可的原始数据提交到仓库。
- 没有可靠验证时如实说明，不以未执行的测试代替验证结论。

## Wolf Dashboard

`wolf-dashboard` 现在提供一个只绑定 `127.0.0.1` 的本地仪表盘：每 5 分钟从 NGA `tid=47288722` 增量检查 `authorid=150058`，请求使用 `opt=262144` 的作者过滤分页，并记录 `(tid,pid)` 去重游标。游标保存的是作者过滤后的页码；检测不到新发言时仍会推进到本轮成功扫描的最高页。首次启动遇到旧版普通帖子页游标时，会从 `NGA_INITIAL_PAGE`（默认 29）重扫上一页到末页并自动迁移。每天 08:30 生成盘前策略版本，并为每条策略保存作者 PID 与规则 ID 引用。行情快照优先使用腾讯财经接口，失败时在页面显示明确的待核验状态。

### 启动

```powershell
cd wolf-dashboard
Copy-Item .env.example .env
python -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt
.\scripts\start.ps1
```

打开 <http://127.0.0.1:8787>。在 `.env` 填写有效的 `NGA_COOKIE` 才能稳定抓取；填写 `OPENAI_API_KEY` 后才会调用 AI，未填写时仍会生成带引用的“待配置 AI”版本，不会伪造结论。

登录后自动启动（Windows）：

```powershell
.\scripts\install-task.ps1
```

### 测试

```powershell
cd wolf-dashboard/backend
$env:PYTHONPATH=(Get-Location).Path
python -m pytest -q
```

接口包括 `/api/status`、`/api/posts`、`/api/strategies`、`/api/watchlist`（含删除）、`/api/aliases`、`/api/tasks/crawl`、`/api/tasks/strategy` 和 `/api/events`（SSE）。
