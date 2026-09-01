# Board field contract

Field names and meanings returned by the governed board tools. Values that are
absent are `null`; a missing value is never replaced with a default.

## `get_market_session_context`

| Field | Meaning |
| --- | --- |
| `timezone` | Always `Asia/Shanghai`. |
| `observed_at` | The Beijing-time observation point, with offset. |
| `calendar_date` | The Beijing calendar date at `observed_at`. |
| `phase` | `pre_open`, `opening_auction`, `morning_session`, `lunch_break`, `afternoon_session`, `post_close`, or `non_trading_day`. |
| `is_trading_day` | Whether `calendar_date` is a trading day. |
| `requested_date` | The date the question is about, defaulting to `calendar_date`. |
| `effective_trade_date` | The date the market data actually describes. Use this in the answer. |
| `latest_completed_trade_date` | The most recent trading day whose session has finished. |
| `next_trade_date` | The next trading session that has not finished yet: today before the close, otherwise the following trading day. |
| `fallback_reason` | Why `effective_trade_date` differs from `requested_date`, or `null`. |
| `intraday` | `true` while the session is open and values still change. |
| `calendar_basis` | `observed_trade_dates` when derived from stored history, `weekday_only` when only the weekday rule was available. |

`calendar_basis: weekday_only` means exchange holidays were **not** verified.
Say so rather than presenting the date as calendar-confirmed.

## `resolve_board`

| Field | Meaning |
| --- | --- |
| `status` | `resolved` when exactly one board matched. |
| `board_id` | The opaque id every other board tool requires. Never a provider board code. |
| `name` | The provider's own board name. |
| `board_type` | `industry`, `concept`, or `region`. `theme` is accepted as input and resolves to a concept board. |
| `provider` | The data source that defines this board. |
| `constituent_basis` | How membership is defined, e.g. `provider-defined`. |
| `match_basis` | `exact_normalized_name` or `normalized_name_contains`. |
| `confidence` | Lower for a partial name match; confirm the basis before relying on it. |
| `candidates` | Every board considered. Populated on an ambiguous result. |

## `get_board_snapshot` and `get_board_breadth`

Both read the same observation; the breadth route adds `view: "breadth"`.

| Field | Meaning |
| --- | --- |
| `change_pct` | Board change for `trade_date`, in percent. |
| `trade_date` | The session the numbers describe. |
| `snapshot_at` | When the observation was taken. |
| `market_phase` | The phase at `snapshot_at`. |
| `breadth.advancers` / `decliners` / `unchanged` | Constituent counts. |
| `breadth.covered_members` | Constituents that actually published a quote. |
| `breadth.total_members` | Constituents in the membership used. |
| `breadth.coverage_pct` | `covered_members / total_members`, in percent. |
| `breadth.breadth_basis` | `provider` when published upstream, `computed_from_members` when derived from constituent quotes at the same observation point. |
| `breadth.algorithm_version` | The derivation used, when computed. |
| `coverage.sufficient` | `false` once coverage drops below the backend threshold. |
| `insufficient_coverage` | `true` mirror of `coverage.sufficient: false`. |
| `market_context` | The full session contract described above. |
| `warnings` | Staleness, coverage, and intraday notices. Never drop these. |
| `limitations` | Constituent-basis and next-session caveats to carry into the answer. |

## `get_board_members`

| Field | Meaning |
| --- | --- |
| `members` | Constituents in the requested `sort` and `direction`. |
| `leaders` | Best performers by change, regardless of the requested sort. |
| `laggards` | Worst performers by change, regardless of the requested sort. |
| `member_count` | Constituents in the membership used. |
| `membership_as_of` | The validity date of the membership these rows came from. |
| `sort` | One of `change_pct`, `amount`, `turnover`, `close`. |
| `direction` | `asc` or `desc`. |

Constituent rows carry `symbol`, `code`, `name`, `change_pct`, `close`,
`amount`, `turnover`, and `as_of`.

## Not available

This contract has no capital flow, news, announcement, financial-statement,
valuation, index-weight, or historical board-membership-change data. If the
question needs one of those, say it is unavailable rather than substituting a
proxy.
