import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildResearchReportDiff } from '../../src/lib/company-research/report-diff';
import { financialChanges } from '../../src/lib/company-research/report-assembly';

async function main() {
  const original = JSON.parse(await readFile('data/research-agent-upgrade/evidence/S13/2026-10-19T06-06-19-135Z/complete-corpus.json', 'utf8'));
  const sources = JSON.parse(await readFile('data/research-agent-upgrade/evidence/S13/2026-10-19T06-06-19-135Z/complete-corpus-sources.json', 'utf8'));
  const task = structuredClone(original), id = randomUUID();
  task.id = id; task.spec.company.name = '报告更新界面演练（合成差异）'; task.reportSpec = task.spec; task.acceptance = null;
  const before = { ...structuredClone(original.report), taskId: id }, after = structuredClone(before);
  after.revision = 2; after.generatedAt = new Date().toISOString(); after.status = 'partial';
  after.claims[0].status = 'conflict'; after.claims[0].reason = '合成撤回样例：新版证据与旧结论冲突，仅验证界面。';
  after.gaps = [{ code: 'evidence_conflict', questionId: after.claims[0].questionId, message: after.claims[0].reason }];
  task.report = after; task.status = 'partial'; task.reportRevision = 2; task.reportHash = null;
  const versions = [before, after].map(report => ({ report, spec: task.spec, changes: financialChanges(report), diff: report.revision === 2 ? buildResearchReportDiff(before, after) : null }));
  const output = path.resolve('data/research-agent-upgrade/evidence/S17', `ui-${Date.now()}`); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'update-fixture.json'), JSON.stringify({ scope: 'synthetic revision/withdrawal UI fixture over retained public sources; not a validated model report', task, versions,
    sources: [...sources.map((s: {selection: object}) => ({ ...s, taskId: id })), ...sources.map((s: {selection: object}) => ({ ...s, taskId: id, selection: { ...s.selection, reportRevision: 2 } }))] }, null, 2));
  console.log(path.join(output, 'update-fixture.json'));
}
void main();
