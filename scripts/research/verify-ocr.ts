import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsedDocumentV2Schema } from '../../src/lib/company-research/parsed-document';
async function main() {
  const root = path.resolve(process.argv[2] || 'data/research-agent-upgrade/evidence/S08/probe-01');
  const dataset = JSON.parse(await readFile('fixtures/company-research/development.json', 'utf8'));
  const norm = (s: string) => s.normalize('NFKC').replace(/[\s,]/g, '');
  const labels: Record<string, string> = { revenue: '营业收入', parent_net_profit: '归属于上市公司股东的净利润', operating_cash_flow: '经营活动产生的现金流量净额' };
  const checks = [];
  for (const [name, company] of [['scan-maotai-p5', '600519.SH'], ['native-maotai-p5', '600519.SH'], ['native-midea-p9', '000333.SZ']]) {
    const receipt = parsedDocumentV2Schema.parse(JSON.parse(await readFile(path.join(root, name + '.json'), 'utf8')));
    const tables = receipt.pages.flatMap(p => p.blocks).filter(b => b.table);
    let hits = 0;
    for (const f of dataset.cases.find((c: {company: {symbol: string}}) => c.company.symbol === company).reference.facts) {
      const found = tables.some(b => {
        const row = b.table!.cells.find(c => norm(c.text).includes(norm(labels[f.metric])));
        const header = b.table!.cells.find(c => norm(c.text) === f.period.end.slice(0, 4) + '年');
        return row && header && b.table!.cells.some(c => c.row === row.row && c.column === header.column && norm(c.text) === norm(f.rawValue));
      });
      assert(found, `Unmatched row/column/value: ${name} ${f.metric} ${f.period.end}`); hits++;
    }
    assert(receipt.pages[0].blocks.some(b => b.locator.kind !== 'html' && !!b.locator.box));
    assert(tables.every(b => b.quality === 'needs_review'));
    checks.push({ name, hits, denominator: 6, tables: tables.length, actualBoxes: true, reviewFlagsRetained: true, humanReview: 'pending' });
  }
  await writeFile(path.join(root, 'verification.json'), JSON.stringify({ checks, mode: 'machine_row_column_check_against_frozen_reference', modelEvaluation: false }, null, 2));
  console.log(JSON.stringify({ root, checks }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
