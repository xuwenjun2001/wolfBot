import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PiAgentTool, PiAgentToolContext } from '@/lib/agent/types';
import { createQueryJsonTool } from '@/lib/agent/tools';

import {
  createFinancePiAgentTools,
  FINANCE_FINAL_DASHBOARD_MAX_BYTES,
} from './factory';

const context: PiAgentToolContext = {
  runId: 'run-finance-factory',
  turn: 1,
  toolCallId: 'call-finance-factory',
  operationId: 'op_finance_factory',
  signal: new AbortController().signal,
};

async function invoke(tool: PiAgentTool, input: unknown) {
  const parsed = tool.parseInput ? tool.parseInput(input) : input;
  return tool.execute(parsed, context);
}

describe('Finance PI Agent tool factory', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-agent-tools-'));
    await fs.mkdir(path.join(workspace, 'data_file', 'final'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'app'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('raises only the Finance JSON input ceiling while preserving source and output limits', async () => {
    const largeValue = 'x'.repeat(1_100_000);
    await fs.writeFile(
      path.join(workspace, 'data_file', 'final', 'dashboard-data.json'),
      JSON.stringify({ marker: 'finance-dashboard', payload: largeValue }),
      'utf8',
    );
    await fs.writeFile(
      path.join(workspace, 'app', 'page.tsx'),
      `export const payload = '${largeValue}';\n`,
      'utf8',
    );

    const genericResult = await invoke(createQueryJsonTool({ workspaceRoot: workspace }), {
      path: 'data_file/final/dashboard-data.json',
      pointers: ['/marker'],
    });
    expect(genericResult).toMatchObject({
      ok: false,
      error: { code: 'FILE_TOO_LARGE' },
    });

    const tools = createFinancePiAgentTools({
      workspaceRoot: workspace,
      maxOutputChars: 2_000,
      includeQuantApi: false,
      includeDashboardInspector: false,
      includeImageExtraction: false,
    });
    const queryJson = tools.find((tool) => tool.name === 'query_json')!;
    const queryText = tools.find((tool) => tool.name === 'query_text_file')!;
    const financeResult = await invoke(queryJson, {
      artifact: 'final_dashboard',
      pointers: ['/marker', '/payload'],
    });

    expect(FINANCE_FINAL_DASHBOARD_MAX_BYTES).toBe(2_000_000);
    expect(financeResult).toMatchObject({
      ok: true,
      data: { path: 'data_file/final/dashboard-data.json', truncated: true },
    });
    expect(financeResult.content?.length).toBeLessThanOrEqual(2_000);
    await expect(invoke(queryText, {
      path: 'app/page.tsx',
      anchors: ['export const payload'],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'FILE_TOO_LARGE' },
    });
  });
});
