const { chromium } = require("playwright");
const fs = require("node:fs/promises");
async function main() {
  const browser = await chromium.launch({ headless: true });
  const folder = "data/validation/tactic-charts";
  await fs.mkdir(folder, { recursive: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    let writes = 0;
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.url().includes("/api/quant/tactics") && r.method() === "POST")
        writes++;
    });
    await page.goto("http://127.0.0.1:3001/tactics-platform");
    await page
      .getByRole("button", { name: /^查看.*证据$/ })
      .first()
      .click();
    const panel = page.getByRole("region", {
      name: "K 线与量价结构",
      exact: true,
    });
    await panel.getByRole("button", { name: "刷新日K", exact: true }).waitFor();
    if ((await panel.locator("[data-ma]").count()) !== 6)
      throw new Error("Missing six averages");
    const before = await (
      await page.request.get("http://127.0.0.1:3001/api/quant/tactics")
    ).json();
    await panel.getByRole("button", { name: "分时", exact: true }).click();
    await panel
      .getByRole("button", { name: "刷新分时", exact: true })
      .waitFor();
    if (writes !== 0)
      throw new Error("Opening/switching chart refreshed automatically");
    await panel.getByRole("button", { name: "日线", exact: true }).click();
    await panel.getByRole("button", { name: "刷新日K", exact: true }).waitFor();
    await page.screenshot({ path: folder + "/cached.png", fullPage: true });
    const outcomes = {};
    for (const mode of (process.env.TACTIC_CHART_CACHE_ONLY ? [] : ["daily", "session"])) {
      if (mode === "session")
        await panel.getByRole("button", { name: "分时", exact: true }).click();
      const button = panel.getByRole("button", {
        name: mode === "daily" ? "刷新日K" : "刷新分时",
        exact: true,
      });
      await button.waitFor();
      const pending = page.waitForResponse(
        (r) =>
          r.url().includes("/api/quant/tactics") &&
          r.request().method() === "POST",
        { timeout: 35000 },
      );
      await button.click();
      const response = await pending;
      const body = await response.json();
      outcomes[mode] = {
        http: response.status(),
        date: body.data?.tradeDate,
        count: body.data?.bars?.length ?? body.data?.session?.rows?.length,
        message: body.message,
      };
      await button.waitFor();
      await page.screenshot({
        path: folder + "/" + mode + ".png",
        fullPage: true,
      });
    }
    // Synthetic failures stay inside this browser; they never write public caches.
    await panel.getByRole("button", { name: "日线", exact: true }).click();
    await panel.getByRole("button", { name: "刷新日K", exact: true }).waitFor();
    const originalStatus = await panel
      .locator(".qp-status")
      .first()
      .innerText();
    const originalCurve = await panel
      .locator('[data-ma="233"]')
      .getAttribute("d");
    await page.route("**/api/quant/tactics", async (route) => {
      if (route.request().method() === "POST")
        return route.fulfill({
          status: 502,
          json: { message: "测试行情源暂不可用" },
        });
      return route.continue();
    });
    await panel.getByRole("button", { name: "刷新日K", exact: true }).click();
    await panel
      .getByRole("alert")
      .filter({ hasText: "测试行情源暂不可用" })
      .waitFor();
    if (
      (await panel.locator(".qp-status").first().innerText()) !==
        originalStatus ||
      (await panel.locator('[data-ma="233"]').getAttribute("d")) !==
        originalCurve
    )
      throw new Error("Failure replaced old chart/time");
    await page.unroute("**/api/quant/tactics");
    const postsBeforeReload = writes;
    await page.reload();
    await page
      .getByRole("button", { name: /^查看.*证据$/ })
      .first()
      .click();
    await panel.getByRole("button", { name: "刷新日K", exact: true }).waitFor();
    if (
      writes !== postsBeforeReload ||
      (await panel.locator(".qp-status").first().innerText()) !== originalStatus
    )
      throw new Error("Reopen failed to reuse persisted cache");
    const after = await (
      await page.request.get("http://127.0.0.1:3001/api/quant/tactics")
    ).json();
    if (
      JSON.stringify(before.data.events) !== JSON.stringify(after.data.events)
    )
      throw new Error("Refresh changed tactic events");
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("button", { name: "日线", exact: true }).click();
    await panel.getByRole("button", { name: "刷新日K", exact: true }).waitFor();
    await page.mouse.move(0, 0);
    await panel.focus();
    await page.keyboard.press("Home");
    await panel.getByRole("tooltip").waitFor();
    if (
      !(await panel
        .getByRole("tooltip")
        .getByText("MA233", { exact: true })
        .count())
    )
      throw new Error("Missing MA233 tooltip");
    const tipBox = await panel.getByRole("tooltip").boundingBox();
    const panelBox = await panel.boundingBox();
    if (
      tipBox.x < panelBox.x ||
      tipBox.x + tipBox.width > panelBox.x + panelBox.width + 1
    )
      throw new Error("Mobile tooltip overflow");
    await page.screenshot({ path: folder + "/mobile.png", fullPage: true });
    await panel.focus();
    await page.keyboard.press("Home");
    await panel.getByRole("tooltip").waitFor();
    await page.keyboard.press("Escape");
    let release, arrived;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      arrived = resolve;
    });
    await page.route("**/api/quant/tactics", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      arrived();
      await held;
      await route
        .fulfill({
          json: {
            data: {
              bars: [],
              source: "STALE_RESPONSE",
              fetchedAt: "2000-01-01",
            },
          },
        })
        .catch(() => {});
    });
    await panel.getByRole("button", { name: "刷新日K", exact: true }).click();
    await started;
    await page.getByRole("button", { name: "关闭证据", exact: true }).click();
    await page
      .getByRole("button", { name: /^查看.*证据$/ })
      .nth(1)
      .click();
    await panel.getByRole("button", { name: "刷新日K", exact: true }).waitFor();
    release();
    await page.unrouteAll({ behavior: "wait" });
    if ((await panel.innerText()).includes("STALE_RESPONSE"))
      throw new Error("Previous stock request overwrote current stock");
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(
      JSON.stringify({
        outcomes,
        writes,
        unchangedEvidence: true,
        pageErrors: errors,
      }),
    );
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
