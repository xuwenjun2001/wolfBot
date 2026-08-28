# Wolf Dashboard

本目录是 WolfBot 的本地仪表盘实现。服务默认只监听 `127.0.0.1:8787`，数据写入 `data/wolf.sqlite3`（已被 Git 忽略）。

## 运行

```powershell
Copy-Item .env.example .env
python -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt
.\scripts\start.ps1
```

填写 `NGA_COOKIE` 后，后台会按 5 分钟间隔从作者过滤页的 `last_page - 1` 开始重叠扫描，并以 `(tid,pid)` 去重。请求固定带有 `authorid` 和 `opt=262144`，因此 `crawl_cursor.last_page` 表示作者过滤分页的页码，而不是普通帖子页码。没有新发言时游标也会推进到本轮成功扫描的最高页；检测到旧版普通帖子页游标时，首次会从 `NGA_INITIAL_PAGE`（默认 29）重扫 28～31 一带并在成功后标记迁移完成。NGA `lite=js` 响应沿用了 nga-mofish 的必要兼容逻辑：GBK/GB18030 解码、`window.script_muti_get_var_store` 包装剥离、`signature`/`alterinfo` 清理、JSON5 和截断响应修复，以及 `__PAGE`/`__R`/作者字段提取；没有依赖 VS Code runtime 或插件私有状态。

行情快照使用腾讯报价和日线接口：报价保存当前值与昨收，盘前快照额外保存最近一个已完成交易日的 OHLCV；接口失败会把错误写入快照并在页面标成待核验。AI 使用 OpenAI-compatible `/chat/completions`，可通过 `OPENAI_REASONING_EFFORT` 传递兼容模型的思考强度（例如 `max`），并通过 `OPENAI_REQUEST_TIMEOUT` 配置 AI 独立超时（最大 1200 秒）。每条策略必须通过服务端校验，至少包含一个已存在的作者 PID 和一个已存在的规则 ID。没有 API Key 时会记录 `needs_configuration` 版本，并不会用无来源文本冒充 AI 结论。

## 检查

```powershell
cd backend
$env:PYTHONPATH=(Get-Location).Path
python -m pytest -q
```
