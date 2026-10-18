import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Pass an archived S03 manifest.json; no model or database is used');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  if (sha(await readFile('fixtures/company-research/development.json')) !== manifest.datasetSha256) throw new Error('Dataset differs from baseline');
  if (sha(await readFile('fixtures/company-research/rubric.json')) !== manifest.rubricSha256) throw new Error('Rubric differs from baseline');
  for (const run of manifest.runs) {
    const bytes = await readFile(run.rawPath);
    if (sha(bytes) !== run.rawSha256) throw new Error('Archived result changed');
    const result = JSON.parse(bytes.toString());
    if (run.runId !== result.result.snapshot.id || run.actor !== manifest.identity) throw new Error('Run identity mismatch');
    if (result.result.snapshot.status !== run.terminalStatus) throw new Error('Terminal mismatch');
    if (run.usageCompleteness !== 'complete' && run.usage != null) throw new Error('Missing usage represented as measured');
  }
  console.log(JSON.stringify({ verifiedRuns: manifest.runs.length, classification: 'archived observation replay; no model regenerated', statuses: manifest.runs.map((r: any) => [r.caseId, r.terminalStatus, r.failureStage]) }, null, 2));
}
void main().catch(e => { console.error(e.message); process.exitCode = 1; });
