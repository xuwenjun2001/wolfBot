const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const base = process.env.TACTICS_CHECK_URL || "http://127.0.0.1:3001";
  const output = path.resolve("data/validation/tactics-platform-ui");
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/tactics-platform`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "55线突破回踩", exact: true })
      .waitFor();
    await page.getByText("主板基础范围", { exact: true }).waitFor();
    await page.waitForResponse(
      (r) => r.url().includes("/api/quant/tactics") && r.status() === 200,
    );
    const guideToggle = page.getByRole("button", {
      name: "入池后如何观察",
      exact: true,
    });
    await guideToggle.click();
    await page
      .getByRole("heading", { name: "55线战法 · 入池后观察指引" })
      .waitFor();
    await page.getByRole("button", { name: "编辑指引", exact: true }).click();
    const guideInput = page.getByLabel("观察指引内容", { exact: true });
    const originalGuide = await guideInput.inputValue();
    await guideInput.fill(originalGuide + "\n未保存草稿");
    await guideToggle.click();
    await guideToggle.click();
    if (!(await guideInput.inputValue()).endsWith("未保存草稿"))
      throw new Error("Collapsing guide lost draft");
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    if (
      (await page.locator("#ma55-observation-guide").innerText()).includes(
        "未保存草稿",
      )
    )
      throw new Error("Cancelled draft leaked into guide");
    await guideToggle.click();
    await page.getByRole("button", { name: "公共参数", exact: true }).click();
    await page.getByRole("dialog", { name: "公共战法参数" }).waitFor();
    const fields = await page.getByRole("spinbutton").count();
    if (fields !== 5)
      throw new Error(`Expected five numeric parameters, got ${fields}`);
    await page.getByLabel("日线规则版本").selectOption("discussion_v2");
    if (await page.getByLabel("相对前收盘涨幅下限（%）").inputValue() !== "5")
      throw new Error("Discussion variant must default to 5% prior-close change");
    if (await page.getByLabel("距55线下限（%）").inputValue() !== "-1")
      throw new Error("Discussion variant must show its stricter support tolerance");
    await page.screenshot({ path: path.join(output, "discussion-parameters.png") });
    if (
      !(await page
        .getByRole("dialog")
        .locator("form")
        .evaluate((form) => form.checkValidity()))
    ) {
      throw new Error("Default parameter values violate the form constraints");
    }
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByText("新讨论 · 多周期观察与仓位纪律", { exact: true }).click();
    await page.screenshot({
      path: path.join(output, "desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "历史事件", exact: true }).click();
    await page.getByRole("button", { name: "有效观察池", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(output, "mobile.png"),
      fullPage: true,
    });
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    if (overflows) throw new Error("Mobile document overflows horizontally");

    // Populate only this browser's responses with a real historical fixture.
    // No fixture is written into the public database or used as live results.
    const live = await page.request.get(`${base}/api/quant/tactics`);
    const dashboard = (await live.json()).data;
    const fixture = JSON.parse(
      await fs.readFile(
        path.resolve("services/market-data/tests/fixtures/ma55/002837.json"),
        "utf8",
      ),
    );
    const valid = [];
    const bars = fixture.bars
      .filter((b) => b.date <= "2026-08-28")
      .map((b) => {
        if (b.trade_status !== "1" || !(b.volume > 0)) return b;
        valid.push(b);
        return {
          ...b,
          ...Object.fromEntries(
            [5, 10, 20, 55].map((n) => [
              `ma${n}`,
              valid.length >= n
                ? valid.slice(-n).reduce((sum, b) => sum + b.close, 0) / n
                : null,
            ]),
          ),
        };
      });
    const breakout = bars.find((b) => b.date === "2026-08-27");
    const current = bars.at(-1);
    const event = {
      id: "ui-fixture-event",
      symbol: "002837.SZ",
      name: "英维克",
      breakout_date: "2026-08-27",
      expires_date: "2026-08-31",
      status: "observing",
      display_status: "observing",
      signal: "pullback",
      last_evaluated: "2026-08-28",
      config_version: 1,
      parameters: dashboard.config.parameters,
      evidence: {
        breakout,
        current,
        distance_pct: (current.close / current.ma55 - 1) * 100,
        contraction_ratio: current.volume / breakout.volume,
      },
      bars,
      evaluations: [
        { trade_date: "2026-08-27", status: "observing", signal: "breakout" },
        { trade_date: "2026-08-28", status: "observing", signal: "pullback" },
      ],
    };
    await page.route("**/api/quant/tactics?**", async (route) => {
      const detail = new URL(route.request().url()).searchParams.has("event");
      const chart = new URL(route.request().url()).searchParams.get("chart");
      await route.fulfill({
        json: {
          data: chart
            ? chart === "daily"
              ? {
                  bars,
                  cacheKind: "snapshot",
                  source: "baostock",
                  tradeDate: current.date,
                  metadata: { volumeUnit: "手" },
                }
              : { session: null, cacheKind: "empty" }
            : detail
              ? event
              : {
                  ...dashboard,
                  events: [event],
                  total: 1,
                  runs: [],
                  latest_published: {
                    id: "ui-fixture-run",
                    trade_date: "2026-08-28",
                    total: 2,
                    ready: 1,
                    excluded: 0,
                    gaps: 1,
                  },
                  published_gaps: [
                    {
                      symbol: "000688.SZ",
                      name: "国城矿业",
                      reason: "目标交易日日K未就绪",
                    },
                  ],
                },
        },
      });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByText("结果已发布，已跳过 1 只数据缺失股票", { exact: true })
      .waitFor();
    await page
      .getByText("国城矿业 000688.SZ：目标交易日日K未就绪", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "查看英维克证据" }).click();
    const dialog = page.getByRole("dialog", { name: "战法证据" });
    await dialog.getByRole("img", { name: "K 线与均线" }).waitFor();
    const paths = await dialog
      .locator("[data-ma]")
      .evaluateAll(
        (nodes) =>
          nodes.filter((n) => n.getAttribute("d")?.includes("L")).length,
      );
    if (paths !== 5)
      throw new Error(`Expected five available moving averages, got ${paths}`);
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    if (!(await dialog.evaluate((el) => el.contains(document.activeElement))))
      throw new Error("Dialog lost keyboard focus");
    await page.screenshot({
      path: path.join(output, "evidence-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({
      path: path.join(output, "evidence-desktop.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(
      JSON.stringify({
        passed: true,
        fields,
        movingAveragePaths: paths,
        pageErrors: errors,
        screenshots: output,
      }),
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
