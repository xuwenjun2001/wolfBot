import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { chartPanelClientSource } from './scaffold-chart-panel';

const componentPath = 'app/components/ChartPanel.tsx';
const manifestPath = '.chart-panel-upgrade/manifest.json';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Only replace the recognizable platform K-line function, never unrelated chart-panel nodes. */
export function upgradeChartPage(page: string): string | null {
  if (page.includes("import ChartPanel from './components/ChartPanel'")) return page;
  const start = page.indexOf('function TrendChart({ bars }: { bars: JsonRecord[] }) {');
  const end = page.indexOf('\nfunction ', start + 1);
  if (start < 0 || end < 0 || !page.includes('data-source-file={DATA_FILE}') || !page.includes('<TrendChart bars={bars} />')) return null;
  const original = page.slice(start, end);
  if (!original.includes('K 线与量价结构') || !original.includes('visibleBars = bars.slice(-60)') || !original.includes('volume-chart') || original.includes('onPointer')) return null;
  let next = "import ChartPanel from './components/ChartPanel';\n" + page.slice(0, start) + page.slice(end);
  next = next.replace('  const bars = getBars(data);', "  const chartAsset = assets.find((asset) => getBars(asset).length > 0) ?? primaryAsset;\n  const chartKline = asRecord(chartAsset?.kline) ?? asRecord(chartAsset?.history);\n  const bars = getBars(chartAsset);");
  next = next.replace('<TrendChart bars={bars} />', "<ChartPanel bars={bars} symbol={String(chartKline?.secid ?? chartAsset?.symbol ?? quote?.symbol ?? '')} metadata={asRecord(chartKline?.metadata) ?? {}} source={String(chartKline?.source ?? '')} fetchedAt={String(chartKline?.fetched_at ?? '')} />");
  return next;
}

