import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const helpers = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-market.js'));
const { chartTargetFromRun, mergeChartPoints, securityIdentity, resolvedSecurityIdentity } = helpers;

function completed(tool, data, sequence = 1) {
  return { type: 'tool_completed', sequence, payload: { ok: true, tool_call: { id: `c${sequence}`, name: tool }, data } };
}

const RESOLVED = {
  query: '生益',
  status: 'resolved',
  ambiguous: false,
  candidate_count: 1,
  symbol: 'sh600183',
  code: '600183',
  name: '生益科技',
  asset_type: 'stock',
  exchange: 'SH',
};

test('a unique resolution alone selects the chart target', () => {
  const target = chartTargetFromRun(null, [completed('resolve_symbol', RESOLVED)]);
  assert.deepEqual(target, { symbol: 'sh600183', code: '600183', name: '生益科技', asset_type: 'stock' });
});

test('daily bars and indicators outrank a quote and a resolution', () => {
  const events = [
    completed('resolve_symbol', RESOLVED, 1),
    completed('get_realtime_quote', { symbol: 'sh600183', code: '600183', name: '生益科技', asset_type: 'stock' }, 2),
    completed('get_price_history', { symbol: 'sh603259', code: '603259', name: '药明康德', asset_type: 'stock' }, 3),
  ];
  assert.equal(chartTargetFromRun(null, events).symbol, 'sh603259');
});

test('multiple securities at the same evidence tier remain unselected', () => {
  const events = [
    completed('get_price_history', { symbol: 'sh600183', code: '600183', name: '生益科技', asset_type: 'stock' }, 1),
    completed('get_technical_indicators', { symbol: 'sh603259', code: '603259', name: '药明康德', asset_type: 'stock' }, 2),
  ];
  assert.equal(chartTargetFromRun(null, events), null);
});

test('ambiguous, multi-candidate and unresolved resolutions never select a target', () => {
  const ambiguous = { query: '000001', status: 'ambiguous', ambiguous: true, candidate_count: 2, candidates: [{ symbol: 'sh000001' }, { symbol: 'sz000001' }] };
  assert.equal(chartTargetFromRun(null, [completed('resolve_symbol', ambiguous)]), null);
  assert.equal(resolvedSecurityIdentity({ status: 'resolved', candidate_count: 2, symbol: 'sh600183' }), null);
  assert.equal(resolvedSecurityIdentity({ status: 'not_found', symbol: 'sh600183' }), null);
});

test('screener candidates and board objects never select a target', () => {
  const screener = completed('screen_stocks', { universe_id: 'a-share', candidate_count: 3, results: [{ symbol: 'sh600183' }, { symbol: 'sh603259' }] }, 1);
  const board = completed('get_board_snapshot', { board_id: 'a1b2c3d4', name: '液冷板块', board_type: 'concept', change_pct: 2.1 }, 2);
  assert.equal(chartTargetFromRun(null, [screener, board]), null);
});

test('a failed tool call and a non-canonical symbol are rejected', () => {
  const failed = { type: 'tool_completed', sequence: 1, payload: { ok: false, tool_call: { name: 'get_price_history' }, data: { symbol: 'sh600183' } } };
  assert.equal(chartTargetFromRun(null, [failed]), null);
  assert.equal(securityIdentity({ symbol: '600183' }), null);
  assert.equal(securityIdentity({ symbol: 'us600183' }), null);
  assert.equal(securityIdentity({ symbol: 'sh600183' }), null);
  assert.equal(securityIdentity({ symbol: 'sh600183', asset_type: 'board' }), null);
  assert.equal(resolvedSecurityIdentity({ status: 'resolved', ambiguous: false, symbol: 'sh600183', asset_type: 'stock' }), null);
});

test('a historical run recovers its target from persisted evidence', () => {
  const run = { evidence: [{ tool: 'get_price_history', payload: { symbol: 'sh603259', code: '603259', name: '药明康德', asset_type: 'stock' } }] };
  assert.equal(chartTargetFromRun(run, []).symbol, 'sh603259');
});

test('a historical run recovers its target from a market_evidence artifact', () => {
  const run = { artifacts: [{ artifact_type: 'market_evidence', metadata: { tool: 'get_price_history', symbol: 'sh600183', code: '600183', name: '生益科技', asset_type: 'stock' } }] };
  assert.equal(chartTargetFromRun(run, []).symbol, 'sh600183');
});

