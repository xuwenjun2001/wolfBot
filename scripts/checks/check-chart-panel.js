/* Run against an upgraded generated project: node scripts/checks/check-chart-panel.js http://localhost:3110 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(process.argv[2] || 'http://localhost:3110', { waitUntil: 'networkidle' });
    const panel = page.locator('[data-chart-panel-version="1"][data-chart-ready="true"]');
    await panel.waitFor();
    assert.deepEqual(await panel.locator('[data-chart]').evaluateAll(nodes => nodes.map(n => n.dataset.chart)), ['price', 'volume', 'amount']);
    for (const kind of ['price', 'volume', 'amount']) {
      const svg = panel.locator('[data-chart=' + kind + '] svg');
      const bounds = await svg.boundingBox();
      await svg.hover({ position: { x: bounds.width * .35, y: 40 } });
      await page.getByRole('tooltip').waitFor();
      const dates = await panel.locator('[data-selected-time]').evaluateAll(nodes => nodes.map(n => n.dataset.selectedTime));
      assert.equal(new Set(dates).size, 1);
      assert.equal(dates.length, 3);
      assert.ok((await page.getByRole('tooltip').innerText()).includes('成交额变化率'));
    }
    await panel.focus();
    await page.keyboard.press('Home');
    const first = await panel.locator('[data-selected-time]').first().getAttribute('data-selected-time');
    await page.keyboard.press('End');
    assert.notEqual(await panel.locator('[data-selected-time]').first().getAttribute('data-selected-time'), first);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);

    let calls = 0, fail = false;
    await page.route('**/api/market/quotes/session/**', route => {
      calls++;
      if (fail) return route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        symbol: '601919', secid: '1.601919', name: 'test fixture', tradeDate: '2026-09-04', previousDate: '2026-09-03',
        source: 'fixture', volumeUnit: '手', fetchedAt: '2026-09-04T01:32:00Z', status: 'available', reason: null, cacheHit: false,
        rows: [
          { time: '09:30', price: 10, minuteVolume: 100, minuteAmount: 100000, amount: 100000, previous: 80000, difference: 20000, changeAmountPct: 25 },
          { time: '09:31', price: 11, minuteVolume: 200, minuteAmount: 220000, amount: 320000, previous: 200000, difference: 120000, changeAmountPct: 60 },
        ],
      }) });
    });
    await panel.getByRole('button', { name: '分时', exact: true }).click();
    await panel.getByText('fixture', { exact: false }).waitFor();
    assert.equal(calls, 1);
    await panel.locator('[data-chart=volume] svg').hover({ position: { x: 90, y: 40 } });
    assert.equal(calls, 1);
    await panel.getByRole('button', { name: '日线', exact: true }).click();
    await panel.getByRole('button', { name: '分时', exact: true }).click();
    assert.equal(calls, 1);
    await panel.getByRole('button', { name: '刷新分时', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.qp-controls>button')?.disabled);
    assert.equal(calls, 2);
    fail = true;
    await panel.getByRole('button', { name: '刷新分时', exact: true }).click();
    await panel.getByRole('alert').waitFor();
    assert.ok((await panel.getByRole('alert').innerText()).includes('保留上次成功数据'));
    assert.equal(await panel.locator('[data-selected-time]').count(), 3);

    await page.setViewportSize({ width: 390, height: 844 });
    await panel.locator('[data-chart=amount] svg').click({ position: { x: 100, y: 45 } });
    const tip = await page.getByRole('tooltip').boundingBox();
    assert.ok(tip.x >= 0 && tip.x + tip.width <= 390);
    const plots = await panel.locator('[data-chart]').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
    assert.ok(plots[0] < plots[1] && plots[1] < plots[2]);
    await fs.mkdir(path.resolve('tmp/chart-panel-qa'), { recursive: true });
    await panel.screenshot({ path: path.resolve('tmp/chart-panel-qa/mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.getByRole('button', { name: '日线', exact: true }).click();
    await panel.screenshot({ path: path.resolve('tmp/chart-panel-qa/daily.png') });
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const touchPage = await touchContext.newPage();
    await touchPage.goto(process.argv[2] || 'http://localhost:3110', { waitUntil: 'networkidle' });
    const touchPanel = touchPage.locator('[data-chart-panel-version="1"][data-chart-ready="true"]');
    await touchPanel.locator('[data-chart=volume] svg').tap({ position: { x: 140, y: 50 } });
    await touchPage.getByRole('tooltip').waitFor();
    assert.equal(new Set(await touchPanel.locator('[data-selected-time]').evaluateAll(nodes => nodes.map(n => n.dataset.selectedTime))).size, 1);
    await touchPage.evaluate(() => document.documentElement.classList.add('dark'));
    await touchPanel.screenshot({ path: path.resolve('tmp/chart-panel-qa/touch-dark.png') });
    await touchContext.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, scenarios: ['three-panel hover', 'keyboard', 'one initial request', 'manual refresh', 'stale preservation', 'mobile containment', 'touch selection', 'dark tooltip'], requests: calls }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
