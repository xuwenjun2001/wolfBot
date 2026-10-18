import type { Metadata } from "next";
import { headers } from "next/headers";
import { requireAction } from "@/lib/auth/action";
import { PageHeader } from "@/components/layout/PageHeader";
import TacticsPlatformClient from "./TacticsPlatformClient";

export const metadata: Metadata = {
  title: "战法平台 · wolfbot",
  description: "主板55线突破回踩观察池与收盘筛选。",
};
export const dynamic = "force-dynamic";
export default async function TacticsPlatformPage() {
  const h = await headers();
  try {
    await requireAction({ headers: h, action: "quant.data.read" });
  } catch {
    return (
      <>
        <PageHeader title="战法平台" />
        <main className="p-8" role="alert">
          请登录并确认账号拥有行情读取权限。
        </main>
      </>
    );
  }
  const [canRun, canManage] = await Promise.all([
    requireAction({ headers: h, action: "quant.strategy.run" }).then(
      () => true,
      () => false,
    ),
    requireAction({ headers: h, action: "quant.strategy.manage" }).then(
      () => true,
      () => false,
    ),
  ]);
  return <TacticsPlatformClient canRun={canRun} canManage={canManage} />;
}
