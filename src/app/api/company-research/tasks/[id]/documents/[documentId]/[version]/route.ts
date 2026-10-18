import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { researchError } from '@/lib/company-research/http';
import { getResearchDocument, readResearchDocumentArtifact } from '@/lib/company-research/document-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string; documentId: string; version: string }> }) {
  try {
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId, p = await context.params;
    const kind = z.enum(['original','parsed']).nullable().parse(new URL(request.url).searchParams.get('content'));
    if (!kind) {
      const document = await getResearchDocument(actor, p.id, p.documentId, Number(p.version));
      return NextResponse.json(document ? { document } : { error: '研究资料不存在' }, { status: document ? 200 : 404, headers: { 'Cache-Control': 'private, no-store' } });
    }
    const artifact = await readResearchDocumentArtifact(actor, p.id, p.documentId, Number(p.version), kind);
    return new Response(new Uint8Array(artifact.bytes), { headers: { 'Content-Type': kind === 'original' ? artifact.document.mediaType : 'application/json',
      'Content-Disposition': `attachment; filename="research-${kind}.${kind === 'parsed' ? 'json' : artifact.document.mediaType === 'application/pdf' ? 'pdf' : 'html'}"`,
      'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } });
  } catch (error) { return researchError(error); }
}