type SavedFile = { relative: string; before: string | null; afterHash: string };
type Manifest = { version: number; files: SavedFile[] };
export async function upgradeChartProject(root: string, apply = false, enrich = false) {
  const page = await fs.readFile(path.join(root, 'app/page.tsx'), 'utf8').catch(() => '');
  const next = upgradeChartPage(page);
  if (next === null) return { project: path.basename(root), status: 'skipped-custom-or-other-template' };
  if (!apply) return { project: path.basename(root), status: next === page ? 'already-upgraded' : 'ready' };
  const oldManifest = await fs.readFile(path.join(root, manifestPath), 'utf8').then(s => JSON.parse(s) as Manifest).catch(() => null);
  const manifest: Manifest = oldManifest ?? { version: 1, files: [] };
  async function write(relative: string, content: string) {
    const absolute = path.join(root, relative);
    const before = await fs.readFile(absolute, 'utf8').catch(() => null);
    if (before === content) return;
    const saved = manifest.files.find(f => f.relative === relative);
    if (saved && before !== null && hash(before) !== saved.afterHash) throw new Error('升级后文件已修改，保留用户修改：' + absolute);
    if (saved) saved.afterHash = hash(content);
    else manifest.files.push({ relative, before, afterHash: hash(content) });
    // Persist recovery information before every mutation.
    await fs.mkdir(path.dirname(path.join(root, manifestPath)), { recursive: true });
    await fs.writeFile(path.join(root, manifestPath), JSON.stringify(manifest, null, 2), 'utf8');
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  await write(componentPath, chartPanelClientSource);
  await write('app/page.tsx', next);
  const warnings: string[] = [];
  if (enrich) {
    const dataPath = 'data_file/final/dashboard-data.json';
    const content = await fs.readFile(path.join(root, dataPath), 'utf8').catch(() => null);
    if (content) {
      const data = JSON.parse(content);
      const assets = Array.isArray(data.assets) ? data.assets : [data];
      const evidence: object[] = [];
      for (const asset of assets) {
        const kline = asset.kline ?? asset.history;
        if (!Array.isArray(kline?.bars) || !kline.bars.length) continue;
        if (kline.metadata?.chartDataVersion === 1 && kline.bars.every((b: Record<string, unknown>) => b.amount != null)) continue;
        try {
          const symbol = kline.secid ?? asset.symbol;
          const end = String(kline.bars.at(-1).date).slice(0, 10).replaceAll('-', '');
          const base = process.env.QUANTPILOT_MARKET_API_URL || 'http://127.0.0.1:8000';
          const url = new URL('/api/v1/quotes/history/' + encodeURIComponent(symbol), base);
          url.search = new URLSearchParams({ period: 'daily', adjustment: kline.adjustment ?? 'qfq', limit: String(Math.min(1000, kline.bars.length + 1)), end, enrich_amount: 'true' }).toString();
          const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const extra = await response.json();
          if (extra.secid !== kline.secid || !Array.isArray(extra.bars) || extra.metadata?.chartDataVersion !== 1) throw new Error('成交额补全接口或标的校验未通过');
          const rows = new Map<string, Record<string, unknown>>(extra.bars.map((b: Record<string, unknown>) => [String(b.date), b]));
          for (const bar of kline.bars) {
            const other = rows.get(String(bar.date));
            if (!other) continue;
            const meta = other.metadata as Record<string, unknown> | undefined;
            bar.metadata = { ...bar.metadata, previousTradeDate: meta?.previousTradeDate ?? null };
            if (bar.amount == null && other.amount != null) {
              bar.amount = other.amount;
              bar.metadata.amountEvidence = meta?.amountEvidence ?? { source: extra.source, fetchedAt: extra.fetched_at };
            }
          }
          kline.metadata = { ...kline.metadata, chartDataVersion: 1,
            volumeUnit: kline.metadata?.volumeUnit ?? extra.metadata.volumeUnit,
            amountEnrichmentVersion: extra.metadata.amountEnrichmentVersion,
            amountSources: [...new Set(kline.bars.filter((b: Record<string, unknown>) => b.amount != null).map((b: { metadata?: { amountEvidence?: { source?: string } } }) => b.metadata?.amountEvidence?.source ?? kline.source))],
            amountUnit: '元', chartWarnings: extra.metadata.chartWarnings,
            amountCoverage: kline.bars.filter((b: Record<string, unknown>) => b.amount != null).length };
          if (kline.metadata.amountCoverage < kline.bars.length) warnings.push(String(symbol) + ' 成交额覆盖 ' + kline.metadata.amountCoverage + '/' + kline.bars.length + '，缺失值保持为空');
          evidence.push({ symbol, fetchedAt: extra.fetched_at, metadata: kline.metadata, bars: kline.bars.map((b: Record<string, unknown>) => ({ date: b.date, amount: b.amount, metadata: b.metadata })) });
        } catch (error) { warnings.push(String(error)); }
      }
      if (evidence.length) {
        await write('evidence/chart-amount-enrichment.json', JSON.stringify({ version: 1, assets: evidence }, null, 2));
        await write(dataPath, JSON.stringify(data, null, 2));
      }
    }
  }
  return { project: path.basename(root), status: 'upgraded', warnings };
}

export async function rollbackChartProject(root: string) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, manifestPath), 'utf8')) as Manifest;
  for (const file of manifest.files) {
    if (path.isAbsolute(file.relative) || file.relative.split(/[\\/]/).includes('..')) throw new Error('Invalid backup path');
    const current = await fs.readFile(path.join(root, file.relative), 'utf8').catch(() => null);
    if (current !== file.before && (current === null || hash(current) !== file.afterHash)) throw new Error('升级后文件已修改，取消回滚：' + file.relative);
  }
  for (const file of [...manifest.files].reverse()) {
    const target = path.join(root, file.relative);
    if (file.before === null) await fs.rm(target, { force: true });
    else await fs.writeFile(target, file.before, 'utf8');
  }
  await fs.rm(path.join(root, manifestPath));
  return { project: path.basename(root), status: 'rolled-back' };
}
