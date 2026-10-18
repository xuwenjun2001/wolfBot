import { readFile } from 'node:fs/promises';

/** Closed fixture transport. Only the configured model gateway reaches the network. */
export async function installFixtureTransport(testCase: any, documents: any[], onGateway: (url: string, init: RequestInit | undefined, response: Response) => void) {
  const original = globalThis.fetch;
  const gateway = new URL(process.env.COMPANY_RESEARCH_BASE_URL || 'https://sub2api.380001.xyz/v1');
  const content = new Map<string, string>();
  for (const doc of documents) content.set(doc.url, await readFile(doc.path.replace(/\.pdf$/i, '.txt'), 'utf8'));
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (v: unknown) => Response.json(v);
    if (url.origin === gateway.origin && url.pathname.startsWith(gateway.pathname.replace(/\/$/, '') + '/')) {
      const response = await original(input, init); onGateway(url.origin + url.pathname, init, response); return response;
    }
    if (url.origin === 'http://research-fixture.invalid') {
      if (url.pathname.includes('/financials/')) return json({ reports: documents.map(doc => ({
        report_date: doc.period.end, notice_date: doc.disclosedOn, data_type: '年度报告',
        revenue: null, revenue_yoy: null, operating_cash_flow_per_share: null,
        parent_net_profit: testCase.reference.facts.find((f: any) => f.metric === 'parent_net_profit' && f.period.end === doc.period.end)?.normalizedYuan,
        net_profit_yoy: doc.period.end.startsWith('2024') ? testCase.reference.changes.find((c: any) => c.metric === 'parent_net_profit')?.percentage : null,
      })) });
      if (url.pathname.includes('/announcements/')) return json({ announcements: documents.map(doc => ({
        title: doc.title, symbol: doc.symbol, pdf_url: doc.url, url: doc.url, notice_date: doc.disclosedOn,
      })), has_more: false });
      if (url.pathname.includes('/symbols/resolve')) return json({ results: [{ ...testCase.company, asset_type: 'stock' }] });
    }
    if (url.origin === 'https://api.deepseek.com' && url.pathname === '/v1/tools/fetch') {
      const target = JSON.parse(String(init?.body)).url;
      const text = content.get(target);
      return text ? json({ title: documents.find(d => d.url === target)!.title, content: text }) : json({ error: 'not in fixed corpus' });
    }
    if (url.origin === 'https://api.deepseek.com' && url.pathname === '/v1/tools/search') return json({ results: documents.map(doc => ({ title: doc.title, url: doc.url, date: doc.disclosedOn, snippet: '固定公开财报；须读取原文后引用。' })) });
    throw new Error(`BASELINE_UNRECORDED_REQUEST:${url.origin}${url.pathname}`);
  };
  return () => { globalThis.fetch = original; };
}
