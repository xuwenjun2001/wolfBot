import type { TSchema } from '@earendil-works/pi-ai';
import type { PiAgentTool, PiAgentToolCall, PiAgentToolResult } from '@/lib/agent/types';
import { allowedNow } from './budget-policy';

export const financialBatchHardLimit = 8;
export const financialBatchDefaultLimit = 3;
const stateTools = new Set(['record_fact', 'record_claim', 'complete_comparison', 'verify_claim', 'check_coverage', 'submit_report', 'import_filing', 'parse_document']);
export type ValidatedFinancialCall = { id: string; name: string; input: Record<string, unknown> };
type BatchPolicy = { maxToolCallsPerTurn: number; remaining: number; reserve: number };

export function financialBatchLimit(requested?: number, bound?: number): number {
  for (const value of [requested, bound]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > financialBatchHardLimit)) throw new Error('FINANCIAL_BATCH_LIMIT_INVALID');
  if (requested !== undefined && bound !== undefined && requested !== bound) throw new Error('FINANCIAL_BATCH_LIMIT_MISMATCH');
  return bound ?? requested ?? financialBatchDefaultLimit;
}

/** Preflight the complete turn without executing tools or changing research state. */
export async function validateFinancialBatch(calls: readonly PiAgentToolCall[], tools: readonly PiAgentTool[], policy: BatchPolicy): Promise<PiAgentToolResult<ValidatedFinancialCall[]>> {
  const max = financialBatchLimit(policy.maxToolCallsPerTurn);
  const denied = (code: string, message: string, index?: number): PiAgentToolResult<ValidatedFinancialCall[]> => ({ ok: false,
    error: { code, message, details: { maxToolCallsPerTurn: max, remaining: policy.remaining, reserve: policy.reserve, ...(index === undefined ? {} : { index }), charged: false } } });
  if (![policy.remaining, policy.reserve].every(value => Number.isSafeInteger(value) && value >= 0)) return denied('FINANCIAL_BATCH_BUDGET_INVALID', '批量预算状态无效；整轮未执行、未扣减');
  if (calls.length > max) return denied('FINANCIAL_BATCH_LIMIT', `每轮最多 ${max} 个工具；拆分批次后重试，整轮未执行、未扣减`);
  if (new Set(calls.map(call => call.id)).size !== calls.length) return denied('FINANCIAL_BATCH_DUPLICATE_ID', '同轮工具 id 必须唯一；整轮未执行、未扣减');
  if (calls.length > policy.remaining) return denied('FINANCIAL_BATCH_BUDGET', '批次数量超过剩余工具预算；整轮未执行、未扣减');
  const definitions = new Map(tools.map(tool => [tool.name, tool]));
  const mutations = calls.map((call, index) => stateTools.has(call.name) ? index : -1).filter(index => index >= 0);
  if (mutations.length > 1) return denied('FINANCIAL_BATCH_STATE_COUNT', '同一轮最多一个状态工具；整轮未执行、未扣减');
  if (mutations.length === 1 && mutations[0] !== calls.length - 1) return denied('FINANCIAL_BATCH_STATE_ORDER', '状态工具必须排在所有只读工具之后；整轮未执行、未扣减');
  if (calls.length > 1 && calls.some(call => call.name === 'submit_report' || definitions.get(call.name)?.terminal)) return denied('FINANCIAL_BATCH_TERMINAL_EXCLUSIVE', 'submit_report 必须独占一轮；整轮未执行、未扣减');

  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const validated: ValidatedFinancialCall[] = [];
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index], tool = definitions.get(call.name);
    if (!call.id || call.id.trim() !== call.id || call.id.length > 512 || /[\p{C}]/u.test(call.id)) return denied('FINANCIAL_BATCH_CALL_ID', '工具 id 无效；整轮未执行、未扣减', index);
    if (!tool) return denied('FINANCIAL_BATCH_UNKNOWN_TOOL', '批次包含未注册工具；整轮未执行、未扣减', index);
    if (!allowedNow(call.name, policy.remaining - index, policy.reserve)) return denied('FINANCIAL_BATCH_CLOSURE_RESERVED', '该批次会占用核验或收尾预留；缩短批次，整轮未执行、未扣减', index);
    try {
      const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Object arguments required');
      // Reuse the same schema conversion/validation as PI, on detached JSON input.
      const input: unknown = validateToolArguments({ name: tool.name, description: tool.description, parameters: tool.inputSchema as TSchema },
        { type: 'toolCall', id: call.id, name: call.name, arguments: parsed as Record<string, unknown> });
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Object arguments required');
      validated.push({ id: call.id, name: call.name, input: input as Record<string, unknown> });
    } catch {
      return denied('FINANCIAL_BATCH_ARGUMENTS', '批次参数未通过工具 schema；修正后重试，整轮未执行、未扣减', index);
    }
  }
  return { ok: true, data: validated };
}
