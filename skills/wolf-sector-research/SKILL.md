---
name: wolf-sector-research
description: Analyze board (sector, concept, industry, region) trend, breadth, and constituent leadership from the governed board contract, with explicit date, source, and coverage limits.
metadata:
  version: 0.1.0
  scope: board-trend-analysis
  applicable_scope: sectors, concepts, industries, themes, regions, board quotes, market breadth, and constituent leadership
---

# Wolf Sector Research

Version: 0.1.0.

Use this skill for a question about how a **board** behaved -- a sector, concept,
industry, theme, track, or region ("液冷板块今天怎么样", "半导体行业最近强不强").
For a single stock, index, or ETF, use the single-instrument market contract
instead; this skill does not replace it. The field contract is in
[references/board-fields.md](references/board-fields.md).

The board tools are part of the base market contract and are available whether
or not this skill is loaded. Loading it adds method and wording, not access.

## Tool workflow

1. Call `get_market_session_context` first whenever the question uses a relative
   date ("today", "yesterday", "recently"). Take `effective_trade_date` from it
   and write that absolute date into the answer. When `fallback_reason` is set,
   say plainly that the requested day had no usable data yet.
2. Route the object correctly. A board name goes to `resolve_board`, never to
   `resolve_symbol`. Keep the returned opaque `board_id`; it is the only board
   identifier the other tools accept.
3. Read `get_board_snapshot` and `get_board_breadth` before anything else. These
   two carry the change percent, the advance/decline counts, and the coverage
   the counts were computed from.
4. Call `get_board_members` only when the answer still needs named leaders or
   laggards.
5. Read only the paths listed in `load_skill.available_references`.

## Reading the result

- **Direction** comes from the board change percent, not from a few
  constituents.
- **Participation** comes from breadth. A large gain with few advancers is
  narrow leadership, not a broad move; near-equal advancers and decliners is
  divergence, not strength.
- **Trustworthiness** comes from `coverage_pct`. Below the backend threshold the
  payload sets `insufficient_coverage`, and the breadth numbers stop describing
  the board -- report the coverage and downgrade the claim.
- `breadth_basis` says whether the counts were published by the provider or
  computed from constituent quotes at the same observation point. Say which.

## Errors

Each backend error code means a different next step. `BOARD_NOT_FOUND` and
`AMBIGUOUS_BOARD` are routing problems: pick a classification from the returned
candidates, or ask which one the user means. `UPSTREAM_UNAVAILABLE`,
`UPSTREAM_RATE_LIMITED`, and `UPSTREAM_INVALID_RESPONSE` mean the source failed
and never mean the board does not exist -- say the source was unreachable.
`NO_SESSION_DATA` means use the latest completed trading day.
`INSUFFICIENT_COVERAGE` means report the coverage and weaken the conclusion.
Make at most one compliant retry per code; never guess a new argument.

## Evidence and limits

A `completed` board answer needs all four of: the resolved board identity and
type, the market phase with the effective trade date, the board change, and
advance/decline counts with their coverage. Leaders and laggards are
recommended. Capital flow and news are enhancements that can never substitute
for the board quote and breadth; if the quote or breadth is missing, return
`insufficient_evidence` and name what was unavailable.

Always state that constituents follow one provider's definition and that other
platforms classify the same theme differently. State that one session's
performance does not predict the next. Do not invent constituents, quotes,
breadth, coverage, capital flow, or news, and never turn a board move into a
buy, sell, or hold recommendation.
