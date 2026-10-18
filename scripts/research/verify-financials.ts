import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { factFromDisclosure } from '../../src/lib/company-research/financial-normalization';
import { compareFinancialFacts } from '../../src/lib/company-research/financial-comparison';
import type { FinancialFact } from '../../src/lib/company-research/document-contracts';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';

async function main() {
  const root = path.resolve('data/research-agent-upgrade/evidence/S09', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(root, { recursive: true });
  const dataset = JSON.parse(await readFile('fixtures/company-research/development.json', 'utf8'));
  const results = []; let amounts = 0, changes = 0;
  for (const c of dataset.cases) {
    const facts: FinancialFact[] = c.reference.facts.map((f: typeof c.reference.facts[number], i: number) => {
      const fact = factFromDisclosure({ id: `reference-${c.id}-${i}`, companySymbol: c.company.symbol,
        period: { ...f.period, id: f.period.end.slice(0, 4), basis: f.basis }, metric: f.metric, scope: f.scope, restatement: 'original',
        citations: [{ documentId: f.citation.documentId, documentVersion: 1, bytesSha256: f.citation.bytesSha256, quote: f.citation.quote, locator: { kind: 'page', filePage: f.citation.filePage } }] }, f.rawValue,
        ({ yuan: '元', thousand_yuan: '千元', ten_thousand_yuan: '万元', hundred_million_yuan: '亿元' } as Record<string, string>)[f.unit], 'native');
      assert.equal(fact.normalization!.normalizedYuan, f.normalizedYuan.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
      amounts++; return fact;
    });
    for (const expected of c.reference.changes) {
      const pair = facts.filter(f => f.metric === expected.metric);
      const result = compareFinancialFacts(pair[0], pair[1]);
      assert.equal(result.status, 'comparable');
      if (result.status !== 'comparable') throw new Error('Comparison failed');
      assert(result.percentage !== null && Math.abs(Number(result.percentage) - Number(expected.percentage)) <= .01);
      changes++; results.push({ company: c.company.symbol, ...result });
    }
  }
  const sourceSha256 = Object.fromEntries(await Promise.all(['src/lib/company-research/exact-decimal.ts', 'src/lib/company-research/financial-normalization.ts', 'src/lib/company-research/financial-comparison.ts', 'src/lib/company-research/document-contracts.ts', 'scripts/research/verify-financials.ts'].map(async file => [file, artifactDigest(await readFile(file))])));
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ algorithm: 'decimal-v1', sourceSha256, fixtureSha256: artifactDigest(await readFile('fixtures/company-research/development.json')),
    amountHits: amounts, amountDenominator: 24, changeHits: changes, changeDenominator: 12, results, mode: 'reference_input_arithmetic_only', modelEvaluation: false }, null, 2));
  console.log(JSON.stringify({ evidence: root, amounts, changes, modelEvaluation: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
