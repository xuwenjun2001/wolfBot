import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { getResearchTask } from '@/lib/company-research/version-store';
import { queueResearchReportUpdate } from '@/lib/company-research/report-update-store';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId;
    const { id } = await context.params, key = request.headers.get('idempotency-key'), text = await request.text();
    if (text.length > 2000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    const body = z.object({ expectedRequestRevision: z.number().int().min(1), expectedPlanRevision: z.number().int().min(1),
      expectedReportRevision: z.number().int().min(1), asOf: z.string().min(1).max(50) }).strict().parse(JSON.parse(text));
    const update = await queueResearchReportUpdate(actor, id, key || '', body);
    if (!update.queued) return NextResponse.json({ update }, { headers: { 'Cache-Control': 'private, no-store' } });
    return NextResponse.json({ update, task: await getResearchTask(actor, id) }, { status: update.idempotent ? 200 : 202, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
