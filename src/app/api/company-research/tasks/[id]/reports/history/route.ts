import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { researchError } from '@/lib/company-research/http';
import { listResearchReportHistory } from '@/lib/company-research/report-update-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId;
    const reports = await listResearchReportHistory(actor, (await context.params).id);
    return NextResponse.json({ reports }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
