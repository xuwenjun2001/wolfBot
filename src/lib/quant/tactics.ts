import "server-only";
import { getRuntimeDegradationConfig } from "@/lib/config/degradation";

export class TacticsBackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function tacticsRequest(
  path: string,
  body?: unknown,
): Promise<unknown> {
  if (!getRuntimeDegradationConfig().components.marketApi.enabled)
    throw new TacticsBackendError("行情服务未启用。", 503);
  const base =
    process.env.QUANTPILOT_MARKET_API_URL ||
    process.env.QUANTPILOT_MARKET_API_BASE_URL ||
    "http://127.0.0.1:8000";
  const token = process.env.QUANTPILOT_MARKET_ADMIN_TOKEN?.trim();
  const response = await fetch(
    `${base.replace(/\/$/, "")}/api/v1/tactics${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-QuantPilot-Admin-Token": token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      (response.status === 409 ||
        (path.includes("/chart") && response.status === 502)) &&
      typeof payload?.detail === "string"
        ? payload.detail
        : response.status === 404
          ? "战法服务尚未加载，请更新并重启行情服务。"
          : "战法服务暂不可用，请检查数据库迁移与行情服务。";
    throw new TacticsBackendError(
      message,
      [404, 409, 422].includes(response.status) ? response.status : 503,
    );
  }
  return response.json();
}
