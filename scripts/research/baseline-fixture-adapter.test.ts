import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { installFixtureTransport } from './baseline-fixture-adapter';

test('legacy fixture transport never exposes reference answers as provider financial data', async () => {
  const parent = path.resolve('data/research-agent-upgrade/evidence/U04/engineering-20261026/evaluation/test-workspaces');
  await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'transport-'));
  await writeFile(path.join(directory, 'document.txt'), 'SYNTHETIC ORIGINAL DOCUMENT TEXT; NO EVALUATION ANSWERS');
  const sample = { company: { symbol: '600519.SH', name: 'Synthetic test' },
    get reference(): never { throw new Error('Evaluation reference accessed by execution transport'); } };
  const doc = { id: 'synthetic', symbol: sample.company.symbol, title: 'Synthetic source', path: path.join(directory, 'document.pdf'),
    url: 'https://example.com/synthetic.pdf', period: { end: '2024-12-31' }, disclosedOn: '2025-04-01' };
  const restore = await installFixtureTransport(sample, [doc], () => { throw new Error('No gateway call authorized'); });
  try {
    const response = await fetch('http://research-fixture.invalid/financials/600519.SH');
    const data = await response.json();
    assert.equal(data.reports[0].parent_net_profit, null); assert.equal(data.reports[0].net_profit_yoy, null);
    const original = await fetch('https://api.deepseek.com/v1/tools/fetch', { method: 'POST', body: JSON.stringify({ url: doc.url }) });
    assert.equal((await original.json()).content, 'SYNTHETIC ORIGINAL DOCUMENT TEXT; NO EVALUATION ANSWERS');
    await assert.rejects(fetch('https://example.com/unregistered'), /BASELINE_UNRECORDED_REQUEST/);
  } finally { restore(); }
});
