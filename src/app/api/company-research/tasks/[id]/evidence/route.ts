import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { evidenceReadSchema, evidenceSearchSchema, researchEvidenceReader } from '@/lib/company-research/evidence-retrieval';
export const runtime = 'nodejs';
const inputSchema = z.discriminatedUnion('operation', [z.object({ operation: z.literal('search'), input: evidenceSearchSchema }).strict(), z.object({ operation: z.literal('read'), input: evidenceReadSchema }).strict()]);
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId, body = await request.text();
    if (Buffer.byteLength(body) > 8000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    const input = inputSchema.parse(JSON.parse(body)), reader = researchEvidenceReader(actor, (await context.params).id);
    return NextResponse.json(await reader[input.operation](input.input), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
