import { z } from "zod";

export type ReviewRow = {
  event_id: string;
  symbol: string;
  name: string;
  breakout_date: string;
  trade_date: string;
  horizon: number;
  origin: string;
  config_version: number;
  status: string;
  reason: string;
  reference_price: number | null;
  original_reference_price: number | null;
  close: number | null;
  return_pct: number | null;
  high_pct: number | null;
  low_pct: number | null;
  signal: string;
  first_pullback_date: string | null;
};
export type ReviewStats = {
  horizon: number;
  total: number;
  valid: number;
  wins: number;
  losses: number;
  flat: number;
  win_rate: number | null;
  mean: number | null;
  median: number | null;
  mean_win: number | null;
  mean_loss: number | null;
  pending: number;
  suspended: number;
  gaps: number;
};
export type ReportSummary = {
  id: string;
  trade_date: string;
  revision: number;
  summary: string;
  model: string;
  effort: string;
  prompt_version: number;
  knowledge_enabled: boolean;
  created_at: string;
};
export type ReportDetail = ReportSummary & {
  content: {
    summary: string;
    sections: {
      title: string;
      content: string;
      event_ids: string[];
      citations: string[];
      rule_tags: string[];
    }[];
  };
  input: {
    knowledge: {
      id: string;
      report_id: string;
      content: string;
      reason: string;
      trade_date: string;
    }[];
  };
  messages: { role: string; content: string }[];
  usage: Record<string, unknown>;
  duration_seconds: number;
  response_model: string;
};
export type ReviewDashboard = {
  trade_date: string;
  start: string;
  end: string;
  rows: ReviewRow[];
  statistics: ReviewStats[];
  sample_count: number;
  versions: number[];
  reports: ReportSummary[];
  jobs: {
    id: string;
    kind: string;
    trade_date: string;
    status: string;
    error: string | null;
  }[];
  settings: { enabled: boolean; start_time: string; version: number };
  prompts: {
    version: number;
    content: string;
    actor: string;
    created_at: string;
  }[];
  system_prompt: string;
};
const day = z.string().date();
export const reviewMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), day: day.optional() }).strict(),
  z.object({ action: z.literal("regenerate"), day }).strict(),
  z
    .object({
      action: z.literal("prompt"),
      content: z.string().trim().min(1).max(20000),
      expected_version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("schedule"),
      enabled: z.boolean(),
      start_time: z.string().regex(/^(1[5-9]|2[01]):[0-5][0-9]$/),
      expected_version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("knowledge"),
      report_id: z.string().uuid(),
      enabled: z.boolean(),
    })
    .strict(),
]);
export type ReviewMutation = z.infer<typeof reviewMutationSchema>;
