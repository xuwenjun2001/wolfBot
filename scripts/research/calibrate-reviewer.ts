import '../workers/worker-environment';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createResearchProvider } from '../../src/lib/company-research/provider';
import { researchConfig, safeError } from '../../src/lib/company-research/config';
import { requestClaimReview, reviewerPrompt } from '../../src/lib/company-research/claim-reviewer';
import { artifactDigest } from '../../src/lib/company-research/artifact-store';

async function main() {
  const config = researchConfig(), root = path.resolve('data/research-agent-upgrade/evidence/S12', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(root, { recursive: true });
  const parsedRoot = 'data/research-agent-upgrade/evidence/S07/2026-10-18T17-44-58-299Z';
  const doc = async (year: number, filePage: number) => {
    const r = JSON.parse(await readFile(`${parsedRoot}/600519-${year}-annual.json`, 'utf8'));
    return { company: '贵州茅台', period: String(year), filePage, context: r.pages.find((p: {filePage: number}) => p.filePage === filePage).text };
  };
  const numeric = [await doc(2023, 5), await doc(2024, 5)], risks = [await doc(2023, 21), await doc(2024, 22)];
  const base = { question: { id: 'income_profit', text: '比较两期收入和归母净利润' }, periods: ['2023', '2024'], evidence: numeric };
  const income = '贵州茅台2023年营业收入147693604994.14元、归母净利润74734071550.75元；2024年分别为170899152276.34元、86228146421.62元，均增长。';
  const cases = [
    { id: 'supported_income', expected: 'supported', input: { ...base, claim: { kind: 'fact', text: income } } },
    { id: 'opposite_meaning', expected: 'conflict', input: { ...base, claim: { kind: 'fact', text: income.replace('均增长', '均下降') } } },
    { id: 'wrong_company', expected: 'insufficient', input: { ...base, claim: { kind: 'fact', text: income.replace('贵州茅台', '五粮液') } } },
    { id: 'wrong_period', expected: 'conflict', input: { ...base, claim: { kind: 'fact', text: '贵州茅台2023年营业收入170899152276.34元、归母净利润86228146421.62元；2024年分别为147693604994.14元、74734071550.75元。' } } },
    { id: 'wrong_unit', expected: 'conflict', input: { ...base, claim: { kind: 'fact', text: income.replaceAll('元', '万元') } } },
    { id: 'unsupported_cause', expected: 'insufficient', input: { question: { id: 'cash_flow', text: '比较现金流与利润方向，解释变动原因' }, periods: ['2023', '2024'], evidence: numeric, claim: { kind: 'fact', text: '2023年经营现金流66593247721.09元，2024年92463692168.43元，与利润均增长。现金流增加是因为赊销回款率提高。' } } },
    { id: 'supported_risks', expected: 'supported', input: { question: { id: 'risks', text: '比较两期风险' }, periods: ['2023', '2024'], evidence: risks, claim: { kind: 'fact', text: '两期可能面对的风险段落均列示宏观经济、安全、舆情、环境保护风险，四项表述延续；这不代表没有其他风险。' } } },
    { id: 'risk_disappearance', expected: 'conflict', input: { question: { id: 'risks', text: '比较两期风险' }, periods: ['2023', '2024'], evidence: risks, claim: { kind: 'fact', text: '2024年安全风险已完全消失。' } } },
  ];
  const results = [];
  for (const c of cases) {
    const start = Date.now();
    try {
      const review = await requestClaimReview(createResearchProvider(), config.model, c.input, AbortSignal.timeout(120000));
      // Both non-support verdicts reject publication; retain exact verdict separately.
      const passed = c.expected === 'supported' ? review.verdict.verdict === 'supported' : review.verdict.verdict !== 'supported';
      results.push({ id: c.id, expected: c.expected, ...review, passed, elapsedMs: Date.now() - start, inputSha256: artifactDigest(JSON.stringify(c.input)) });
      console.log(`${c.id}: ${review.verdict.verdict} (${passed ? 'pass' : 'fail'})`);
    } catch (error) { results.push({ id: c.id, expected: c.expected, passed: false, error: safeError(error), elapsedMs: Date.now() - start }); }
  }
  const receipt = { version: 'claim-review-calibration-v1', model: config.model, reasoning: config.reasoning, promptSha256: artifactDigest(reviewerPrompt),
    annotationAcceptanceSha256: artifactDigest(await readFile('data/research-agent-upgrade/annotations/2026-10-19-ai-assisted-01/acceptance.json')),
    scope: 'development-only, same-model separate-call reviewer; 2 positive and 6 rejection probes, not population semantic accuracy', cases: results, passed: results.every(r => r.passed), createdAt: new Date().toISOString(), cost: 'unknown' };
  await writeFile(path.join(root, 'calibration.json'), JSON.stringify(receipt, null, 2));
  console.log(`Calibration: ${root}/calibration.json`); if (!receipt.passed) process.exitCode = 1;
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
