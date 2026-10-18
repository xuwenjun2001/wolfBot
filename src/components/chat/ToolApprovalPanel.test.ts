import { describe, expect, it } from "vitest";

import {
  isCurrentApprovalLoad,
  parsePendingToolApprovalEnvelope,
  parsePendingToolApprovals,
  type ApprovalLoadRequest,
} from "./ToolApprovalPanel";

describe("ToolApprovalPanel contract parser", () => {
  it("accepts pending mutating-tool approvals only", () => {
    expect(
      parsePendingToolApprovals([
        {
          id: "approval_123456789012",
          runId: "run_1",
          toolName: "publish_report",
          effect: "external_write",
          publicInput: { reportId: "report_1" },
          reason: "将报告发布到外部系统",
          allowedDecisions: ["approve", "edit", "reject"],
          status: "pending",
          requestedAt: "2026-07-24T00:00:00.000Z",
          expiresAt: "2026-07-24T00:10:00.000Z",
        },
      ]),
    ).toHaveLength(1);
  });

  it("rejects resolved, read-only, or malformed approval records", () => {
    expect(
      parsePendingToolApprovals([
        {
          id: "approval_123456789012",
          runId: "run_1",
          toolName: "read_report",
          effect: "read",
          publicInput: {},
          reason: "read",
          allowedDecisions: ["approve", "reject"],
          status: "pending",
          requestedAt: "2026-07-24T00:00:00.000Z",
          expiresAt: "2026-07-24T00:10:00.000Z",
        },
        {
          id: "approval_123456789013",
          runId: "run_1",
          toolName: "publish_report",
          effect: "external_write",
          publicInput: {},
          reason: "publish",
          allowedDecisions: ["approve", "reject"],
          status: "approved",
          requestedAt: "2026-07-24T00:00:00.000Z",
          expiresAt: "2026-07-24T00:10:00.000Z",
        },
      ]),
    ).toEqual([]);
  });

  it("distinguishes a valid empty envelope from malformed responses", () => {
    expect(
      parsePendingToolApprovalEnvelope({ success: true, data: [] }),
    ).toEqual([]);
    expect(() => parsePendingToolApprovalEnvelope({ data: [] })).toThrow(
      "无法读取确认状态",
    );
    expect(() =>
      parsePendingToolApprovalEnvelope({ success: false, data: [] }),
    ).toThrow("无法读取确认状态");
    expect(() =>
      parsePendingToolApprovalEnvelope({ success: true, data: null }),
    ).toThrow("无法读取确认状态");
    expect(() => parsePendingToolApprovalEnvelope("<!doctype html>")).toThrow(
      "无法读取确认状态",
    );
  });

  it("keeps a valid pending envelope distinct from an empty result", () => {
    const approval = {
      id: "approval_123456789012",
      runId: "run_1",
      toolName: "publish_report",
      effect: "external_write",
      publicInput: { reportId: "report_1" },
      reason: "将报告发布到外部系统",
      allowedDecisions: ["approve", "reject"],
      status: "pending",
      requestedAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-24T00:10:00.000Z",
    };

    expect(
      parsePendingToolApprovalEnvelope({ success: true, data: [approval] }),
    ).toHaveLength(1);
    expect(
      parsePendingToolApprovalEnvelope({ success: true, data: [] }),
    ).toHaveLength(0);
    expect(() =>
      parsePendingToolApprovalEnvelope({ success: true, data: [{}] }),
    ).toThrow("无法读取确认状态");
    expect(() =>
      parsePendingToolApprovalEnvelope({ success: true, data: [approval, {}] }),
    ).toThrow("无法读取确认状态");
  });

  it("accepts only the latest load for the active project lifecycle", () => {
    const latest: ApprovalLoadRequest = {
      projectId: "project-b",
      lifecycle: 4,
      requestId: 8,
    };

    expect(isCurrentApprovalLoad(latest, latest)).toBe(true);
    expect(
      isCurrentApprovalLoad(latest, {
        ...latest,
        requestId: latest.requestId - 1,
      }),
    ).toBe(false);
    expect(
      isCurrentApprovalLoad(latest, {
        ...latest,
        lifecycle: latest.lifecycle - 1,
      }),
    ).toBe(false);
    expect(
      isCurrentApprovalLoad(latest, {
        ...latest,
        projectId: "project-a",
      }),
    ).toBe(false);
    expect(isCurrentApprovalLoad(null, latest)).toBe(false);
  });
});
