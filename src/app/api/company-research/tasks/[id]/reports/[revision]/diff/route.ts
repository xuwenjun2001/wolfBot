import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { researchError } from '@/lib/company-research/http';
import { getResearchReportDiff } from '@/lib/company-research/report-update-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; revision: string }> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId;
    const { id, revision } = await context.params, target = z.coerce.number().int().min(1).parse(revision);
    const diff = target === 1 ? null : await getResearchReportDiff(actor, id, target);
    return NextResponse.json({ diff }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
