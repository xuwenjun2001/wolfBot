import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { researchError } from '@/lib/company-research/http';
import { getResearchTask } from '@/lib/company-research/version-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId;
    const task = await getResearchTask(actor, (await context.params).id);
    return NextResponse.json(task ? { task } : { error: '研究任务不存在' }, { status: task ? 200 : 404, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
