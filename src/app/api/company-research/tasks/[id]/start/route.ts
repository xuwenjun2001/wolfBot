import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { queueFinancialResearch } from '@/lib/company-research/execution-store';
import { getResearchTask } from '@/lib/company-research/version-store';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{id: string}> }) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId, { id } = await context.params;
    const text = await request.text(); if (text.length > 1000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    const body = z.object({ expectedPlanRevision: z.number().int().min(0) }).strict().parse(JSON.parse(text));
    await queueFinancialResearch(actor, id, body.expectedPlanRevision);
    return NextResponse.json({ task: await getResearchTask(actor, id) }, { status: 202, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
