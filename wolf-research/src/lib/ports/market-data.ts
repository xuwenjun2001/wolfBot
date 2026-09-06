import type { OperationContext } from './context';

export interface MarketDataPort {
  resolveSymbols(input: unknown, ctx: OperationContext): Promise<unknown>;
  getRealtimeQuote(symbol: string, ctx: OperationContext): Promise<unknown>;
  getHistory(input: unknown, ctx: OperationContext): Promise<unknown>;
  getTechnicalIndicators(input: unknown, ctx: OperationContext): Promise<unknown>;
  getFinancials(input: unknown, ctx: OperationContext): Promise<unknown>;
  getAnnouncements(input: unknown, ctx: OperationContext): Promise<unknown>;
  runMaCrossover(input: unknown, ctx: OperationContext): Promise<unknown>;
  screenShortTermCandidates(input: unknown, ctx: OperationContext): Promise<unknown>;
}
