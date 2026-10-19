import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { reviseResearchTask, getResearchTask } from '@/lib/company-research/version-store';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId;
    const { id } = await context.params;
    const key = request.headers.get('idempotency-key');
    const text = await request.text();
    if (text.length > 5000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    const body = z.object({
      expectedRequestRevision: z.number().int().min(1), expectedPlanRevision: z.number().int().min(0),
      changes: z.unknown(),
    }).strict().parse(JSON.parse(text));
    await reviseResearchTask(actor, id, body.expectedRequestRevision, body.expectedPlanRevision, key || '', body.changes);
    return NextResponse.json({ task: await getResearchTask(actor, id) }, { status: 202, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
