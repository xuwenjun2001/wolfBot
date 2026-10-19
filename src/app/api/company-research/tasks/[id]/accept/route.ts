import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { acceptResearchReport } from '@/lib/company-research/report-acceptance';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{id: string}> }) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId;
    const body = await request.text(); if (body.length > 2000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    return NextResponse.json(await acceptResearchReport(actor, (await context.params).id, JSON.parse(body)), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
