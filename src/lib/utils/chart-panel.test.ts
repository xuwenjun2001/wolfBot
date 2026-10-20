import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { chartPanelClientSource } from './scaffold-chart-panel';
import { rollbackChartProject, upgradeChartPage, upgradeChartProject } from './chart-panel-upgrade';

const compiled = ts.transpileModule(chartPanelClientSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const output = { exports: {} as { dailyPoints: (bars: Record<string, unknown>[], periods?: number[]) => Array<Record<string, unknown>> } };
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), output, output.exports);

describe('interactive chart data', () => {
  it('uses 233 full-history observations even for the first visible candle', async () => {
    const bars = Array.from({length: 320}, (_, i) => ({date: new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10), close:i+1}));
    const points = output.exports.dailyPoints(bars, [5,10,20,55,60,233]);
    expect(points).toHaveLength(60);
    expect((points[0].averages as number[])[5]).toBe(145);
    expect((points.at(-1)?.averages as number[])[5]).toBe(204);
    expect((output.exports.dailyPoints(bars.slice(0,232), [233]).at(-1)?.averages as unknown[])[0]).toBeNull();
    const shared = await fs.readFile('src/components/quant/PriceVolumeChart.tsx','utf8');
    expect(shared.replace(/\r\n?/g, '\n')).toBe('// Generated from scaffold-chart-panel.ts by sync-chart-panel.ts; edit the source template.\n' + chartPanelClientSource.replace(/\r\n?/g, '\n'));
  });
  it('uses full history for MA60 and the first visible daily comparison', () => {
    const bars = Array.from({ length: 65 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), close: i + 1, amount: (i + 1) * 100, metadata: { previousTradeDate: new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10) } }));
    const points = output.exports.dailyPoints(bars);
    expect(points).toHaveLength(60);
    expect(points[0].previous).toBe(500);
    expect(points[0].difference).toBe(100);
    expect(points.at(-1)?.averages).toEqual([63, 60.5, 55.5, 35.5]);
  });
  it('does not compare across an unverified day or treat missing amounts as zero', () => {
    const points = output.exports.dailyPoints([
      { date: '2026-09-01', close: 10, volume: 0, amount: 0 },
      { date: '2026-09-02', close: 11, amount: 100, metadata: { previousTradeDate: '2026-09-01' } },
      { date: '2026-09-04', close: 12, amount: 200, metadata: { previousTradeDate: '2026-09-03' } },
    ]);
    expect(points[0].volume).toBe(0);
    expect(points[1].difference).toBe(100);
    expect(points[1].changeAmountPct).toBeNull();
    expect(points[2].previous).toBeNull();
    expect(points[2].volume).toBeNull();
  });
});

const oldPage = `const DATA_FILE = 'data_file/final/dashboard-data.json';
function TrendChart({ bars }: { bars: JsonRecord[] }) {
  const visibleBars = bars.slice(-60);
  return <div className="chart-panel">K 线与量价结构<svg className="volume-chart" /></div>;
}
function OtherPanel() { return <div>custom text stays</div>; }
async function Home() {
  const bars = getBars(data);
  return <main data-source-file={DATA_FILE}><TrendChart bars={bars} /><OtherPanel /></main>;
}`;

describe('chart upgrade recovery', () => {
  it('skips unrelated or interactive custom charts', () => {
    expect(upgradeChartPage('<section className="chart-panel">custom chart</section>')).toBeNull();
    expect(upgradeChartPage(oldPage.replace('volume-chart', 'volume-chart onPointerMove'))).toBeNull();
  });
  it('preserves other content, is idempotent and rolls back byte-for-byte', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-chart-upgrade-'));
    try {
      await fs.mkdir(path.join(root, 'app'));
      await fs.writeFile(path.join(root, 'app/page.tsx'), oldPage);
      await upgradeChartProject(root, true);
      const first = await fs.readFile(path.join(root, 'app/page.tsx'), 'utf8');
      expect(first).toContain('custom text stays');
      await upgradeChartProject(root, true);
      expect(await fs.readFile(path.join(root, 'app/page.tsx'), 'utf8')).toBe(first);
      await rollbackChartProject(root);
      expect(await fs.readFile(path.join(root, 'app/page.tsx'), 'utf8')).toBe(oldPage);
      await expect(fs.stat(path.join(root, 'app/components/ChartPanel.tsx'))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
