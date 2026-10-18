import { requireAction } from '@/lib/auth/action';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertResearchMutation, researchError } from '@/lib/company-research/http';
import { createRun, listRuns } from '@/lib/company-research/store';
import { resolveCompanies } from '@/lib/company-research/connectors';
import { researchConfig } from '@/lib/company-research/config';
import { aShareSymbolPattern } from '@/lib/company-research/contracts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return NextResponse.json({ runs: await listRuns((await requireAction({ headers: request.headers, action: 'research.report.read' })).actorUserId) }, { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return researchError(error); }
}
export async function POST(request: Request) {
  try {
    assertResearchMutation(request);
    const actor = (await requireAction({ headers: request.headers, action: 'research.report.run' })).actorUserId;
    const body = await request.text();
    if (body.length > 2000) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    const { symbol } = z.object({ symbol: z.string().regex(aShareSymbolPattern) }).strict().parse(JSON.parse(body));
    const key = z.string().min(8).max(100).parse(request.headers.get('idempotency-key'));
    const config = researchConfig();
    if (!config.apiKey || !config.searchApiKey) return NextResponse.json({ error: '服务端尚未配置研究模型或 DeepSeek 搜索密钥' }, { status: 503 });
    const company = (await resolveCompanies(symbol, request.signal)).find(c => c.symbol === symbol);
    if (!company) return NextResponse.json({ error: '未找到所选 A 股公司' }, { status: 400 });
    return NextResponse.json({ run: await createRun(actor, company, key) }, { status: 202 });
  } catch (error) { return researchError(error); }
}
