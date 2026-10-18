import { describe, expect, it } from "vitest";

import { canUsePrefetchedSelectionDashboard } from "./chat-act-support";

describe("prefetched selection dashboard eligibility", () => {
  const runPlan = {
    visualization: { templateId: "stock-selection" },
    symbols: [],
  } as any;

  it("uses a deterministic empty dashboard when the screener found no safe candidates", () => {
    expect(
      canUsePrefetchedSelectionDashboard({
        instruction: "液冷板块有哪些值得关注的股票",
        runPlan,
        prefetchSkipped: false,
        prefetchStatus: "no_candidates",
      }),
    ).toBe(true);
  });

  it("does not infer an empty dashboard from a normal completed prefetch", () => {
    expect(
      canUsePrefetchedSelectionDashboard({
        instruction: "液冷板块有哪些值得关注的股票",
        runPlan,
        prefetchSkipped: false,
        prefetchStatus: "completed",
      }),
    ).toBe(false);
  });

  it("also skips Agent generation for an empty result under another analysis template", () => {
    expect(
      canUsePrefetchedSelectionDashboard({
        instruction: "液冷板块有哪些值得关注的股票",
        runPlan: {
          visualization: { templateId: "fundamental-research" },
          symbols: [],
        } as any,
        prefetchSkipped: false,
        prefetchStatus: "no_candidates",
      }),
    ).toBe(true);
  });
});
