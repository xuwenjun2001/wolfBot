/**
 * Pure chart-target discovery and OHLCV/MA merge helpers for the Agent page.
 *
 * The file is loaded as a classic browser script before `agent.js` and is also
 * `require()`-able from `node --test`, so the selection and merge rules can be
 * covered without a browser or a third-party test framework.
 */
(function attach(root, factory) {
  const api = factory();
  root.WolfAgentMarket = api;
  if (typeof module === 'object' && module !== null && typeof module.exports === 'object') module.exports = api;
}(typeof globalThis === 'object' ? globalThis : this, function build() {
  'use strict';

  const CANONICAL_SYMBOL_PATTERN = /^(?:sh|sz|bj)[0-9]{6}$/;
  // Boards, concepts, industries and themes are separate objects with their own
  // page section; only a single tradable security may drive the candle chart.
  const CHART_ASSET_TYPES = new Set(['stock', 'index', 'etf']);
  const HISTORY_TOOLS = new Set(['get_price_history', 'get_technical_indicators']);
  const QUOTE_TOOLS = new Set(['get_realtime_quote']);
  const MA_KEYS = ['ma5', 'ma10', 'ma20', 'ma30', 'ma60'];
  const ISO_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  const COMPACT_DATE_PATTERN = /^([0-9]{4})([0-9]{2})([0-9]{2})$/;
  const DATE_PREFIX_PATTERN = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]/;

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  /** Reduce a trading day to one comparable `YYYY-MM-DD` key, or `''`. */
  function normalizeDate(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (ISO_DATE_PATTERN.test(text)) return text;
    const compact = COMPACT_DATE_PATTERN.exec(text);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    const prefixed = DATE_PREFIX_PATTERN.exec(text);
    return prefixed ? prefixed[1] : '';
  }

  /** Accept a public tool payload as a chart target only when it names one security. */
  function securityIdentity(value) {
    if (!isObject(value)) return null;
    const symbol = String(value.symbol === null || value.symbol === undefined ? '' : value.symbol).trim().toLowerCase();
    if (!CANONICAL_SYMBOL_PATTERN.test(symbol)) return null;
    const assetType = String(value.asset_type === null || value.asset_type === undefined ? '' : value.asset_type).trim().toLowerCase();
    if (!CHART_ASSET_TYPES.has(assetType)) return null;
    const code = String(value.code === null || value.code === undefined ? '' : value.code).trim() || symbol.slice(2);
    const name = String(value.name === null || value.name === undefined ? '' : value.name).trim();
    return { symbol, code, name, asset_type: assetType };
  }

  /** A resolution names a target only when it is resolved and unambiguous. */
  function resolvedSecurityIdentity(value) {
    if (!isObject(value)) return null;
    if (value.ambiguous !== false) return null;
    const status = String(value.status === null || value.status === undefined ? '' : value.status).trim();
    if (status !== 'resolved') return null;
    const count = Number(value.candidate_count);
    if (!Number.isFinite(count) || count !== 1) return null;
    return securityIdentity(value);
  }

  /**
   * Find the single security the chart should display, independent of the
   * screener candidate table.  Priority: daily bars or indicators, then a
   * realtime quote, then a unique resolution, then persisted run records.
   */
  function chartTargetFromRun(run, events) {
    const tiers = [new Map(), new Map(), new Map(), new Map()];
    const record = (tier, identity) => {
      if (identity) tiers[tier].set(identity.symbol, identity);
    };
    (Array.isArray(events) ? events : []).forEach((event) => {
      if (!isObject(event) || event.type !== 'tool_completed') return;
      const payload = isObject(event.payload) ? event.payload : {};
      if (payload.ok === false) return;
      const call = isObject(payload.tool_call) ? payload.tool_call : isObject(payload.toolCall) ? payload.toolCall : {};
      const tool = String(call.name === null || call.name === undefined ? '' : call.name);
      if (HISTORY_TOOLS.has(tool)) record(0, securityIdentity(payload.data));
      else if (QUOTE_TOOLS.has(tool)) record(1, securityIdentity(payload.data));
      else if (tool === 'resolve_symbol') record(2, resolvedSecurityIdentity(payload.data));
    });
    (Array.isArray(run && run.evidence) ? run.evidence : []).forEach((row) => {
      if (!isObject(row)) return;
      const tool = String(row.tool === null || row.tool === undefined ? '' : row.tool);
      const payload = isObject(row.payload) ? row.payload : {};
      if (HISTORY_TOOLS.has(tool) || QUOTE_TOOLS.has(tool)) record(3, securityIdentity(payload));
      else if (tool === 'resolve_symbol') record(3, resolvedSecurityIdentity(payload));
    });
    if (tiers[3].size === 0) {
      (Array.isArray(run && run.artifacts) ? run.artifacts : []).forEach((artifact) => {
        if (!isObject(artifact)) return;
        if (String(artifact.artifact_type === null || artifact.artifact_type === undefined ? '' : artifact.artifact_type) !== 'market_evidence') return;
        const metadata = isObject(artifact.metadata) ? artifact.metadata : {};
        const tool = String(metadata.tool === null || metadata.tool === undefined ? '' : metadata.tool);
        if (HISTORY_TOOLS.has(tool) || QUOTE_TOOLS.has(tool)) record(3, securityIdentity(metadata));
        else if (tool === 'resolve_symbol') record(3, resolvedSecurityIdentity(metadata));
      });
    }
    for (const tier of tiers) {
      // A chart target must be unique at the highest evidence tier reached.
      // Comparative/multi-security runs deliberately remain unselected.
      if (tier.size > 1) return null;
      if (tier.size === 1) return tier.values().next().value;
    }
    return null;
  }

  /**
   * Merge daily bars and indicator points by trading day.
   *
   * `history.bars` is the only source of open/high/low/close/volume;
   * `indicators.points` may only add moving averages.  A bar without real OHLC
   * is dropped instead of being rebuilt from its close.
   */
  function mergeChartPoints(history, indicators) {
    const byDate = new Map();
    const bars = Array.isArray(history && history.bars) ? history.bars : [];
    let droppedBars = 0;
    let duplicateBars = 0;
    bars.forEach((bar) => {
      if (!isObject(bar)) return;
      const date = normalizeDate(bar.date === null || bar.date === undefined ? bar.trade_date : bar.date);
      if (!date) {
        droppedBars += 1;
        return;
      }
      const open = finiteNumber(bar.open);
      const high = finiteNumber(bar.high);
      const low = finiteNumber(bar.low);
      const close = finiteNumber(bar.close);
      if (open === null || high === null || low === null || close === null) {
        droppedBars += 1;
        return;
      }
      if (byDate.has(date)) duplicateBars += 1;
      byDate.set(date, {
        date,
        open,
        high,
        low,
        close,
        volume: finiteNumber(bar.volume),
        ma5: null,
        ma10: null,
        ma20: null,
        ma30: null,
        ma60: null,
      });
    });
    const points = Array.isArray(indicators && indicators.points) ? indicators.points : [];
    let unmatched = 0;
    let maCovered = 0;
    points.forEach((point) => {
      if (!isObject(point)) return;
      const date = normalizeDate(point.date === null || point.date === undefined ? point.trade_date : point.date);
      const base = date ? byDate.get(date) : undefined;
      if (!base) {
        unmatched += 1;
        return;
      }
      let covered = false;
      MA_KEYS.forEach((key) => {
        const value = finiteNumber(point[key]);
        if (value === null) return;
        base[key] = value;
        covered = true;
      });
      if (covered) maCovered += 1;
      // Volume is a history field; the indicator copy is only a fallback.
      if (base.volume === null) base.volume = finiteNumber(point.volume);
    });
    const warnings = [];
    if (droppedBars) warnings.push(`已跳过 ${droppedBars} 条缺少完整开高低收的日线。`);
    if (duplicateBars) warnings.push(`合并了 ${duplicateBars} 条重复日期的日线。`);
    if (unmatched && byDate.size) warnings.push(`${unmatched} 个指标点没有匹配的日线，未叠加均线。`);
    const merged = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
    return { points: merged, warnings, maCovered };
  }

  return {
    CANONICAL_SYMBOL_PATTERN,
    CHART_ASSET_TYPES,
    MA_KEYS,
    normalizeDate,
    securityIdentity,
    resolvedSecurityIdentity,
    chartTargetFromRun,
    mergeChartPoints,
  };
}));
