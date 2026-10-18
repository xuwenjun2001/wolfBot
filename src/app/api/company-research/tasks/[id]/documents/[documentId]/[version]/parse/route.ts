import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { parseResearchDocument } from '@/lib/company-research/parse-service';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string; documentId: string; version: string }> }) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId, p = await context.params;
    const body = await request.text();
    if (Buffer.byteLength(body) > 2000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    return NextResponse.json(await parseResearchDocument(actor, p.id, p.documentId, Number(p.version), body ? JSON.parse(body) : {}, AbortSignal.any([request.signal, AbortSignal.timeout(240000)])), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
