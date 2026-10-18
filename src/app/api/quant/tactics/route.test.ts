import { NextRequest, NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ requireAction: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/auth/action", () => ({ requireAction: mocks.requireAction }));
vi.mock("@/lib/auth/http", () => ({
  authErrorResponse: () =>
    NextResponse.json({ message: "forbidden" }, { status: 403 }),
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
const req = (body: unknown, headers?: Record<string, string>) =>
  new NextRequest("http://localhost/api/quant/tactics", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAction.mockResolvedValue({ actorUserId: "authenticated-user" });
  mocks.request.mockResolvedValue({ id: "run" });
});
it("requires manage permission for guide edits and preserves the server actor", async () => {
  expect(
    (
      await POST(
        req({
          action: "guide",
          content: " 次日观察\n尾盘复核 ",
          expected_version: 1,
        }),
      )
    ).status,
  ).toBe(200);
  expect(mocks.requireAction).toHaveBeenLastCalledWith(
    expect.objectContaining({ action: "quant.strategy.manage" }),
  );
  expect(mocks.request).toHaveBeenLastCalledWith("/guide", {
    actor: "authenticated-user",
    content: "次日观察\n尾盘复核",
    expected_version: 1,
  });
  for (const content of ["  ", "x".repeat(20001)]) {
    expect(
      (await POST(req({ action: "guide", content, expected_version: 1 })))
        .status,
    ).toBe(400);
  }
});
it("uses read permission and binds chart refreshes to an event", async () => {
  expect((await POST(req({action: "chart",event_id: "event:002837.SZ:2026-08-27",mode:"daily"}))).status).toBe(200);
  expect(mocks.requireAction).toHaveBeenLastCalledWith(expect.objectContaining({action:"quant.data.read"}));
  expect(mocks.request).toHaveBeenLastCalledWith("/events/event%3A002837.SZ%3A2026-08-27/chart",{mode:"daily"});
  expect((await GET(new NextRequest("http://localhost/api/quant/tactics?event=e&chart=session"))).status).toBe(200);
  expect(mocks.request).toHaveBeenLastCalledWith("/events/e/chart?mode=session");
  expect((await POST(req({action:"chart",event_id:"e",mode:"daily",symbol:"300750.SZ"}))).status).toBe(400);
});
it("requires data read before fetching the public pool", async () => {
  expect(
    (
      await GET(
        new NextRequest(
          "http://localhost/api/quant/tactics?view=history&page=2",
        ),
      )
    ).status,
  ).toBe(200);
  expect(mocks.requireAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: "quant.data.read" }),
  );
  expect(mocks.request).toHaveBeenCalledWith("?view=history&page=2");
});
it("forwards authenticated identity and queues the run without awaiting work", async () => {
  expect((await POST(req({ action: "run" }))).status).toBe(202);
  expect(mocks.requireAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: "quant.strategy.run" }),
  );
  expect(mocks.request).toHaveBeenCalledWith("/runs", {
    actor: "authenticated-user",
  });
});
it("does not allow clients to override actor or broaden stock scope", async () => {
  for (const body of [
    { action: "run", actor: "admin" },
    { action: "run", board: "growth" },
  ]) {
    expect((await POST(req(body))).status).toBe(400);
  }
  expect(mocks.request).not.toHaveBeenCalled();
});
it("blocks cross-origin public state mutation", async () => {
  expect(
    (
      await POST(
        req({ action: "run" }, { origin: "https://untrusted.invalid" }),
      )
    ).status,
  ).toBe(403);
  expect(mocks.request).not.toHaveBeenCalled();
});
it("does not call backend when permission is denied", async () => {
  mocks.requireAction.mockRejectedValue(new Error("forbidden"));
  expect((await POST(req({ action: "run" }))).status).toBe(403);
  expect(mocks.request).not.toHaveBeenCalled();
});
it("requires manage permission to update shared parameters and cancel", async () => {
  const parameters = {
    body_pct: 3,
    volume_ratio: 1.5,
    contraction_ratio: 0.8,
    distance_min_pct: -3,
    distance_max_pct: 1,
  };
  expect(
    (await POST(req({ action: "configure", parameters, expected_version: 1 })))
      .status,
  ).toBe(200);
  expect(mocks.requireAction).toHaveBeenLastCalledWith(
    expect.objectContaining({ action: "quant.strategy.manage" }),
  );
  expect(mocks.request).toHaveBeenLastCalledWith("/config", {
    parameters,
    expected_version: 1,
    actor: "authenticated-user",
  });
  expect(
    (
      await POST(
        req({
          action: "cancel",
          run_id: "a73f2d61-3d41-4e46-a606-077b714f3943",
        }),
      )
    ).status,
  ).toBe(200);
  expect(mocks.requireAction).toHaveBeenLastCalledWith(
    expect.objectContaining({ action: "quant.strategy.manage" }),
  );
});

it("forwards the explicit discussion variant and rejects unsupported rule versions", async () => {
  const parameters = {
    rule_set: "discussion_v2", change_pct: 5, body_pct: 3, volume_ratio: 1.5,
    contraction_ratio: 0.8, distance_min_pct: -1, distance_max_pct: 1,
  };
  expect((await POST(req({ action: "configure", parameters, expected_version: 2 }))).status).toBe(200);
  expect(mocks.request).toHaveBeenLastCalledWith("/config", {
    parameters, expected_version: 2, actor: "authenticated-user",
  });
  expect((await POST(req({ action: "configure", parameters: { ...parameters, rule_set: "unknown" }, expected_version: 2 }))).status).toBe(400);
});
it("rejects invalid parameter ranges and invalid query pagination", async () => {
  expect(
    (
      await POST(
        req({
          action: "configure",
          expected_version: 1,
          parameters: { volume_ratio: 0 },
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await GET(new NextRequest("http://localhost/api/quant/tactics?page=-1")))
      .status,
  ).toBe(400);
});
