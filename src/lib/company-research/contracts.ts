import { z } from 'zod';

// Versioned financial-change contracts coexist with the existing report shape.
export * from './task-contracts';
export * from './document-contracts';
export * from './revision-contracts';

export const sectionKeys = ['business', 'supplyChain', 'financials'] as const;
export type SectionKey = typeof sectionKeys[number];
export const sectionLabels: Record<SectionKey, string> = { business: '主营业务', supplyChain: '上下游产业链', financials: '近期财报' };
export type ResearchStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export const terminalStatuses: string[] = ['completed', 'partial', 'failed', 'cancelled'];
export interface Company { symbol: string; name: string }
export const aShareSymbolPattern = /^(?:[03468]\d{5}|92\d{4})(?:\.(?:SH|SZ|BJ))?$/;
export interface Source {
  id: string; url: string; title: string; publishedAt: string | null; fetchedAt: string;
  content: string; hash: string; kind: 'web' | 'financials';
}
export const citationSchema = z.object({ sourceId: z.string().max(80), quote: z.string().min(8).max(1200), locator: z.string().max(160) });
export const claimSchema = z.object({ text: z.string().min(1).max(2000), kind: z.enum(['fact', 'opinion', 'inference']), citations: z.array(citationSchema).min(1).max(6) });
const sectionSchema = z.object({ claims: z.array(claimSchema).max(15), gaps: z.array(z.string().max(500)).max(10) });
export const reportSchema = z.object({
  overview: z.string().min(1).max(1200),
  business: sectionSchema, supplyChain: sectionSchema, financials: sectionSchema,
  metrics: z.array(z.object({ label: z.string().max(80), value: z.string().max(120), period: z.string().min(1).max(80), basis: z.string().min(1).max(100), yoy: z.string().max(100), citation: citationSchema })).max(16),
  limitations: z.array(z.string().max(600)).max(15),
});
export type ResearchReport = z.infer<typeof reportSchema>;
export interface ResearchState {
  latestReportDate?: string;
  version?: 2; phase?: "investigating" | "finalizing"; deadline?: number; stopReason?: string;
  evidence?: Record<string, import("./ledger").Evidence>; sections?: Record<string, string[]>;
  searchHistory?: Record<string, import("./discovery").SearchRecord>; reads?: Record<string, boolean>;
  filings?: import("./discovery").Filing[]; systemEvents?: { id: string; at: string; message: string }[];
  company: Company; asOf: string; sources: Source[]; draft: ResearchReport | null;
  supplementRounds: number; coverageChecks: number; lastCoverageHash: string | null;
  toolCalls: number; inputTokens: number; outputTokens: number; submitted: boolean;
  notes: string[];
  discoveries?: Record<string, { title: string; publishedAt: string | null }>;
  consecutiveSearches?: number;
  lastCoverageEvidenceHash?: string;
  sourceFocus?: Record<string, string[]>;
  pendingUsage?: { input: number; output: number };
  usageEstimated?: boolean;
}
export interface TraceStep {
  number: number; tool: string; title: string; status: 'running' | 'completed' | 'failed';
  input: Record<string, unknown>; summary: string; startedAt: string; finishedAt?: string;
  durationMs?: number; retryOf?: number;
}
export interface PublicRun {
  phase?: "investigating" | "finalizing"; deadline?: number; stopReason?: string;
  coverage?: { complete: boolean; gaps: string[]; questions?: { id: string; label: string; required: boolean; status: string }[] }; systemEvents?: { id: string; at: string; message: string }[];
  id: string; company: Company; asOf: string; status: ResearchStatus;
  createdAt: string; startedAt: string | null; finishedAt: string | null; error: string | null;
  steps: TraceStep[]; report: ResearchReport | null;
  sources: Omit<Source, 'content'>[]; usage: { inputTokens: number; outputTokens: number };
}
export function emptyReport(reason: string): ResearchReport {
  const section = () => ({ claims: [], gaps: [reason] });
  return { overview: '研究未完成，以下列出已取得的资料与尚待核实的问题。', business: section(), supplyChain: section(), financials: section(), metrics: [], limitations: [reason] };
}
