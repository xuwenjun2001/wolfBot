import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { checkQuantArtifactPolicy } from './validation';
import { chartPanelClientSource } from '@/lib/utils/scaffold-chart-panel';

it('passes the platform ChartPanel through artifact policy while blocking other fetches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-market-policy-'));
  try {
    const files: Record<string, string> = {
      '.data-agent/finance-run-plan.json': '{}',
      'data_file/final/dashboard-data.json': '{}',
      'evidence/sources.json': '{}',
      'evidence/data_quality.json': '{}',
      'app/page.tsx': "const dataFile = 'data_file/final/dashboard-data.json';",
      'app/components/ChartPanel.tsx': chartPanelClientSource,
    };
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content);
    }
    expect(await checkQuantArtifactPolicy(root)).toMatchObject({ status: 'passed' });
    await fs.appendFile(path.join(root, 'app/components/ChartPanel.tsx'), '\nfetch(untrustedUrl);');
    expect(await checkQuantArtifactPolicy(root)).toMatchObject({
      status: 'failed',
      details: expect.stringContaining('非平台 market proxy'),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
