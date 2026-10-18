import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { createResearchTask } from '@/lib/company-research/version-store';
import { researchTaskSpecSchema } from '@/lib/company-research/task-contracts';
import { resolveCompanies } from '@/lib/company-research/connectors';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId;
    const body = await request.text();
    if (Buffer.byteLength(body) > 16000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    const spec = researchTaskSpecSchema.parse(JSON.parse(body));
    const key = z.string().min(8).max(100).parse(request.headers.get('idempotency-key'));
    const confirmed = (await resolveCompanies(spec.company.symbol, request.signal)).find(c => c.symbol.split('.')[0] === spec.company.symbol.split('.')[0]);
    if (!confirmed || confirmed.name !== spec.company.name || spec.company.issuerId) return NextResponse.json({ error: '公司身份未通过证券解析确认' }, { status: 400 });
    // S05 persists a draft. Execution is connected in S11, never to the legacy worker.
    return NextResponse.json({ task: await createResearchTask(actor, spec, key) }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
