import { canonicalResearchJson } from './task-contracts';
import { normalizedYuan } from './financial-normalization';
import { researchReportDiffSchema, type ResearchReportDiff, type ResearchReportRevision } from './revision-contracts';
import { artifactDigest } from './artifact-store';
import { factCitations } from './financial-evidence';

function allFacts(report: ResearchReportRevision) { return [...report.facts, ...(report.supportingFacts || [])]; }
function factKey(fact: ResearchReportRevision['facts'][number]) { return `${fact.metric}:${fact.scope}:${fact.period.id}`; }
function factValue(fact: ResearchReportRevision['facts'][number]) {
  return canonicalResearchJson({ value: fact.value.status === 'known' ? { status: 'known', yuan: normalizedYuan(fact), currency: fact.value.currency } : fact.value,
    period: fact.period, restatement: fact.restatement, accountingBasis: fact.accountingBasis, comparisonLimitations: fact.comparisonLimitations || [] });
}
function allCitations(report: ResearchReportRevision) {
  return [...allFacts(report).flatMap(factCitations), ...report.claims.flatMap(claim => claim.citations)];
}
function citationReference(citation: ReturnType<typeof allCitations>[number]) {
  const { quote: _quote, ...reference } = citation;
  return reference;
}
function citationKey(citation: ReturnType<typeof allCitations>[number]) { return canonicalResearchJson(citationReference(citation)); }

export function researchReportEvidenceHashes(report: ResearchReportRevision) {
  const hashes = report.method?.dataHashes || [];
  return new Set([...hashes, ...allCitations(report).map(citation => citation.bytesSha256)]);
}

export function buildResearchReportDiff(before: ResearchReportRevision, after: ResearchReportRevision): ResearchReportDiff {
  if (before.taskId !== after.taskId || before.revision >= after.revision) throw new Error('Report versions must belong to one task and be ordered');
  const parallelKeys = new Set([before, after].flatMap(report => {
    const keys = allFacts(report).map(factKey);
    return keys.filter((key, index) => keys.indexOf(key) !== index);
  }));
  // Keep the established single-version change semantics, while retaining parallel disclosures.
  const keyFor = (fact: ResearchReportRevision['facts'][number]) => parallelKeys.has(factKey(fact))
    ? `${factKey(fact)}:${artifactDigest(canonicalResearchJson([fact.restatement, fact.accountingBasis, fact.id])).slice(0, 24)}` : factKey(fact);
  const beforeFacts = new Map(allFacts(before).map(fact => [keyFor(fact), fact]));
  const afterFacts = new Map(allFacts(after).map(fact => [keyFor(fact), fact]));
  const facts = [...new Set([...beforeFacts.keys(), ...afterFacts.keys()])].sort().map(key => {
    const oldFact = beforeFacts.get(key) || null, newFact = afterFacts.get(key) || null;
    const fact = newFact || oldFact!;
    const status = !oldFact || oldFact.value.status !== 'known' && newFact?.value.status === 'known' ? 'added'
      : oldFact.value.status === 'known' && (!newFact || newFact.value.status !== 'known') ? 'withdrawn'
        : newFact && factValue(oldFact) !== factValue(newFact) ? 'changed' : 'unchanged';
    const reason = status === 'added' ? '新版报告新增了该指标和期间的已核实金额。'
      : status === 'withdrawn' ? '新版报告未保留该指标和期间的已核实金额。'
        : status === 'changed' ? '新版报告的金额、重述标记或会计口径与上一版不同。'
          : '已核实金额、重述标记和会计口径未变化。';
    return { key, metric: fact.metric, periodId: fact.period.id, status, before: oldFact, after: newFact, reason };
  });

  const beforeClaims = new Map(before.claims.map(claim => [claim.id, claim]));
  const afterClaims = new Map(after.claims.map(claim => [claim.id, claim]));
  const claims = [...new Set([...beforeClaims.keys(), ...afterClaims.keys()])].sort().map(id => {
    const oldClaim = beforeClaims.get(id) || null, newClaim = afterClaims.get(id) || null;
    const claim = newClaim || oldClaim!;
    const equal = !!oldClaim && !!newClaim && canonicalResearchJson(oldClaim) === canonicalResearchJson(newClaim);
    const status = equal ? 'unchanged'
      : oldClaim?.status === 'supported' && (!newClaim || newClaim.status !== 'supported') ? 'withdrawn'
        : newClaim?.status === 'supported' && oldClaim?.status !== 'supported' ? 'supported'
          : newClaim ? 'revised' : 'withdrawn';
    const reason = status === 'unchanged' ? '结论文本、核验状态及引用未变化。'
      : status === 'supported' ? '新版报告中的结论通过了本版本的证据与语义核验。'
        : status === 'withdrawn' ? newClaim?.reason || '新版报告未保留上一版的受支持结论。'
          : newClaim?.reason || '结论文本、核验状态或引用发生变化，需要按新版证据复核。';
    return { id, questionId: claim.questionId, status, before: oldClaim, after: newClaim, reason };
  });

  const beforeEvidence = new Map(allCitations(before).map(citation => [citationKey(citation), citationReference(citation)]));
  const afterEvidence = new Map(allCitations(after).map(citation => [citationKey(citation), citationReference(citation)]));
  const evidence = {
    added: [...afterEvidence].filter(([key]) => !beforeEvidence.has(key)).map(([, citation]) => citation),
    removed: [...beforeEvidence].filter(([key]) => !afterEvidence.has(key)).map(([, citation]) => citation),
  };
  const changed = facts.some(fact => fact.status !== 'unchanged') || claims.some(claim => claim.status !== 'unchanged')
    || evidence.added.length > 0 || evidence.removed.length > 0 || before.asOf !== after.asOf;
  return researchReportDiffSchema.parse({ schemaVersion: 1, fromRevision: before.revision, toRevision: after.revision,
    status: changed ? 'changed' : 'unchanged', asOf: { before: before.asOf, after: after.asOf }, facts, claims, evidence });
}
