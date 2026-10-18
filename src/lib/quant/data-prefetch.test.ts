import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuantRunPlan } from '@/lib/domains/finance/workspace';
import {
  createQuantPilotDataAgentRegistry,
  QUANTPILOT_AGENT_PROFILE_ID,
} from '@/lib/domains/finance';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  buildFundamentalMetricComparison,
  buildKlineFromTechnicalIndicators,
  hasExplicitTradingPlanIntent,
  inferHistoryLimit,
  isBroadStockScreenerPlan,
  prefetchQuantDataForRunPlan,
} from './data-prefetch';

type JsonRecord = Record<string, unknown>;

const temporaryProjects: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true })
    )
  );
});

describe('quant trading-plan intent', () => {
  it.each([
    '帮我推荐6月3日要买的股票，给我推荐10个',
    '我准备买几只股票，给出研究计划',
    '给我一个明确的买入区间和止损',
  ])('recognizes explicit execution intent: %s', (question) => {
    expect(hasExplicitTradingPlanIntent(question)).toBe(true);
  });

  it('does not add an execution plan to a neutral comparison request', () => {
    expect(hasExplicitTradingPlanIntent('比较贵州茅台和宁德时代的财务质量')).toBe(false);
  });
});

describe('quant data-prefetch symbol candidates', () => {
  it('treats an explicit sector discovery request as a broad stock screener', () => {
    expect(
      isBroadStockScreenerPlan({
        question: '液冷板块里有哪些值得关注的股票',
        dataRequirements: ['GET /api/v1/fundamentals/financials/{symbol}'],
        queryRewrite: { broadUniverse: true },
      } as unknown as QuantRunPlan),
    ).toBe(true);

    expect(
      isBroadStockScreenerPlan({
        question: '有哪些股票值得关注',
        dataRequirements: [],
        queryRewrite: { broadUniverse: false },
      } as unknown as QuantRunPlan),
    ).toBe(false);
  });

  it('builds a selected-period cash-flow versus net-profit comparison from stable or raw API fields', () => {
    expect(buildFundamentalMetricComparison({
      symbol: '600111',
      reports: [
        {
          symbol: '600111',
          report_date: '2025-12-31T00:00:00Z',
          data_type: '2025年 年报',
          net_profit_yoy: 124.17,
          raw: { MGJYXJJE: 0.3084 },
        },
        {
          symbol: '600111',
          report_date: '2024-12-31T00:00:00Z',
          data_type: '2024年 年报',
          raw: { MGJYXJJE: 0.2837 },
        },
      ],
    }, '2025年年报')).toMatchObject({
      reporting_period: '2025年 年报',
      operating_cash_flow_per_share_yoy: 8.71,
      net_profit_yoy: 124.17,
      cash_flow_outpaced_net_profit: false,
      conclusion: '每股经营现金流增速未跑赢净利润增速。',
    });
  });

  it('allocates a half-year sample for anchored half-year rewrites', () => {
    expect(inferHistoryLimit({
      timeRange: '去年下半年',
      question: '比较北方稀土和宁德时代',
    } as QuantRunPlan)).toBe(126);
  });

  it('does not parse symbols from the question after Query Rewrite has produced the run plan', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-prefetch-symbol-'));
    temporaryProjects.push(projectPath);
    await fs.mkdir(path.join(projectPath, '.data-agent'), { recursive: true });

    const now = '2026-07-15T02:29:30.000Z';
    const plan: QuantRunPlan = {
      schemaVersion: 1,
      runId: 'conversational-symbol-prefetch',
      status: 'planned',
      capabilityId: 'stock_diagnosis',
      composition: createQuantPilotDataAgentRegistry().resolveCapability(
        QUANTPILOT_AGENT_PROFILE_ID,
        'stock_diagnosis',
      ).composition,
      llm: getProjectLlmConfig(),
      requestedCapabilityId: 'stock_diagnosis',
      executionCapabilityId: 'stock_diagnosis',
      question: '帮我分析一下大位科技',
      symbols: [],
      timeRange: '最近 120 个交易日',
      dataRequirements: [],
      analysisSteps: [],
      visualization: {
        required: true,
        templateId: 'single-stock-diagnosis',
        matchReasons: ['命中问题关键词：股票'],
        panels: [],
      },
      expectedArtifacts: [],
      validationRules: [],
      createdAt: now,
      updatedAt: now,
    };
    await fs.writeFile(
      path.join(projectPath, '.data-agent', 'finance-run-plan.json'),
      `${JSON.stringify(plan, null, 2)}\n`,
      'utf8'
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await prefetchQuantDataForRunPlan({ projectPath, plan });

    expect(result).toMatchObject({ skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('quant data-prefetch history resilience', () => {
  it('builds an auditable K-line fallback from real technical indicator points', () => {
    const technicalIndicators = {
      symbol: '600664',
      name: '哈药股份',
      secid: '1.600664',
      source: 'tencent',
      period: 'daily',
      adjustment: 'qfq',
      as_of: '2026-09-03',
      fetched_at: '2026-09-03T12:00:00.000Z',
      points: [
        {
          date: '2026-08-06',
          open: '6.85',
          close: '6.22',
          high: '6.92',
          low: '6.10',
          volume: 5_322_894,
        },
      ],
    };

    expect(buildKlineFromTechnicalIndicators({
      symbol: '600664',
      technicalIndicators,
      reason: 'This operation was aborted',
    })).toMatchObject({
      symbol: '600664',
      source: 'tencent',
      period: 'daily',
      adjustment: 'qfq',
      bars: [{
        date: '2026-08-06',
        open: '6.85',
        close: '6.22',
        high: '6.92',
        low: '6.10',
        volume: 5_322_894,
      }],
      metadata: {
        data_basis: 'technical_indicators_points',
        fallback: {
          source_endpoint: '/api/v1/indicators/technical/600664',
          reason: 'This operation was aborted',
        },
      },
      data_quality: {
        status: 'warning',
      },
    });
  });

  it('retries an aborted history request before accepting the response', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-prefetch-retry-'));
    temporaryProjects.push(projectPath);
    await fs.mkdir(path.join(projectPath, '.data-agent'), { recursive: true });

    const now = '2026-09-03T12:00:00.000Z';
    const bars = Array.from({ length: 20 }, (_, index) => ({
      date: `2026-08-${String(index + 6).padStart(2, '0')}`,
      open: String(10 + index),
      close: String(10 + index),
      high: String(10.5 + index),
      low: String(9.5 + index),
      volume: 1_000 + index,
    }));
    const plan: QuantRunPlan = {
      schemaVersion: 1,
      runId: 'history-retry',
      status: 'planned',
      capabilityId: 'technical_analysis',
      composition: createQuantPilotDataAgentRegistry().resolveCapability(
        QUANTPILOT_AGENT_PROFILE_ID,
        'technical_analysis',
      ).composition,
      llm: getProjectLlmConfig(),
      requestedCapabilityId: 'technical_analysis',
      executionCapabilityId: 'technical_analysis',
      question: '分析哈药股份最近20个交易日走势',
      symbols: ['600664'],
      timeRange: '最近20个交易日',
      dataRequirements: [
        'GET /api/v1/quotes/history/{symbol}',
        'GET /api/v1/indicators/technical/{symbol}',
      ],
      analysisSteps: [],
      visualization: {
        required: true,
        templateId: 'single-stock-diagnosis',
        variantId: 'single-stock-command-center',
        matchReasons: ['test'],
        panels: [],
      },
      expectedArtifacts: [],
      validationRules: [],
      createdAt: now,
      updatedAt: now,
    };
    await fs.writeFile(
      path.join(projectPath, '.data-agent', 'finance-run-plan.json'),
      `${JSON.stringify(plan, null, 2)}\n`,
      'utf8',
    );

    let historyCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const endpoint = String(input);
      if (endpoint.includes('/quotes/realtime/')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            symbol: '600664',
            name: '哈药股份',
            asset_type: 'stock',
            market: 'SH',
            source: 'eastmoney',
            price: '29',
            quote_time: now,
            fetched_at: now,
          }),
        };
      }
      if (endpoint.includes('/quotes/history/')) {
        historyCalls += 1;
        if (historyCalls === 1) {
          throw new Error('This operation was aborted');
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            symbol: '600664',
            name: '哈药股份',
            secid: '1.600664',
            source: 'tencent',
            period: 'daily',
            adjustment: 'qfq',
            bars,
            as_of: bars.at(-1)?.date,
            fetched_at: now,
          }),
        };
      }
      if (endpoint.includes('/indicators/technical/')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            symbol: '600664',
            name: '哈药股份',
            secid: '1.600664',
            source: 'tencent',
            period: 'daily',
            adjustment: 'qfq',
            points: bars.map((bar, index) => ({
              date: bar.date,
              close: bar.close,
              volume: bar.volume,
              ma5: index >= 4 ? '27' : null,
              ma10: index >= 9 ? '25' : null,
              ma20: index >= 19 ? '20' : null,
              ma60: null,
            })),
            summary: {
              latest_close: '29',
              ma5: '27',
              ma10: '25',
              ma20: '20',
              max_drawdown_pct: '0',
              volatility_annualized_pct: '0',
              avg_volume20: '1010',
            },
            as_of: bars.at(-1)?.date,
            fetched_at: now,
          }),
        };
      }
      throw new Error(`unexpected endpoint: ${endpoint}`);
    }));

    const result = await prefetchQuantDataForRunPlan({ projectPath, plan });
    const finalData = JSON.parse(
      await fs.readFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'), 'utf8'),
    ) as JsonRecord;
    const quality = JSON.parse(
      await fs.readFile(path.join(projectPath, 'evidence', 'data_quality.json'), 'utf8'),
    ) as JsonRecord;

    expect(result).toMatchObject({ skipped: false, status: 'completed' });
    expect(historyCalls).toBe(2);
    expect((finalData.kline as JsonRecord).bars).toHaveLength(20);
    expect(quality.status).toBe('warning');
  });
});
