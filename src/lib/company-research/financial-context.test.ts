import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PiAgentContextManager } from '@/lib/agent/context';
import { emptyCheckpoint, financialResearchPrompt } from './execution-contracts';
import { financialContextState } from './financial-observation';
import { financialResearchTools } from './financial-tools';
import { specFixture, reportFixture } from './version-test-fixtures';

it('fits six facts, three long claims and source observations in the original context budget without rewriting evidence', () => {
  const spec = specFixture(), state = emptyCheckpoint(1, 1), report = reportFixture(), citation = { ...report.facts[0].citations[0], quote: '财报原文'.repeat(500) };
  state.facts = spec.periods.flatMap(period => (['revenue', 'parent_net_profit', 'operating_cash_flow'] as const).map(metric => ({ ...report.facts[0], id: `${period.id}-${metric}`, period, metric, citations: [citation, citation] })));
  state.claims = spec.questions.map(q => ({ ...report.claims[0], id: q.id, questionId: q.id, text: '有依据的比较说明。'.repeat(300), factIds: [], citations: [citation, citation] }));
  state.observations = Array.from({ length: 8 }, (_, i) => ({ tool: 'read_evidence', key: String(i).padStart(64, '0'), summary: '原始文本'.repeat(1500) }));
  const original = JSON.stringify(state), view = financialContextState(state, true);
  const tools = financialResearchTools('context-fixture', { id: randomUUID(), taskId: report.taskId, worker: 'fixture', generation: 1, requestRevision: 1, planRevision: 1 }, spec, state, 'fixture', async () => {});
  const manager = new PiAgentContextManager({ contextWindowTokens: 128000, reservedOutputTokens: 6000, maxInputTokens: 32000 });
  const prepared = manager.prepare([{ role: 'system', content: financialResearchPrompt }, { role: 'user', content: JSON.stringify({ spec, checkpoint: view }) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'source', name: 'read_evidence', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'source', name: 'read_evidence', content: JSON.stringify({ ok: true, data: { text: '财报原始段落。'.repeat(700) } }) },
  ], tools, { inputBudgetTokens: 32000 });
  expect(prepared.estimate.preparedInputTokens).toBeLessThan(32000);
  expect(view.facts).toHaveLength(6); expect(view.claims).toHaveLength(3); expect(view.facts[0].citations[0].quoteTruncated).toBe(true);
  expect(JSON.stringify(state)).toBe(original);
});
