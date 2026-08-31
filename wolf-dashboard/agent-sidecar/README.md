# WolfBot Agent Sidecar

This package is the local TypeScript PI Agent runtime for WolfBot. It uses
`@earendil-works/pi-agent-core@0.82.1` and `@earendil-works/pi-ai@0.82.1`,
requires Node.js 22 or newer, and listens only on `127.0.0.1:8790`.

## Run

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

The model provider reads `OPENAI_API_KEY`, `OPENAI_BASE_URL` (default
`https://api.openai.com/v1`), `OPENAI_MODEL` (default `gpt-4o-mini`), and
`OPENAI_REASONING_EFFORT`. Requests to the provider use the OpenAI-compatible
streaming `/chat/completions` contract.

When launched through `../scripts/start.ps1`, existing process variables win;
otherwise the script imports only those four Provider variables from the local
dashboard or repository `.env`. It does not forward Cookie configuration to
the sidecar.

## FastAPI contract

`GET /healthz` returns the sidecar and PI SDK identity. `POST
/internal/v1/runs` accepts newline-delimited JSON input and returns a streamed
`application/x-ndjson` event sequence. A request contains `run_id`, `question`,
optional validated `skills`, and optional `selected_skill`; tool definitions are
fixed by the sidecar and cannot be supplied by the caller. A successful run
must emit `terminal_submitted` and `run_finished` with `status: "completed"`.
The only terminal statuses accepted by `submit_analysis` are
`completed` and `insufficient_evidence`.

`POST /internal/v1/runs/{run_id}/cancel` returns `202` after requesting
cancellation. A new run while another is active returns `409`.

The sidecar never accesses WolfBot's SQLite database or arbitrary files. The
model never supplies a URL, path, HTTP method, or query key: each market tool is
bound to exactly one FastAPI endpoint by the sidecar.

| Tool | Model input | Fixed request |
| --- | --- | --- |
| `resolve_symbol` | `query` | `GET /api/v1/symbols/resolve` |
| `get_realtime_quote` | `symbol` | `GET /api/v1/quotes/realtime/{symbol}` |
| `get_price_history` | `symbol`, `adjustment?`, `limit?` | `GET /api/v1/quotes/history/{symbol}` |
| `get_technical_indicators` | `symbol`, `adjustment?`, `limit?` | `GET /api/v1/indicators/technical/{symbol}` |
| `get_universe_summary` | — | `GET /api/v1/research/universes/summary` |
| `get_universe_members` | `page?`, `page_size?` | `GET /api/v1/research/universes/a-share/members` |
| `get_preset_candidates` | `mode`, `as_of?`, `limit?` | `GET /api/v1/research/screeners/a-share/short-term-candidates` |
| `screen_stocks` | `conditions`, `sort`, `as_of?`, `limit?` | `POST /api/v1/research/screeners/a-share/query` |
| `submit_analysis` | structured terminal state | local terminal tool |

`symbol` must match `^(?:sh|sz|bj)[0-9]{6}$`, so a name has to go through
`resolve_symbol` first. The screener field, operator and sort enums are
published in the tool schema and re-validated on the server.

`load_skill` and `read_skill_reference` are registered only when a usable
enabled skill exists for the run: never for `selected_skill` `none`/`null`, and
never in automatic mode without an enabled skill. `load_skill` returns the exact
`available_references` list; `read_skill_reference` refuses any other path.
The initial skill descriptors contain bounded metadata only, and the content is
fetched through the fixed local FastAPI skill endpoints. No arbitrary URL or
filesystem access is added by these reads.
There is no shell, script, arbitrary HTTP, write, database, or trading tool.
The retired generic `quant_api_get` tool is no longer registered; historical run
events that reference it stay readable in the backend.

## Run loop budgets and failure semantics

Defaults per run: 8 model turns, 20 accepted tool calls, 16 market requests,
12,000 cumulative output tokens, 300 s wall clock.

- A turn may request at most 3 tool calls. A larger batch is rejected whole with
  `TOOL_BATCH_LIMIT`, spends no budget, and the next turn may retry.
- Argument validation runs before any budget is spent, so an invalid call fails
  with `INVALID_TOOL_INPUT` without consuming a tool slot or a market request.
- Three consecutive tool turns without a single success end the run with
  `REPEATED_TOOL_FAILURE` instead of burning the remaining budget.
- Every tool call emits exactly one `tool_started` followed by one
  `tool_completed` or `tool_failed`, with a specific redacted error code.
- Every successful result exposes its exact `tool_call_id` to the model.
  `submit_analysis` evidence must copy that value rather than a tool name;
  invalid references return the safe list of completed call ids.
- PI schema rejection messages strip the full received argument object before
  they are returned to the model or persisted as public events.

## Tests

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

## Real-provider smoke (explicit, not in CI)

```powershell
npm.cmd run smoke:provider
```

Requires a configured provider, a running FastAPI + sidecar pair, an
initialized A-share catalog, and no other active run. The script creates a real
run through `POST /api/v1/runs` and prints only the run id, status, tool names,
error codes, counts, and data timestamps — never credentials, model text, or raw
tool payloads.
