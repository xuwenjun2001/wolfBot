import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { researchError } from '@/lib/company-research/http';
import { getResearchReportRevision } from '@/lib/company-research/version-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; revision: string }> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId, params = await context.params;
    const report = await getResearchReportRevision(actor, params.id, Number(params.revision));
    return NextResponse.json(report ? { report } : { error: '研究报告不存在' }, { status: report ? 200 : 404, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
