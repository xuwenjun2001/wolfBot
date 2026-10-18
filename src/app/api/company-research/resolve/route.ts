import { requireAction } from '@/lib/auth/action';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { researchError } from '@/lib/company-research/http';
import { resolveCompanies } from '@/lib/company-research/connectors';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    (await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId;
    const query = z.string().min(1).max(100).parse(new URL(request.url).searchParams.get('query'));
    return NextResponse.json({ companies: await resolveCompanies(query, request.signal) });
  } catch (error) { return researchError(error); }
}
