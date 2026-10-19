import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EvaluationCase } from '../../src/lib/eval/financial-research-score';

export type FinancialEvaluationInput = Omit<EvaluationCase, 'reference'> & Partial<Pick<EvaluationCase, 'reference'>>;
const frozenTask = z.object({
  id: z.string().min(1), symbol: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/),
  documentIds: z.array(z.string().min(1)).length(2), asOf: z.iso.datetime({ offset: true }),
  questions: z.array(z.string().min(1)).length(3),
}); // Unknown fields, including unreviewed answers, are intentionally stripped.

export function controlledExternalRoot(repository: string, input: string) {
  assert(input, 'Explicit controlled external holdout required');
  const root = realpathSync(repository), external = realpathSync(path.resolve(input));
  const relative = path.relative(root, external);
  assert(relative && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)), 'Controlled external holdout required');
  return external;
}

export function normalizeHoldoutTasks(raw: unknown, documents: { id: string; symbol: string; companyName?: string }[]): FinancialEvaluationInput[] {
  return z.array(frozenTask).length(2).parse(raw).map(task => {
    const selected = documents.filter(document => task.documentIds.includes(document.id));
    assert.equal(selected.length, 2, 'Two registered documents required');
    assert(selected.every(document => document.symbol === task.symbol), 'Holdout company/document mismatch');
    const name = selected[0].companyName;
    assert(name && selected.every(document => document.companyName === name), 'Consistent registered company name required');
    return { id: task.id, company: { symbol: task.symbol, name }, asOf: task.asOf,
      documentIds: task.documentIds, questions: task.questions.map((text, index) => ({ id: `q${index + 1}`, text })) };
  });
}
