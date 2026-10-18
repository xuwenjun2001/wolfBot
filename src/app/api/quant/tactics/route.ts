import { NextRequest, NextResponse } from "next/server";
import { requireAction } from "@/lib/auth/action";
import { authErrorResponse } from "@/lib/auth/http";
import { getProjectAuthConfig } from "@/lib/config/auth";
import { assertPrivilegedMutation } from "@/lib/server/privileged-request";
import { tacticsRequest, TacticsBackendError } from "@/lib/quant/tactics";
import { tacticMutationSchema } from "@/lib/quant/tactics-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown) {
  return NextResponse.json(
    {
      message:
        error instanceof TacticsBackendError
          ? error.message
          : "战法服务连接失败，请稍后重试。",
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
  const event = query.get("event");
  const chart = query.get("chart");
  const view = query.get("view") || "active";
  const page = Number(query.get("page") || 1);
  if (
    !["active", "today", "history"].includes(view) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    (event && event.length > 160) ||
    (chart && (!event || !["daily", "session"].includes(chart)))
  ) {
    return NextResponse.json({ message: "无效的查询参数。" }, { status: 400 });
  }
  try {
    const data = await tacticsRequest(
      event
        ? `/events/${encodeURIComponent(event)}${chart ? `/chart?mode=${chart}` : ""}`
        : `?view=${view}&page=${page}`,
    );
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = tacticMutationSchema.safeParse(await request.json());
  } catch {
    return NextResponse.json({ message: "请求格式无效。" }, { status: 400 });
  }
  if (!parsed.success)
    return NextResponse.json(
      { message: "参数无效，请检查数值范围。" },
      { status: 400 },
    );
  const body = parsed.data;
  let actor: string;
  try {
    // Browsers may mutate shared state only from the current application origin.
    const origin = request.headers.get("origin");
    const host =
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      request.headers.get("host") ||
      request.nextUrl.host;
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && new URL(origin).host !== host)
    ) {
      return NextResponse.json({ message: "拒绝跨站操作。" }, { status: 403 });
    }
    const context = await requireAction({
      headers: request.headers,
      action:
        body.action === "chart"
          ? "quant.data.read"
          : body.action !== "run"
            ? "quant.strategy.manage"
            : "quant.strategy.run",
    });
    actor = context.actorUserId;
    if (!getProjectAuthConfig().enabled) assertPrivilegedMutation(request);
  } catch (error) {
    return authErrorResponse(error);
  }
  try {
    const path =
      body.action === "chart"
        ? `/events/${encodeURIComponent(body.event_id)}/chart`
        : body.action === "run"
          ? "/runs"
          : body.action === "configure"
            ? "/config"
            : body.action === "guide"
              ? "/guide"
              : `/runs/${body.run_id}/cancel`;
    const data = await tacticsRequest(
      path,
      body.action === "chart"
        ? { mode: body.mode }
        : body.action === "configure"
          ? {
              actor,
              parameters: body.parameters,
              expected_version: body.expected_version,
            }
          : body.action === "guide"
            ? {
                actor,
                content: body.content,
                expected_version: body.expected_version,
              }
            : { actor },
    );
    return NextResponse.json(
      { data },
      { status: body.action === "run" ? 202 : 200 },
    );
  } catch (error) {
    return failure(error);
  }
}
