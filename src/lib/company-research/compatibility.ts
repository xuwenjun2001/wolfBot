import { z } from 'zod';
import { aShareSymbolPattern, reportSchema } from './contracts';
import { researchTaskSpecSchema } from './task-contracts';
import { researchReportRevisionSchema } from './revision-contracts';

const legacyRequestSchema = z.object({ symbol: z.string().regex(aShareSymbolPattern) }).strict();
export function readResearchRequest(input: unknown) {
  if (input && typeof input === 'object' && 'schemaVersion' in input) return { format: 'financial_change_v1' as const, spec: researchTaskSpecSchema.parse(input) };
  return { format: 'legacy' as const, request: legacyRequestSchema.parse(input) };
}
export function readResearchReport(input: unknown) {
  if (input && typeof input === 'object' && 'schemaVersion' in input) return { format: 'financial_change_v1' as const, report: researchReportRevisionSchema.parse(input) };
  return { format: 'legacy' as const, report: reportSchema.parse(input) };
}
