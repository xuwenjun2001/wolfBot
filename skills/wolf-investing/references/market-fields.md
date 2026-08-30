# MVP market field contract

Use only fields that are present in the MVP service response. Preserve the
source and freshness metadata beside every conclusion.

## Instrument and quote

- Identity: `code`, `name`, `asset_type`, and `market`.
- Quote: `price`, `change_pct`, `snapshot_at`, `source`, `status`, and
  `data_quality` when supplied.

## K-line and indicators

- K-line: `trade_date`, `open`, `high`, `low`, `close`, `volume`,
  `adjustment`, `timeframe`, `source`, and `as_of`.
- Derived indicators: the requested moving averages (`MA5`, `MA10`, `MA20`,
  `MA30`, or `MA60`) and any indicator values explicitly returned by the MVP
  endpoint. Do not calculate or label an indicator when its input window is
  incomplete.

## Screening

- Request scope: `universe_id`, `trade_date`, `timeframe`, `adjustment`,
  normalized conditions, sort order, and `limit`.
- Coverage: `total_symbols`, `scanned_symbols`, `eligible_symbols`,
  `excluded_symbols`, `excluded_reasons`, `safety_coverage_pct`, and
  `coverage_warning`.
- Candidate evidence: `code`, `name`, returned field values,
  `matched_conditions`, warnings, `source`, `data_basis`, `fetched_at`, and
  `data_quality`.

## Evidence boundary

The MVP contract does not include financial statements, valuation metrics,
industry data, capital flow, news, or announcements. A request depending on
one of those dimensions must end as `insufficient_evidence`; do not substitute
technical or price data and do not make an investment recommendation.
