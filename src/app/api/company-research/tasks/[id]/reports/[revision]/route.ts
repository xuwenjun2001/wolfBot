import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { researchError } from '@/lib/company-research/http';
import { financialChanges } from '@/lib/company-research/report-assembly';
import { getResearchReportSnapshot } from '@/lib/company-research/report-update-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; revision: string }> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId, params = await context.params;
    const snapshot = await getResearchReportSnapshot(actor, params.id, Number(params.revision));
    return NextResponse.json(snapshot ? { ...snapshot, changes: financialChanges({ facts: [...snapshot.report.facts, ...(snapshot.report.supportingFacts || [])], periodIds: snapshot.report.periodIds }) } : { error: '研究报告不存在' },
      { status: snapshot ? 200 : 404, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
