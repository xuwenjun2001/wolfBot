export function researchConfig() {
  const integer = (name: string, fallback: number, max: number) => {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid research configuration: ${name}`);
    return n;
  };
  const baseUrl = (process.env.COMPANY_RESEARCH_BASE_URL || 'https://sub2api.380001.xyz/v1').replace(/\/$/, '');
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('Research model gateway requires HTTPS');
  const reasoning = process.env.COMPANY_RESEARCH_REASONING || 'max';
  if (reasoning !== 'max') throw new Error('Company research requires the configured max reasoning effort');
  return {
    baseUrl, model: process.env.COMPANY_RESEARCH_MODEL || 'gpt-5.6-luna', reasoning: 'max' as const,
    apiKey: process.env.COMPANY_RESEARCH_API_KEY || '',
    searchApiKey: process.env.COMPANY_RESEARCH_SEARCH_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    maxCalls: integer('COMPANY_RESEARCH_MAX_CALLS', 40, 100),
    timeoutMs: integer('COMPANY_RESEARCH_TIMEOUT_MS', 1200000, 3600000),
  };
}
export function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : '研究执行失败';
  for (const key of [process.env.COMPANY_RESEARCH_API_KEY, process.env.COMPANY_RESEARCH_SEARCH_API_KEY, process.env.DEEPSEEK_API_KEY]) if (key) message = message.replaceAll(key, '[redacted]');
  return message.replace(/(?:sk-|tvly-)[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 400);
}
