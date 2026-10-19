import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';
import { numericFactErrors } from '../../src/lib/company-research/claim-verification';
import { factFromDisclosure } from '../../src/lib/company-research/financial-normalization';
import type { VersionedCitation } from '../../src/lib/company-research/document-contracts';

// Replay recorded failures against their original parsed pages, without a model,
// database, altered reference answer, or new logical-task budget.
async function main() {
  const root = 'data/research-agent-upgrade/evidence';
  const campaign = path.join(root, 'S19/paired-20261020-01/baseline');
  const rows = [];
  for (const sample of ['dev-000858', 'dev-000333']) {
    const traceBytes = await readFile(path.join(campaign, sample, 'tools.jsonl'));
    const snapshot = JSON.parse(await readFile(path.join(campaign, sample, 'task.json'), 'utf8'));
    const failures = traceBytes.toString().trim().split('\n').map(line => JSON.parse(line)).filter(record =>
      record.type === 'tool_result' && record.data.toolCall.name === 'record_fact' &&
      record.data.result.error?.message.includes('FACT_UNIT_UNVERIFIED'));
    assert(failures.length > 0);
    for (const record of failures) {
      const input = JSON.parse(record.data.toolCall.arguments);
      const fact = factFromDisclosure({ id: `${input.periodId}-${input.metric}`, companySymbol: snapshot.spec.company.symbol,
        period: snapshot.spec.periods.find((period: {id: string}) => period.id === input.periodId), metric: input.metric,
        scope: snapshot.spec.scope, restatement: 'original', citations: input.citations }, input.rawText, input.unitLabel, 'native');
      assert.equal(fact.value.status, 'known');
      const pages = new Map<string, string>();
      const pageKey = (citation: VersionedCitation) => `${citation.documentId}:${citation.documentVersion}:${citation.locator.kind === 'html' ? 'html' : citation.locator.filePage}`;
      for (const citation of input.citations as VersionedCitation[]) {
        const parsed = JSON.parse(await readFile(path.join(root, 'S07/2026-10-18T17-44-58-299Z', `${citation.documentId}.json`), 'utf8'));
        const page = parsed.pages.find((page: {filePage: number}) => citation.locator.kind !== 'html' && page.filePage === citation.locator.filePage);
        assert(page);
        pages.set(pageKey(citation), page.text);
      }
      const after = numericFactErrors(fact, snapshot.documents, citation => pages.get(pageKey(citation)));
      assert(!after.includes('FACT_UNIT_UNVERIFIED') && !after.includes('FACT_ORIGINAL_MISSING'), `Unit or original still unverified: ${sample}/${fact.id}`);
      rows.push({ sample, factId: fact.id, before: record.data.result.error.message, after, traceSha256: artifactDigest(traceBytes) });
    }
  }
  const output = path.join(root, 'S19/inline-unit-replay.json');
  await writeFile(output, JSON.stringify({ scope: 'original failed record_fact inputs and S07 pages; numeric validation only, no new publication', rows }, null, 2));
  console.log(`Replayed ${rows.length} real unit failures; ${rows.filter(row => !row.after.length).length} now pass all numeric checks. Evidence: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
