import { z } from 'zod';
export const sourceSelectionSchema = z.object({ reportRevision: z.number().int().min(0), claimId: z.string().max(100).optional(), factId: z.string().max(100).optional(), citationIndex: z.number().int().min(0).max(9) }).strict()
  .refine(s => Number(!!s.claimId) + Number(!!s.factId) === 1, 'Select one claim or fact');
export type SourceSelection = z.infer<typeof sourceSelectionSchema>;
export function safeResearchUrl(value: string): string | null {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null; } catch { return null; }
}
