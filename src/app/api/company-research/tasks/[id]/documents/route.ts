import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { discoverTaskFilings, importTaskFiling, listResearchDocuments } from '@/lib/company-research/acquisition-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId, { id } = await context.params;
    const url = new URL(request.url);
    const result = url.searchParams.get('discover') === '1' ? await discoverTaskFilings(actor, id, z.coerce.number().int().min(1).max(100).parse(url.searchParams.get('page') || 1), request.signal) : { documents: await listResearchDocuments(actor, id) };
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId;
    const body = await request.text();
    if (Buffer.byteLength(body) > 8000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    const result = await importTaskFiling(actor, (await context.params).id, JSON.parse(body), request.signal);
    return NextResponse.json(result, { status: result.reused ? 200 : 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
