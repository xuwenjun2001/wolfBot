# Wolf Research Market Data

Standalone FastAPI market-data boundary for Wolf Research. The service owns
provider calls, bounded retries, cache files, and PostgreSQL-backed research
pool queries. It never reads source-project or legacy dashboard files.

## Run

From `wolf-research`:

```powershell
uv sync --project services/market-data --group dev
$env:WOLF_RESEARCH_MARKET_DATABASE_URL = $env:DATABASE_URL
npm.cmd run market:dev
```

The default bind address is `127.0.0.1:8001`. `/health` is a process check;
`/ready` checks the configured PostgreSQL connection. Market and provider
errors return a stable error code, retryability and HTTP status. Empty local
data is reported as a data-quality warning rather than being presented as
fresh data.

Run the service tests with:

```powershell
npm.cmd run market:test
```
