/** Prepare a private, unsigned review packet only after the final holdout run. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';
import { financialChanges, requiredFinancialMetrics } from '../../src/lib/company-research/report-assembly';
import type { ResearchReportRevision } from '../../src/lib/company-research/revision-contracts';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const escapeCell = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
async function main() {
  assert(process.env.RESEARCH_EVALUATION_CAMPAIGN && process.env.RESEARCH_HOLDOUT_ROOT, 'Explicit campaign and external holdout root required');
  const campaign = path.resolve(process.env.RESEARCH_EVALUATION_CAMPAIGN);
  const controlled = path.resolve(process.env.RESEARCH_HOLDOUT_ROOT);
  assert(campaign.startsWith(path.resolve('data/research-agent-upgrade/evidence/S19') + path.sep));
  assert(controlled !== process.cwd() && !controlled.startsWith(process.cwd() + path.sep), 'Review packet must stay outside the repository');
  const freezeFile = path.join(campaign, 'freeze.json');
  const opened = await json(path.join(campaign, 'holdout-opened.json'));
  assert.equal(opened.freezeHash, artifactDigest(await readFile(freezeFile)));
  const resultsFile = path.join(campaign, 'holdout/results.json');
  const results = await json(resultsFile);
  assert(results.complete && results.actualModelRuns === 2 && results.results.length === 2, 'Two completed run records required');
  const manifest = await json(path.join(controlled, 'holdout/manifest.json'));
  const registration = await json('fixtures/company-research/holdout-registration.json');
  assert.equal(artifactDigest(await readFile(path.join(controlled, 'holdout/manifest.json'))), registration.manifestSha256);
  const output = path.join(controlled, 'annotations', path.basename(campaign));
  await mkdir(output, { recursive: true });
  const inputs: Record<string, string> = { freeze: opened.freezeHash, results: artifactDigest(await readFile(resultsFile)) };
  const lines = ['# 保留集人工复核包（未签署）', '',
    '本包在最终选择冻结及两次保留运行结束后生成，仅整理机器输出与原文定位，不创建参考答案、不代签。先独立阅读原件，再核对下列候选；所有空白由实际核对者填写。', '',
    '每公司固定 6 个原值 + 3 个变化率；缺答也保留在 18 项分母。6 个问题全部判断；每条实质 claim 分别核查。数值 ≥95%、支持 ≥90%、问题完成 ≥80%，硬门须全过。按冻结 rubric 记录容差、partial 和冲突，不用机器 completed 代替人工通过。', '',
    `- 选择：${(await json(freezeFile)).selected}；Skill：${results.skillVersion}`,
    `- freeze SHA-256：${inputs.freeze}`, `- results SHA-256：${inputs.results}`,
    '- reviewerId：待填写', '- reviewedAt：待填写（含时区）', '- 最终确认：pending', ''];
  for (const run of results.results) {
    assert(/^holdout-[12]$/.test(run.label));
    const directory = path.join(campaign, 'holdout', run.label);
    const snapshotFile = path.join(directory, 'task.json');
    const snapshot = await json(snapshotFile);
    const report = snapshot.report as ResearchReportRevision | null;
    inputs[`${run.label}/task`] = artifactDigest(await readFile(snapshotFile));
    const sourcesFile = path.join(directory, 'sources.json');
    inputs[`${run.label}/sources`] = artifactDigest(await readFile(sourcesFile));
    const sources = await json(sourcesFile);
    lines.push(`## ${run.label}：${snapshot.spec.company.name}`, '',
      `机器终态：${run.status}；报告 hash：${run.reportHash || '无报告'}；asOf：${snapshot.spec.asOf}。机器硬门：${run.hardErrors.length ? '有错误，见原结果' : '无已知错误'}；人工硬门：待核。`, '',
      '### 原件与时点', '', '| 文档 | 原件路径 | SHA-256 | 披露证据 / 人工核对 |', '| --- | --- | --- | --- |');
    for (const document of snapshot.documents) {
      const original = manifest.documents.find((item: { id: string }) => item.id === document.id);
      lines.push(`| ${escapeCell(document.title)} | ${escapeCell(original?.path || '缺失')} | ${document.bytesSha256} | ${escapeCell(JSON.stringify(document.disclosure))} / 待核 |`);
    }
    lines.push('', '### 必需数值（人工预期和结论保持空白）', '', '| 项目 / 期间 | 模型候选 | 人工原值、单位、元值 / 原件页 | approved / corrected / missing / disputed |', '| --- | --- | --- | --- |');
    for (const period of snapshot.spec.periods) for (const metric of requiredFinancialMetrics) {
      const fact = report?.facts.find(item => item.metric === metric && item.period.start === period.start && item.period.end === period.end);
      lines.push(`| ${metric} / ${period.end} | ${escapeCell(fact ? JSON.stringify(fact.value) : '缺答')} | 待填写 | 待判定 |`);
    }
    const changes = report ? financialChanges(report) : [];
    for (const metric of requiredFinancialMetrics) lines.push(`| ${metric} / 增幅 | ${escapeCell(JSON.stringify(changes.find(item => item.metric === metric)?.comparison ?? '缺答'))} | 独立复算后填写 | 待判定 |`);
    lines.push('', '### 三个必需问题', '', '| 问题 | 人工最终答案与引文 / partial 原因 | 完成判定 |', '| --- | --- | --- |');
    for (const question of snapshot.spec.questions) lines.push(`| ${escapeCell(question.text)} | 待填写 | 待判定 |`);
    lines.push('', '### 全部机器结论（不是人工判定）', '');
    for (const claim of report?.claims || []) lines.push(`- ${claim.id} / ${claim.questionId} / 机器状态 ${claim.status}`, `  候选：${claim.text}`, '  人工支持标签、理由、修正及原文：待填写。', '');
    lines.push('机器 gaps：', '', JSON.stringify(report?.gaps ?? ['无报告'], null, 2), '', '### 原文定位摘录', '',
      '摘录可能截断；以指定原件及 PDF 文件页为准。引用存在和语义支持分别判断。', '');
    for (const source of sources) lines.push(`#### ${source.selection.claimId || source.selection.factId} / 引用 ${source.selection.citationIndex}`, '',
      `${source.document.title} / v${source.document.version} / ${JSON.stringify(source.citation.locator)} / ${source.document.bytesSha256}`, '',
      `模型引文：${source.citation.quote}`, '', '原文摘录：', '', source.text, '', '人工引用/语义结论：待填写。', '');
  }
  lines.push('## 批次收尾', '', '- [ ] 4 原件身份、hash、期间、口径和披露/asOf 全部核查。',
    '- [ ] 18 必需数值、6 问题及全部实质 claims 逐项判定，缺失保留分母。',
    '- [ ] 已填写实际审核人、时间、支持理由、更正、未解决项；没有代签。',
    '- [ ] 计算冻结指标及逐题结果，单独保存结果版本/hash；不改写原始模型结果和冻结题。',
    '- [ ] 仅将数量、版本、hash 和通过/未通过摘要登记到仓库；题目、原文及审核人资料保持外部受控。', '');
  const packet = lines.join('\n');
  await writeFile(path.join(output, 'review.md'), packet, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(output, 'inputs.json'), JSON.stringify({ status: 'pending_independent_human', inputs, packetSha256: artifactDigest(packet), noAutomaticAcceptance: true }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, cases: 2, requiredNumbers: 18, requiredQuestions: 6, status: 'pending_independent_human', packetSha256: artifactDigest(packet) }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Review packet preparation failed'); process.exitCode = 1; });