test('an artifact without an allowed tool name cannot select a target', () => {
  const run = { artifacts: [{ artifact_type: 'market_evidence', metadata: { symbol: 'sh600183', code: '600183', name: '生益科技', asset_type: 'stock' } }] };
  assert.equal(chartTargetFromRun(run, []), null);
});

test('a trimmed legacy resolve summary stays unrecoverable', () => {
  const run = {
    evidence: [{ tool: 'resolve_symbol', payload: { asset_type: 'stock', exchange: 'SH', source: 'local-catalog', status: 'resolved' } }],
    artifacts: [{ artifact_type: 'market_evidence', metadata: { asset_type: 'stock', exchange: 'SH', source: 'local-catalog' } }],
  };
  assert.equal(chartTargetFromRun(run, []), null);
});

test('bars keep real OHLCV while indicator points only add moving averages', () => {
  const history = {
    bars: [
      { date: '2026-08-28', open: 11, high: 12, low: 10.5, close: 11.8, volume: 300 },
      { date: '2026-08-27', open: 10, high: 10.9, low: 9.8, close: 10.6, volume: 200 },
    ],
  };
  const indicators = {
    points: [
      { date: '2026-08-27', close: 10.6, volume: 999, ma5: 10.1, ma10: null },
      { date: '2026-08-28', close: 11.8, volume: 999, ma5: 10.9, ma20: 10.4 },
    ],
  };
  const merged = mergeChartPoints(history, indicators);
  assert.deepEqual(merged.points.map((point) => point.date), ['2026-08-27', '2026-08-28']);
  assert.deepEqual(merged.points[1], {
    date: '2026-08-28', open: 11, high: 12, low: 10.5, close: 11.8, volume: 300,
    ma5: 10.9, ma10: null, ma20: 10.4, ma30: null, ma60: null,
  });
  assert.equal(merged.points[0].ma5, 10.1);
  assert.equal(merged.maCovered, 2);
  assert.deepEqual(merged.warnings, []);
});

test('indicator points alone never synthesize candles', () => {
  const merged = mergeChartPoints(null, { points: [{ date: '2026-08-28', close: 11.8, ma5: 10.9 }] });
  assert.deepEqual(merged.points, []);
  assert.equal(merged.maCovered, 0);
});

test('bars without complete OHLC are dropped instead of rebuilt from close', () => {
  const merged = mergeChartPoints({
    bars: [
      { date: '2026-08-28', open: null, high: null, low: null, close: 11.8, volume: 100 },
      { date: '', open: 1, high: 2, low: 1, close: 2 },
      { date: '2026-08-27', open: 10, high: 10.9, low: 9.8, close: 10.6, volume: null },
    ],
  }, null);
  assert.deepEqual(merged.points.map((point) => point.date), ['2026-08-27']);
  assert.equal(merged.points[0].volume, null);
  assert.equal(merged.warnings.length, 1);
  assert.match(merged.warnings[0], /已跳过 2 条/);
});

test('duplicate dates are merged and unmatched indicator points are reported', () => {
  const merged = mergeChartPoints({
    bars: [
      { trade_date: '20260828', open: 11, high: 12, low: 10.5, close: 11.8, volume: 300 },
      { date: '2026-08-28', open: 11.1, high: 12.1, low: 10.6, close: 11.9, volume: 310 },
    ],
  }, { points: [{ date: '2026-08-21', ma5: 9.9 }] });
  assert.equal(merged.points.length, 1);
  assert.equal(merged.points[0].close, 11.9);
  assert.equal(merged.warnings.length, 2);
  assert.match(merged.warnings.join('；'), /重复日期/);
  assert.match(merged.warnings.join('；'), /没有匹配的日线/);
});

test('indicator volume only fills a missing history volume', () => {
  const merged = mergeChartPoints(
    { bars: [{ date: '2026-08-28', open: 11, high: 12, low: 10.5, close: 11.8, volume: null }] },
    { points: [{ date: '2026-08-28', volume: 500, ma5: 10.9 }] },
  );
  assert.equal(merged.points[0].volume, 500);
});
