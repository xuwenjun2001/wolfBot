import { NextRequest, NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/auth/action", () => ({ requireAction: mocks.auth }));
vi.mock("@/lib/auth/http", () => ({
  authErrorResponse: () => NextResponse.json({}, { status: 403 }),
}));
vi.mock("@/lib/config/auth", () => ({
  getProjectAuthConfig: () => ({ enabled: true }),
}));
vi.mock("@/lib/quant/tactics", () => ({
  tacticsRequest: mocks.request,
  TacticsBackendError: class extends Error {
    status = 503;
  },
}));
import { GET, POST } from "./route";
const request = (body: unknown, origin = "http://localhost") =>
  new NextRequest("http://localhost/api/quant/tactics/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ actorUserId: "user" });
  mocks.request.mockResolvedValue({ id: "job" });
});
it("enforces read access before exposing prompts or knowledge", async () => {
  mocks.auth.mockRejectedValue(new Error("denied"));
  expect(
    (await GET(new NextRequest("http://localhost/api/quant/tactics/reviews")))
      .status,
  ).toBe(403);
  expect(mocks.request).not.toHaveBeenCalled();
});
it("uses management permission and server identity for versioned prompt writes", async () => {
  expect(
    (
      await POST(
        request({
          action: "prompt",
          content: "分析失败样本",
          expected_version: 2,
        }),
      )
    ).status,
  ).toBe(202);
  expect(mocks.auth).toHaveBeenCalledWith(
    expect.objectContaining({ action: "quant.strategy.manage" }),
  );
  expect(mocks.request).toHaveBeenCalledWith("/reviews", {
    action: "prompt",
    content: "分析失败样本",
    expected_version: 2,
    actor: "user",
  });
});
it("rejects credentials, arbitrary settings, fake actors and cross-site writes", async () => {
  for (const extra of [
    { api_key: "secret" },
    { actor: "admin" },
    { model: "other" },
  ])
    expect((await POST(request({ action: "run", ...extra }))).status).toBe(400);
  expect(
    (await POST(request({ action: "run" }, "http://attacker.example"))).status,
  ).toBe(403);
  expect(mocks.request).not.toHaveBeenCalled();
});
it("uses run permission for generation and returns asynchronously", async () => {
  expect(
    (await POST(request({ action: "regenerate", day: "2026-09-09" }))).status,
  ).toBe(202);
  expect(mocks.auth).toHaveBeenCalledWith(
    expect.objectContaining({ action: "quant.strategy.run" }),
  );
});
it("validates schedule bounds and accepts a complete versioned save", async () => {
  expect(
    (
      await POST(
        request({
          action: "schedule",
          enabled: true,
          start_time: "09:30",
          expected_version: 1,
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        request({
          action: "schedule",
          enabled: true,
          start_time: "18:00",
          expected_version: 1,
        }),
      )
    ).status,
  ).toBe(202);
});
