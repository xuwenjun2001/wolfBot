import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { researchError } from '@/lib/company-research/http';
import { readResearchSource } from '@/lib/company-research/source-reader';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId;
    const q = new URL(request.url).searchParams;
    const source = await readResearchSource(actor, (await context.params).id, { reportRevision: Number(q.get('reportRevision')), citationIndex: Number(q.get('citationIndex')), ...(q.has('claimId') ? { claimId: q.get('claimId') } : { factId: q.get('factId') }) });
    return NextResponse.json({ source }, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return researchError(error); }
}
