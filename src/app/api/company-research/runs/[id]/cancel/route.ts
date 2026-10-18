import { requireAction } from '@/lib/auth/action';
import { NextResponse } from 'next/server';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { cancelRun, getRun } from '@/lib/company-research/store';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId, { id } = await context.params;
    if (!await getRun(actor, id)) return NextResponse.json({ error: '研究任务不存在' }, { status: 404 });
    await cancelRun(actor, id); return NextResponse.json({ ok: true });
  } catch (error) { return researchError(error); }
}
