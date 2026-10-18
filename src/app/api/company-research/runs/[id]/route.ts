import { requireAction } from '@/lib/auth/action';
import { NextResponse } from 'next/server';
import { researchError } from '@/lib/company-research/http';
import { getRun, publicRun } from '@/lib/company-research/store';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const run = await getRun((await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId, (await context.params).id);
    return run ? NextResponse.json({ run: publicRun(run) }, { headers: { 'Cache-Control': 'private, no-store' } }) : NextResponse.json({ error: '研究任务不存在' }, { status: 404 });
  } catch (error) { return researchError(error); }
}
