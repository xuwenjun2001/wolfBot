// Read-only browser checks against the local app; edits remain unsaved drafts.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  let posts = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/tactics/reviews')) posts++; });
    await page.goto(process.env.TACTICS_CHECK_URL || 'http://127.0.0.1:3001/tactics-platform');
    const panel = page.getByRole('region', { name: '收盘复盘与日报' });
    await panel.getByText('DS V4.1 Flash · max', { exact: true }).waitFor({ timeout: 30000 });
    await panel.getByRole('tab', { name: '胜率统计', exact: true }).click();
    await panel.getByRole('heading', { name: 'B+2 收盘上涨比例 · 主指标' }).waitFor();
    await fs.mkdir('data/validation/tactic-reviews', { recursive: true });
    await panel.screenshot({ path: 'data/validation/tactic-reviews/stats-desktop.png' });
    await panel.getByRole('tab', { name: '提示词与日程', exact: true }).click();
    const edit = panel.getByRole('button', { name: '编辑提示词', exact: true });
    if (await edit.isVisible()) {
      await edit.click();
      const field = panel.getByRole('textbox', { name: '业务分析提示词', exact: true });
      await field.fill('仅测试编辑器草稿，不保存。');
      await panel.getByRole('button', { name: '取消', exact: true }).click();
      if (await field.count()) throw new Error('Cancelled draft still visible');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole('tab', { name: '胜率统计', exact: true }).click();
    await panel.screenshot({ path: 'data/validation/tactic-reviews/stats-mobile.png' });
    const overflow = await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    await panel.getByRole('tab', { name: 'B 池复盘', exact: true }).click();
    await panel.screenshot({ path: 'data/validation/tactic-reviews/pool-mobile.png' });
    await panel.getByRole('tab', { name: '日报知识库', exact: true }).click();
    await panel.getByRole('textbox', { name: '搜索日报', exact: true }).fill('不存在的检索词');
    await panel.getByText('暂无匹配日报。完成收盘复盘后将自动生成并保存。', { exact: true }).waitFor();
    const response = await page.request.get('http://127.0.0.1:3001/api/quant/tactics/reviews');
    const live = await response.json();
    if (live.data.reports.length) {
      await panel.getByRole('textbox', { name: '搜索日报', exact: true }).fill('');
      const latest = live.data.reports[0];
      await panel.getByRole('button', { name: `${latest.trade_date} 日报 · v${latest.revision}`, exact: true }).click();
      const heading = panel.getByRole('heading', { name: `${latest.trade_date} 战法日报 · 版本 ${latest.revision}`, exact: true });
      await heading.waitFor();
      await panel.getByText('本次生成依据：提示词、行情快照与历史知识', { exact: true }).click();
      await panel.locator('pre').waitFor();
      await heading.evaluate(el => el.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: 'data/validation/tactic-reviews/report-mobile.png' });
      await page.setViewportSize({ width: 1440, height: 1100 });
      await heading.evaluate(el => el.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: 'data/validation/tactic-reviews/report-desktop.png' });
      const evidence = panel.getByRole('button', { name: '查看股票证据', exact: true }).first();
      if (await evidence.count()) {
        await evidence.click();
        await page.getByRole('dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
      }
    }
    if (overflow || posts || errors.length) throw new Error(JSON.stringify({ overflow, posts, errors }));
    console.log(JSON.stringify({ passed: true, desktop: true, mobile: true, unsavedPrompt: true, posts, errors }));
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
