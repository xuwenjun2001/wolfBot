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

Treat source, `as_of`, adjustment, coverage, freshness, and missing fields as
part of the evidence. Do not invent prices, candles, indicators, screen
coverage, or a data source. If the available evidence cannot verify the
requested claim, return the structured terminal state `insufficient_evidence`
and name the missing field or unavailable data dimension.

This skill does not provide financial statements, valuation, PE/PB, industry
classification, capital-flow, news, announcement, or other unsupported data.
It never promises returns and never turns a screen hit or technical pattern
into a buy, sell, or hold recommendation.
