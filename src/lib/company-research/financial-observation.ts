/** Retain useful source text before metadata; the full original stays in the artifact store. */
export function financialObservation(tool: string, data: unknown): string {
  if (tool === 'search_evidence' && data && typeof data === 'object' && 'hits' in data) {
    const result = data as { hits: Record<string, unknown>[]; scopedDocumentCount: number; limited: boolean };
    return JSON.stringify({ scopedDocumentCount: result.scopedDocumentCount, limited: result.limited, hits: result.hits.slice(0, 6).map(h => ({
      sourceId: h.sourceId, documentVersion: h.documentVersion, bytesSha256: h.bytesSha256, locator: h.locator,
      snippet: h.snippet, context: h.context,
    })) }).slice(0, 6000);
  }
  return JSON.stringify(data).slice(0, 6000);
}

/** Public model view; the complete checkpoint and quotations remain immutable evidence. */
export function financialContextState(state: import('./execution-contracts').ResearchCheckpoint, compact = false) {
  const quoteLimit = compact ? 160 : 350;
  const cite = (c: import('./document-contracts').VersionedCitation) => ({ ...c, quote: c.quote.slice(0, quoteLimit), quoteTruncated: c.quote.length > quoteLimit });
  const fact = (f: import('./document-contracts').FinancialFact) => ({ ...f, citations: f.citations.slice(0, 2).map(cite),
    ...(f.periodEvidence ? { periodEvidence: f.periodEvidence.slice(0, 2).map(cite) } : {}),
    ...(f.accountingBasisEvidence ? { accountingBasisEvidence: f.accountingBasisEvidence.slice(0, 2).map(cite) } : {}) });
  const observations = state.observations.filter(o => !['record_fact', 'record_claim', 'check_coverage'].includes(o.tool)).slice(compact ? -2 : -3)
    .map(o => ({ ...o, summary: o.summary.slice(0, compact ? 1600 : 3500) }));
  return { ...state, observations,
    ...(state.schemaVersion === 2 ? { evidenceLedger: Object.fromEntries(Object.entries(state.evidenceLedger).map(([id, evidence]) => [id, { locatorCount: evidence.locatorKeys.length, contentCount: evidence.evidenceHashes.length }])),
      verificationAttempts: Object.keys(state.verificationAttempts), documentPeriods: undefined } : {}),
    facts: state.facts.map(fact),
    ...(state.supportingFacts ? { supportingFacts: state.supportingFacts.map(fact) } : {}),
    claims: state.claims.map(c => ({ ...c, text: c.text.slice(0, compact ? 800 : 1200), textTruncated: c.text.length > (compact ? 800 : 1200), citations: c.citations.slice(0, 2).map(cite) })),
  };
}

export function nextFinancialAction(spec: import('./task-contracts').ResearchTaskSpec, state: import('./execution-contracts').ResearchCheckpoint) {
  if (state.checkedHash && state.phase === 'ready') return '覆盖检查已通过，当前事实和结论未再修改。现在调用 submit_report({}) 交付已核查结果，不再重复 check_coverage。';
  const missing = spec.periods.flatMap(p => ['revenue', 'parent_net_profit', 'operating_cash_flow'].filter(metric => !state.facts.some(f => f.period.id === p.id && f.metric === metric && f.value.status === 'known')).map(metric => `${p.id}:${metric}`));
  if (missing.length) return `待保存的必要金额：${missing.join('、')}。只补这些项；若该期资料确实缺失，保留缺口并继续三问。`;
  for (const question of spec.questions) {
    const claims = state.claims.filter(c => c.questionId === question.id);
    const focus = question.id === 'cash_flow' ? '检索并读取经营活动产生的现金流量净额变动原因说明，解释必须引用该原文。' : question.id === 'risks' ? '检索两期可能面对的风险，读取完整清单及相关管理表述。' : '引用两期财务摘要和已计算的变化。';
    if (!claims.length) return `下一目标：${question.text}。${focus}随后 record_claim 并 verify_claim。`;
    if (claims.some(c => c.status !== 'supported') || state.steps[`${question.id}-verify`] === 'partial') return `尚未完成：${question.text}。${focus}按审查意见补证后修复同一 claim id，再核验；无法补齐时如实 partial。`;
    if (state.steps[`${question.id}-verify`] !== 'completed') return `下一目标：verify_claim 核验 ${claims.map(c => c.id).join('、')}。`;
  }
  return '三问已核验，check_coverage 后 submit_report；不要重复读取或重写已核验结论。';
}

export function financialChangeSummary(rows: ReturnType<typeof import('./report-assembly').financialChanges>) {
  return rows.map(row => ({ metric: row.metric, beforeId: row.before?.id, afterId: row.after?.id,
    beforeYuan: row.before?.normalization?.normalizedYuan, afterYuan: row.after?.normalization?.normalizedYuan,
    comparison: row.comparison && { ...row.comparison, citations: undefined } }));
}
