import { NextRequest, NextResponse } from "next/server";
import { requireAction } from "@/lib/auth/action";
import { authErrorResponse } from "@/lib/auth/http";
import { getProjectAuthConfig } from "@/lib/config/auth";
import { assertPrivilegedMutation } from "@/lib/server/privileged-request";
import { tacticsRequest, TacticsBackendError } from "@/lib/quant/tactics";
import { reviewMutationSchema } from "@/lib/quant/tactic-review-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown) {
  return NextResponse.json(
    {
      message:
        error instanceof TacticsBackendError
          ? error.message
          : "收盘复盘服务暂不可用。",
    },
    { status: error instanceof TacticsBackendError ? error.status : 503 },
  );
}
export async function GET(request: NextRequest) {
  try {
    await requireAction({
      headers: request.headers,
      action: "quant.data.read",
    });
  } catch (error) {
    return authErrorResponse(error);
  }
  const query = request.nextUrl.searchParams;
  const allowed = new Set([
    "day",
    "start",
    "end",
    "origin",
    "version",
    "search",
    "report",
  ]);
  if (
    [...query].some(([key, value]) => !allowed.has(key) || value.length > 200)
  )
    return NextResponse.json({ message: "无效查询。" }, { status: 400 });
  try {
    return NextResponse.json(
      { data: await tacticsRequest(`/reviews?${query}`) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  const parsed = reviewMutationSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return NextResponse.json({ message: "操作参数无效。" }, { status: 400 });
  const body = parsed.data;
  let actor: string;
  try {
    const origin = request.headers.get("origin");
    const host =
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      request.headers.get("host") ||
      request.nextUrl.host;
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && new URL(origin).host !== host)
    )
      return NextResponse.json({ message: "拒绝跨站操作。" }, { status: 403 });
    const context = await requireAction({
      headers: request.headers,
      action: ["run", "regenerate"].includes(body.action)
        ? "quant.strategy.run"
        : "quant.strategy.manage",
    });
    actor = context.actorUserId;
    if (!getProjectAuthConfig().enabled) assertPrivilegedMutation(request);
  } catch (error) {
    return authErrorResponse(error);
  }
  try {
    return NextResponse.json(
      { data: await tacticsRequest("/reviews", { ...body, actor }) },
      { status: 202 },
    );
  } catch (error) {
    return failure(error);
  }
}
