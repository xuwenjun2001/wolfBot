import { z } from "zod";

export const tacticParametersSchema = z
  .object({
    rule_set: z.enum(["daily_v1", "discussion_v2"]).optional(),
    change_pct: z.number().min(0.1).max(20).optional(),
    body_pct: z.number().min(0.1).max(20),
    volume_ratio: z.number().min(1).max(10),
    contraction_ratio: z.number().positive().max(1),
    distance_min_pct: z.number().min(-20).max(0),
    distance_max_pct: z.number().min(0).max(10),
  })
  .strict();
export type TacticParameters = z.infer<typeof tacticParametersSchema>;
export type TacticBar = {
  date: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  ma5?: number;
  ma10?: number;
  ma20?: number;
  ma55?: number;
  change_pct?: number | null;
};
export type TacticEvent = {
  id: string;
  symbol: string;
  name: string;
  breakout_date: string;
  expires_date: string;
  status: string;
  display_status?: string;
  signal: string;
  last_evaluated: string;
  config_version: number;
  evidence: {
    breakout: TacticBar & { prior_v5?: number };
    current?: TacticBar | null;
    distance_pct?: number;
    contraction_ratio?: number;
  };
  parameters: TacticParameters;
  bars?: TacticBar[];
  evaluations?: { trade_date: string; status: string; signal: string }[];
};
export type TacticAcquisition = {
  recorded: number;
  cached: number;
  incremental: number;
  full: number;
  fallback: number;
  fetched_stocks: number;
  requests: number;
  rows: number;
  gaps: number;
  fetch_seconds: number;
  wait_seconds: number;
  validation_seconds: number;
  cache_seconds: number;
  persist_seconds: number;
  prepare_seconds: number;
  average_fetch_seconds: number | null;
  fallback_reasons: Record<string, number>;
};
export type TacticRun = {
  acquisition?: TacticAcquisition | null;
  id: string;
  status: string;
  phase: string;
  trade_date: string | null;
  requested_date: string;
  total: number;
  processed: number;
  ready: number;
  excluded: number;
  gaps: number;
  error: string | null;
  created_at: string;
  next_attempt_at: string;
  config_version: number;
  summary: {
    new_breakouts?: number;
    pullbacks?: number;
    expired?: number;
    partial?: boolean;
  };
};
export type TacticGuide = {
  content: string;
  version: number;
  updated_by: string;
  updated_at: string;
};
export type TacticsDashboard = {
  guide: TacticGuide | null;
  config: {
    id: string;
    version: number;
    parameters: TacticParameters;
    updated_by: string;
  };
  runs: TacticRun[];
  events: TacticEvent[];
  total: number;
  page: number;
  universe_count: number;
  worker_online: boolean;
  latest_published: {
    id: string;
    trade_date: string;
    total: number;
    ready: number;
    excluded: number;
    gaps: number;
  } | null;
  published_gaps: { symbol: string; name: string; reason: string }[];
  runnable_trade_date: string | null;
  issues: { symbol: string; name: string; status: string; reason: string }[];
};
export const tacticMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("chart"),
      event_id: z.string().min(1).max(160),
      mode: z.enum(["daily", "session"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("guide"),
      content: z.string().trim().min(1).max(20000),
      expected_version: z.number().int().positive(),
    })
    .strict(),
  z.object({ action: z.literal("run") }).strict(),
  z
    .object({
      action: z.literal("configure"),
      parameters: tacticParametersSchema,
      expected_version: z.number().int().positive(),
    })
    .strict(),
  z.object({ action: z.literal("cancel"), run_id: z.string().uuid() }).strict(),
]);
