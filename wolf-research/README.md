# Wolf Research

Wolf Research is the independently runnable WolfBot slice for the research
workbench (`/`) and evaluation center (`/eval-platform`). It is managed by the
parent WolfBot Git repository; do not initialize a repository inside this
directory. It has no runtime dependency on the legacy dashboard host.

The first release is for a trusted Windows workstation. PostgreSQL is the
durable state store and the market-data service is a separate local FastAPI
process. Authentication, quota, memory and governed knowledge are explicit
disabled facades in this slice. They do not create sessions or silently return
personalized data.

## Requirements

- Node.js 22.19 or newer
- npm 10 or newer
- Python 3.14
- uv
- PostgreSQL 16 or a compatible PostgreSQL/TimescaleDB instance
- A configured OpenAI-compatible local model or DeepSeek API for normal
  model-backed research requests

## Install And Check

Run these commands from `wolf-research`:

```powershell
npm.cmd ci
npm.cmd run prisma:generate
npm.cmd run type-check
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run check:skills
npm.cmd run check:eval-datasets
npm.cmd run check:eval-judge-calibration
npm.cmd run check:eval-mutations
npm.cmd run check:module-boundaries
npm.cmd run check:ai-provider-boundary
npm.cmd run build

uv sync --project services/market-data --group dev
npm.cmd run market:test
```

Use a dedicated validation database. Deploy the checked-in schema explicitly:

```powershell
$env:DATABASE_URL = 'postgresql://wolf_research:change-me@127.0.0.1:55432/wolf_research'
npm.cmd run prisma:deploy
```

Copy variable names from `.env.example` into the process environment or an
ignored local environment file. Installation does not create or modify
environment files. `npm.cmd run preflight` reports missing configuration by
variable name before any application service starts.

For a DeepSeek-official-only trusted Windows workstation, leave
`MODELPORT_API_KEY` unset and create the ignored `.env.local` file with the
following minimum configuration. Replace both placeholders with your own
PostgreSQL connection and DeepSeek official key:

```dotenv
DATABASE_URL="postgresql://<db-user>:<url-encoded-db-password>@127.0.0.1:5432/wolf_research"
WOLF_RESEARCH_MARKET_DATA_URL="http://127.0.0.1:8001"
WOLF_RESEARCH_AUTH_MODE="disabled"
WOLF_RESEARCH_QUOTA_MODE="disabled"
WOLF_RESEARCH_MEMORY_MODE="disabled"
WOLF_RESEARCH_KNOWLEDGE_MODE="disabled"
DEEPSEEK_API_KEY="<your-own-official-deepseek-key>"
WOLF_RESEARCH_EVAL_MODEL="deepseek-v4-flash"
WOLF_RESEARCH_LLM_AGENT_ENABLED="1"
WOLF_RESEARCH_LLM_QUERY_REWRITE_ENABLED="1"
PI_AGENT_REASONING="0"
WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE="1"
WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS="1"
```

The two `ALLOW_*` values above are appropriate only for the explicitly
approved, loopback-only trusted Windows setup. Generated dashboard code runs
directly on the host and is not sandboxed. Keep both values at `0` on a
network-facing deployment.

The research workbench still lists local Qwen first, so select **DeepSeek V4
Flash (Official Direct)** when creating or continuing a project. The
evaluation center's Agent reviewer selects the same official-direct profile
and preserves it in the queue and benchmark report. Unknown runtime or model
IDs are rejected instead of falling back to Qwen. Never reuse or copy a source
project credential into this target.

The official DeepSeek profile keeps Agent thinking disabled by default because
hidden reasoning shares the bounded multi-turn output budget with tool calls.
`PI_AGENT_REASONING=1` is an explicit opt-in experiment; it does not raise any
turn, token, tool or timeout limit, so a reasoning-heavy run may fail closed.

## Local Windows Run

Start the market service in one terminal:

```powershell
$env:WOLF_RESEARCH_MARKET_DATABASE_URL = '<same PostgreSQL URL used in .env.local>'
npm.cmd run market:dev
```

The Python market process does not load Next.js `.env.local`; inject its
database URL in that terminal as shown above. Do not put the DeepSeek key in
the market-service environment.

Start the Next.js application in another terminal:

```powershell
$env:WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS = '1'
npm.cmd run start:checked -- --hostname 127.0.0.1 --port 3010
```

Open [http://127.0.0.1:3010/](http://127.0.0.1:3010/) for the research
workbench or [http://127.0.0.1:3010/eval-platform](http://127.0.0.1:3010/eval-platform)
for evaluations. The market service health endpoints are `/health` and
`/ready` on port 8001.

`WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS=1` is required for the production-mode
browser UI to create, start and cancel evaluation tasks without exposing an
admin token to the browser. It only permits same-origin requests whose effective
host is loopback. Keep it at `0` for network-facing deployments. If
`WOLF_RESEARCH_ADMIN_TOKEN` is configured, it remains mandatory for every
mutation and takes precedence over the loopback switch.

Generated dashboards run locally on the Windows host. Preview is refused by
default. Set
`WOLF_RESEARCH_ALLOW_UNSANDBOXED_GENERATED_CODE=1` only on a trusted isolated
machine to enable the explicit `windows-unsandboxed` adapter. This is not a
security sandbox, and the status is exposed by preflight, API responses and
preview metadata. An unavailable model or market service returns a typed
failure; it is never reported as a successful dashboard.

## Evaluation

The contract benchmark is deterministic and uses only the checked-in contract
market fixture:

```powershell
npm.cmd run benchmark:quant:contract
```

It is suitable for local and CI contract checks. `benchmark:quant:e2e` is a
separate model-backed path and requires the normal research runtime, configured
market data, a configured model and the explicit Windows preview gate. It must
not be replaced by contract mode when it is unavailable.

Run the official DeepSeek path explicitly with:

```powershell
npm.cmd run benchmark:quant:e2e -- --model=deepseek-v4-flash
```

Refactor decisions, source attribution, batch history and validation results
are recorded under `docs/migration/`. The final validation record is
`docs/migration/VALIDATION_REPORT.md`.
