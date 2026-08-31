#!/usr/bin/env node
/**
 * Real-provider smoke for the WolfBot agent tool contract.
 *
 * Not part of `npm test` or CI: it needs a configured provider, a running
 * FastAPI + sidecar pair and an initialized A-share catalog. The script drives
 * the product API (`POST /api/v1/runs`) instead of the run engine so that the
 * whole path — router, sidecar, tools, FastAPI market endpoints — is covered.
 *
 * It never reads, prints or forwards provider credentials, model text, or raw
 * tool payloads. Only run id, status, tool names, error codes, counts and data
 * timestamps are reported.
 */

const BASE_URL = process.env.WOLFBOT_BASE_URL ?? 'http://127.0.0.1:8787';
const QUESTION = '分析一下药明康德上一周的走势';
const SKILL_MODE = 'auto';
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 300_000;
const MAX_ACCEPTED_TOOL_CALLS = 10;
const MAX_TOOL_CALLS_PER_TURN = 3;
const FORBIDDEN_ERROR_CODES = new Set([
  'TOOL_LIMIT', 'MARKET_REQUEST_LIMIT', 'TOOL_BATCH_LIMIT', 'MAX_TURNS',
  'UNKNOWN_TOOL', 'INVALID_TOOL_INPUT', 'REPEATED_TOOL_FAILURE',
]);
const NON_ACCEPTED_ERROR_CODES = new Set([
  'INVALID_TOOL_INPUT', 'TOOL_BATCH_LIMIT', 'TOOL_LIMIT', 'MARKET_REQUEST_LIMIT',
  'UNKNOWN_TOOL', 'TERMINAL_TOOL_NOT_EXCLUSIVE', 'PROVIDER_ERROR', 'MAX_OUTPUT_TOKENS',
]);
const REQUIRED_TOOLS = ['resolve_symbol', 'get_price_history'];

const failures = [];

function fail(message) {
  failures.push(message);
}

