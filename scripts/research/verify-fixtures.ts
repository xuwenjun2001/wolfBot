import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizedPromptHash } from '../../src/lib/eval/dataset-contract';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const normalized = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '');
async function main() {
  const args = process.argv.slice(2);
  const datasetOption = args.find(a => a.startsWith('--dataset='))?.slice('--dataset='.length);
  if (datasetOption) {
    const { verifyFixturesV2 } = await import('./verify-fixtures-v2');
    return verifyFixturesV2(datasetOption, args.find(a => a.startsWith('--output-dir='))?.slice('--output-dir='.length));
  }
  const directory = 'fixtures/company-research';
  const manifest = JSON.parse(await readFile(`${directory}/documents.json`, 'utf8'));
  const dataset = JSON.parse(await readFile(`${directory}/development.json`, 'utf8'));
  const rubric = JSON.parse(await readFile(`${directory}/rubric.json`, 'utf8'));
  const pages = new Map<string, { page: number; text: string }[]>();
  for (const doc of manifest.documents) {
    const bytes = await readFile(doc.path);
    if (sha(bytes) !== doc.bytesSha256 || bytes.length !== doc.byteLength) throw new Error(`Changed original: ${doc.id}`);
    const parsed = JSON.parse(await readFile(doc.pagesPath, 'utf8'));
    if (sha(parsed.map((p: {page:number;text:string}) => `[第 ${p.page} 页]\n${p.text}`).join('\n')) !== doc.textSha256) throw new Error(`Changed text: ${doc.id}`);
    pages.set(doc.id, parsed);
  }
  let facts = 0, citations = 0, questions = 0;
  const promptHashes: string[] = [];
  for (const c of dataset.cases) {
    questions += c.questions.length;
    for (const q of c.questions) promptHashes.push(normalizedPromptHash(`${c.company.symbol} ${q.text}`));
    for (const f of c.reference.facts) {
      const source = manifest.documents.find((d: {id:string}) => d.id === f.citation.documentId);
      if (!source || f.citation.bytesSha256 !== source.bytesSha256 || !c.documentIds.includes(source.id)) throw new Error('Reference binding mismatch');
      if (f.period.start !== source.period.start || f.period.end !== source.period.end) throw new Error('Wrong reference period');
      const text = pages.get(source.id)!.find(p => p.page === f.citation.filePage)!.text;
      if (!normalized(text).includes(normalized(f.citation.quote))) throw new Error('Missing fact quote');
      if (!normalized(f.citation.quote).replace(/,/g, '').includes(f.rawValue)) throw new Error('Missing raw numeric value');
      const scaled = BigInt(f.rawValue.replace('.', '')) * (f.unit === 'thousand_yuan' ? 1000n : 1n);
      const expected = BigInt(f.normalizedYuan.replace('.', ''));
      if (scaled !== expected) throw new Error('Unit conversion mismatch');
      facts++; citations++;
    }
    for (const citation of c.reference.riskCitations) {
      const text = pages.get(citation.documentId)!.find(p => p.page === citation.filePage)!.text;
      if (!normalized(text).includes(normalized(citation.quote))) throw new Error('Missing risk quote');
      citations++;
    }
    for (const change of c.reference.changes) {
      const pair = c.reference.facts.filter((f: {metric:string}) => f.metric === change.metric);
      const expected = (Number(pair[1].rawValue) - Number(pair[0].rawValue)) / Math.abs(Number(pair[0].rawValue)) * 100;
      if (Math.abs(expected - Number(change.percentage)) > rubric.tolerances.percentagePoints) throw new Error('Change reference mismatch');
    }
  }
  const scan = JSON.parse(await readFile(`${directory}/derived-scan.json`, 'utf8'));
  if (sha(await readFile(scan.path)) !== scan.bytesSha256) throw new Error('Changed scan');
  const hidden = JSON.parse(await readFile(`${directory}/holdout-registration.json`, 'utf8'));
  const hiddenRoot = process.env.RESEARCH_HOLDOUT_ROOT;
  if (hiddenRoot) {
    const raw = await readFile(`${hiddenRoot}/holdout/manifest.json`);
    if (sha(raw) !== hidden.manifestSha256) throw new Error('Holdout manifest changed');
    if (sha(await readFile(`${hiddenRoot}/holdout/tasks.json`)) !== hidden.tasksSha256) throw new Error('Holdout task changed');
    const h = JSON.parse(raw.toString());
    const development = new Set(manifest.documents.map((d: {symbol:string}) => d.symbol));
    for (const doc of h.documents) {
      if (development.has(doc.symbol)) throw new Error('Company split leak');
      if (sha(await readFile(doc.path)) !== doc.bytesSha256) throw new Error('Holdout original changed');
    }
  }
  const result = { schemaVersion: 1, checkedAt: new Date().toISOString(), documents: pages.size, companies: dataset.cases.length,
    questions, numericFacts: facts, validatedCitations: citations, uniqueQuestions: new Set(promptHashes).size,
    humanGoldenCompanies: 0, humanReview: 'pending', hidden: hiddenRoot ? 'hashes and company isolation verified; no answers scored' : 'not checked',
    rubricSha256: sha(await readFile(`${directory}/rubric.json`)), datasetSha256: sha(await readFile(`${directory}/development.json`)) };
  await mkdir('data/research-agent-upgrade/evidence/S02', { recursive: true });
  await writeFile('data/research-agent-upgrade/evidence/S02/verification.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
