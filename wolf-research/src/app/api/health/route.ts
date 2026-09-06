import { NextResponse } from 'next/server';

import { runStartupPreflight } from '@/lib/startup/preflight';

export const dynamic = 'force-dynamic';

export async function GET() {
  const report = runStartupPreflight();
  return NextResponse.json(report, { status: report.ok ? 200 : 503 });
}