async function requestJson(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned malformed JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const code = body?.detail?.code ?? body?.error?.code ?? 'HTTP_ERROR';
    throw new Error(`${path} failed with HTTP ${response.status} (${code}).`);
  }
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const health = await requestJson('/healthz').catch(() => {
    throw new Error(`FastAPI is not reachable at ${BASE_URL}; start the app before running the smoke.`);
  });
  if (health && health.status && health.status !== 'ok') {
    throw new Error(`FastAPI reported status ${health.status}.`);
  }

  const resolved = await requestJson(`/api/v1/symbols/resolve?query=${encodeURIComponent('药明康德')}`);
  const resolvedSymbol = String(
    resolved.symbol
      ?? resolved.candidates?.[0]?.symbol
      ?? resolved.results?.[0]?.symbol
      ?? '',
  );
  if (resolved.status !== 'resolved' || resolved.ambiguous === true || resolvedSymbol !== 'sh603259') {
    throw new Error('The A-share catalog is not initialized for 药明康德 -> sh603259.');
  }

  const created = await requestJson('/api/v1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ question: QUESTION, skill_mode: SKILL_MODE }),
  });
  const runId = String(created.run_id ?? created.id ?? '');
  if (!runId) throw new Error('Run creation did not return a run id.');

  const deadline = Date.now() + MAX_WAIT_MS;
  let run;
  while (true) {
    run = await requestJson(`/api/v1/runs/${encodeURIComponent(runId)}`);
    const status = String(run.status ?? '');
    if (!['pending', 'running', 'cancelling'].includes(status)) break;
    if (Date.now() > deadline) {
      await requestJson(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }).catch(() => undefined);
      throw new Error(`Run ${runId} did not finish within ${MAX_WAIT_MS / 1000}s.`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const events = Array.isArray(run.events) ? run.events : [];
  const startedByTurn = new Map();
  const startedTools = [];
  const completedTools = [];
  const startsByCall = new Map();
  const endsByCall = new Map();
  const completedByCall = new Map();
  const toolFailures = [];
  const errorCodes = [];
  let terminalSubmitted = false;
  let terminalPayload = null;
  let dataAsOf = '';

  for (const event of events) {
    const payload = event.payload ?? {};
    const name = payload.tool_call?.name ?? payload.toolCall?.name ?? '';
    const callId = String(payload.tool_call?.id ?? payload.toolCall?.id ?? '');
    const turn = Number(payload.turn ?? 0);
    if (event.type === 'tool_started') {
      startedTools.push(name);
      startedByTurn.set(turn, (startedByTurn.get(turn) ?? 0) + 1);
      if (callId) startsByCall.set(callId, (startsByCall.get(callId) ?? 0) + 1);
    }
    if (event.type === 'tool_completed') {
      completedTools.push(name);
      if (callId) {
        endsByCall.set(callId, (endsByCall.get(callId) ?? 0) + 1);
        completedByCall.set(callId, { name, data: payload.data ?? {} });
      }
    }
    if (event.type === 'tool_failed') {
      const code = payload.result?.error?.code ?? payload.error?.code ?? 'UNKNOWN';
      if (callId) endsByCall.set(callId, (endsByCall.get(callId) ?? 0) + 1);
      toolFailures.push({ callId, name, code });
      errorCodes.push(code);
    }
    if (event.type === 'run_failed') errorCodes.push(payload.error?.code ?? 'UNKNOWN');
    if (event.type === 'terminal_submitted') {
      terminalSubmitted = true;
      terminalPayload = payload;
      dataAsOf = String(payload.dataAsOf ?? payload.data_as_of ?? '');
    }
  }

  const acceptedCalls = completedTools.length + toolFailures.filter(({ code }) => !NON_ACCEPTED_ERROR_CODES.has(code)).length;
  const maxPerTurn = Math.max(0, ...startedByTurn.values());

  if (run.status !== 'completed') fail(`final status is ${run.status}, expected completed`);
  if (!terminalSubmitted) fail('no terminal_submitted event was recorded');
  for (const [callId, count] of startsByCall) {
    if (count !== 1) fail(`tool call ${callId} emitted ${count} tool_started events`);
    if ((endsByCall.get(callId) ?? 0) !== 1) fail(`tool call ${callId} did not emit exactly one terminal lifecycle event`);
  }
  for (const callId of endsByCall.keys()) {
    if (!startsByCall.has(callId)) fail(`tool call ${callId} ended without tool_started`);
  }
  for (const tool of REQUIRED_TOOLS) {
    if (!completedTools.includes(tool)) fail(`${tool} did not complete successfully`);
  }
  for (const code of errorCodes) {
    if (FORBIDDEN_ERROR_CODES.has(code)) fail(`run produced the forbidden error code ${code}`);
  }
  if (acceptedCalls > MAX_ACCEPTED_TOOL_CALLS) fail(`${acceptedCalls} accepted tool calls exceed the ${MAX_ACCEPTED_TOOL_CALLS} budget for this case`);
  if (maxPerTurn > MAX_TOOL_CALLS_PER_TURN) fail(`a turn issued ${maxPerTurn} tool calls, above the ${MAX_TOOL_CALLS_PER_TURN} batch limit`);
  const evidence = Array.isArray(run.evidence) ? run.evidence : [];
  if (!evidence.length) fail('run recorded no evidence rows');
  const submission = run.answer && typeof run.answer === 'object' ? run.answer : (terminalPayload ?? {});
  const submissionEvidence = Array.isArray(submission.evidence) ? submission.evidence : [];
  const completedCallIds = new Set(completedByCall.keys());
  for (const item of submissionEvidence) {
    const callId = String(item?.toolCallId ?? item?.tool_call_id ?? '');
    if (!callId || !completedCallIds.has(callId)) fail(`terminal evidence references a non-completed tool call: ${callId || '<missing>'}`);
  }
  const historyCallIds = new Set(
    [...completedByCall.entries()].filter(([, value]) => value.name === 'get_price_history').map(([callId]) => callId),
  );
  const historyEvidence = submissionEvidence.find((item) => historyCallIds.has(String(item?.toolCallId ?? item?.tool_call_id ?? '')));
  if (!historyEvidence) fail('terminal evidence does not reference the successful get_price_history call');
  if (historyEvidence && !String(historyEvidence.source ?? '').trim()) fail('history evidence does not declare its source');
  if (historyEvidence && !String(historyEvidence.asOf ?? historyEvidence.as_of ?? '').trim()) fail('history evidence does not declare as_of');
  const historyResults = [...completedByCall.values()].filter((value) => value.name === 'get_price_history');
  if (!historyResults.some((value) => ['none', 'qfq', 'hfq'].includes(String(value.data?.adjustment ?? '')))) {
    fail('get_price_history evidence does not expose the applied adjustment');
  }
  if (!Array.isArray(submission.limitations) || submission.limitations.length === 0) fail('terminal submission has no limitations');
  dataAsOf = String(submission.dataAsOf ?? submission.data_as_of ?? dataAsOf ?? '');

  console.log('WolfBot provider smoke');
  console.log(`  run_id            : ${runId}`);
  console.log(`  status            : ${run.status}`);
  console.log(`  turns             : ${run.turns ?? '-'}`);
  console.log(`  tool calls started: ${startedTools.length} (max ${maxPerTurn} per turn)`);
  console.log(`  accepted calls     : ${acceptedCalls}`);
  console.log(`  tools started     : ${[...new Set(startedTools)].join(', ') || '-'}`);
  console.log(`  tools completed   : ${[...new Set(completedTools)].join(', ') || '-'}`);
  console.log(`  error codes       : ${[...new Set(errorCodes)].join(', ') || 'none'}`);
  console.log(`  evidence rows     : ${evidence.length}`);
  console.log(`  data as_of        : ${dataAsOf || '-'}`);

  if (failures.length) {
    console.error('\nSmoke FAILED:');
    for (const message of failures) console.error(`  - ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nSmoke PASSED');
}

main().catch((error) => {
  console.error(`Smoke FAILED: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
