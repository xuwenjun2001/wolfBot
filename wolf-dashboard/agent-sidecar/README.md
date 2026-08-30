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

The sidecar never accesses WolfBot's SQLite database or arbitrary files. Its
market tools call only `http://127.0.0.1:8787/api/v1/` allowlisted read-only
paths; `screen_stocks` alone may call the dedicated screener POST endpoint.
The initial skill descriptors contain bounded metadata only; `load_skill` and
`read_skill_reference` fetch the selected enabled skill content through the
fixed local FastAPI skill endpoints. No arbitrary URL or filesystem access is
added by these reads.
There is no shell, script, arbitrary HTTP, write, database, or trading tool.

## Tests

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```
