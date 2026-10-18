/* Browser regression with intercepted fixtures; no fixture enters server storage. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const base = process.env.QUANTPILOT_VISUAL_BASE_URL || 'http://127.0.0.1:3001';
const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07'];
const times = [...Array.from({ length: 121 }, (_, i) => i + 570), ...Array.from({ length: 120 }, (_, i) => i + 781)]
  .map(m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
function metric(unit, scale) {
  return { currentDate: '2026-09-08', currentCutoff: '15:00', previousDate: dates.at(-1),
    sampleDates: dates, sampleCount: 5, unit, reason: null,
    previousStatus: { cutoff: '15:00', complete: true, reason: null, reasonCode: null },
    ma5Status: { cutoff: '15:00', complete: true, reason: null, reasonCode: null },
    rows: times.map((time, i) => {
      const current = (i + 1) * scale, previous = current * .9, ma5 = current * 1.1;
      return { time, current, previous, ma5, previousDifference: current - previous,
        previousChangePct: 100 / 9, ma5Difference: current - ma5, ma5ChangePct: -100 / 11 };
    }) };
}
function payload(resource) {
  const result = { resource, source: '验证数据', tradeDate: '2026-09-08', fetchedAt: '2026-09-08T07:00:00Z',
    status: 'available', stale: false, cacheHit: false, dateStatus: 'current', fallbackReason: null, note: '', rows: [] };
  if (['index-session', 'market-turnover'].includes(resource)) {
    result.metrics = { amount: metric('元', 8e9), volume: metric('手', 1e7) };
    result.previousClose = 4000;
    result.rows = times.map((time, i) => ({ time, price: 4000 + i / 2, changePct: i / 80, leadingPct: i / 100, leading: 4000 + i / 3 }));
  } else if (resource === 'index-breadth') {
    result.rows = [{ name: '沪市A股', up: 1200, down: 700, flat: 100, missing: 0 }];
  } else if (resource === 'overview') {
    result.rows = [{ code: 'sh000001', name: '上证指数', price: 4120, changePct: 3, amount: 9e11, quoteTime: '20260908150000' }];
  } else result.status = 'empty';
  return result;
}

(async () => {
  fs.mkdirSync('tmp/market-dashboard-qa', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
    page.on('pageerror', error => errors.push(error.message));
    let mode = 'normal', release;
    let gate = null;
    await page.route('**/api/quant/market-dashboard/**', async route => {
      const url = new URL(route.request().url()), resource = url.pathname.split('/').at(-1);
      let data = payload(resource);
      if (resource === 'market-turnover' && mode === 'deferred-failure') {
        await gate;
        data = { ...data, rows: [], metrics: undefined, status: 'unavailable', fetchedAt: '2026-09-08T08:00:00Z', fallbackReason: '数据源连接失败，稍后重试。' };
      }
      if (resource === 'index-session' && url.searchParams.get('index') === 'sz') {
        data.metrics = undefined; data.rows = []; data.status = 'unavailable';
      }
      if (mode === 'current-only' && data.metrics) {
        for (const value of Object.values(data.metrics)) {
          value.sampleCount = 0;
          value.previousStatus = { cutoff: null, complete: false, reason: '缺少上一交易日的连续分钟数据。', reasonCode: 'previous_missing' };
          value.ma5Status = { cutoff: null, complete: false, reason: '历史数据积累中，当前时点已具备 0/5 日。', reasonCode: 'history_incomplete' };
          for (const row of value.rows) for (const field of ['previous', 'ma5', 'previousDifference', 'previousChangePct', 'ma5Difference', 'ma5ChangePct']) row[field] = null;
        }
        data.status = 'partial';
      }
      await route.fulfill({ json: { success: true, data } });
    });
    await page.goto(`${base}/market-dashboard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const amount = page.getByRole('img', { name: /沪深合计成交额对比/ });
    await amount.waitFor({ timeout: 30000 });
    assert.equal(await amount.locator('polyline').count(), 3);
    await page.getByRole('group', { name: '沪深合计对比指标' }).getByRole('button', { name: '成交量', exact: true }).click();
    const volume = page.getByRole('img', { name: /沪深合计成交量对比/ });
    await volume.waitFor();
    const slider = page.getByRole('slider', { name: '沪深合计成交量对比查看时刻' });
    await slider.focus(); await slider.press('Home');
    assert.equal(await slider.inputValue(), '0');
    await slider.press('End');
    await page.screenshot({ path: 'tmp/market-dashboard-qa/desktop.png', fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: 'tmp/market-dashboard-qa/dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile must not overflow');
    await page.screenshot({ path: 'tmp/market-dashboard-qa/mobile.png', fullPage: true });

    gate = new Promise(resolve => { release = resolve; }); mode = 'deferred-failure';
    const request = page.waitForRequest(r => r.url().includes('/market-turnover'));
    await page.getByRole('button', { name: '刷新行情', exact: true }).click(); await request;
    assert.equal(await volume.count(), 1, 'refresh must keep the existing chart while waiting');
    release();
    await page.getByText('数据源连接失败，稍后重试。', { exact: true }).waitFor();
    assert.equal(await volume.count(), 1, 'HTTP 200 unavailable must retain the chart');
    assert.ok((await page.locator('main').innerText()).includes('15:00:00'), 'retain the old fetched timestamp');
    await page.getByRole('tab', { name: '深证成指', exact: true }).click();
    await page.getByText('暂时无法获取数据，请使用上方重试。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('img', { name: /深证成指成交额对比/ }).count(), 0, 'do not leak the previous index chart');
    await page.screenshot({ path: 'tmp/market-dashboard-qa/retained-and-unavailable.png', fullPage: true });

    mode = 'current-only';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('历史数据积累中，当前时点已具备 0/5 日。', { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('img', { name: /沪深合计成交额对比/ }).locator('polyline').count(), 1);
    await page.screenshot({ path: 'tmp/market-dashboard-qa/current-only.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Passed: three series, volume toggle, keyboard, mobile/dark, refresh retention, query isolation, current-only history progress.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
