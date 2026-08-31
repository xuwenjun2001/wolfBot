---
name: wolf-investing
description: Analyze MVP market, K-line, indicator, and screened-candidate data with explicit evidence limits.
metadata:
  version: 0.1.0
  scope: market-analysis
  applicable_scope: stocks, indices, ETFs, quotes, K-lines, indicators, and deterministic screening
---

# Wolf Investing

Version: 0.1.0.

Use this skill only for a self-contained research question that can be answered
from the MVP market contract. First resolve the instrument and the requested
time window, then request the smallest required quote, K-line, indicator, or
screening fields. Use the field contract in
[references/market-fields.md](references/market-fields.md) when choosing or
checking fields.

## Tool workflow

- Resolve a name or code with `resolve_symbol` before any other market tool,
  then reuse the canonical symbol it returns (for example `sh603259`).
- For a single-instrument trend question, take the smallest useful
  `get_price_history` window first. Only call `get_technical_indicators` or
  `get_realtime_quote` when the question still needs moving averages,
  volatility, drawdown, or an intraday price.
- Call only the semantic tools present in the tool definitions for this run.
  There is no generic HTTP, path, or query tool; do not invent one.
- Read only the paths listed in `load_skill.available_references`. Never guess a
  reference path.
- Prefer one tool call per turn. Correct a rejected argument once; if the same
  validation error repeats, submit `insufficient_evidence` instead of issuing a
  batch of guesses.

Treat source, `as_of`, adjustment, coverage, freshness, and missing fields as
part of the evidence. Do not invent prices, candles, indicators, screen
coverage, or a data source. If the available evidence cannot verify the
requested claim, return the structured terminal state `insufficient_evidence`
and name the missing field or unavailable data dimension.

This skill does not provide financial statements, valuation, PE/PB, industry
classification, capital-flow, news, announcement, or other unsupported data.
It never promises returns and never turns a screen hit or technical pattern
into a buy, sell, or hold recommendation.
