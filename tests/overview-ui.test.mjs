import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { overviewFixture } from "./fixtures/overview-page.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.OVERVIEW_UI_BASE_URL || "http://localhost:3099";
let browser;
after(async () => { await browser?.close(); });

async function openPage(t, { viewport = { width: 1440, height: 1000 }, dark = false, transform = value => value } = {}) {
  browser ||= await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  t.after(() => context.close());
  const page = await context.newPage(), calls = [];
  page.setDefaultTimeout(15000);
  await page.addInitScript((dark) => { localStorage.setItem("app-shell-theme", dark ? "dark" : "light"); }, dark);
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    calls.push({ path: url.pathname, method: request.method(), query: url.search, body: request.postDataJSON() });
    const body = url.pathname === "/api/overview" ? transform(overviewFixture(url.searchParams.get("preset") || "today"))
      : url.pathname === "/api/auth/me" ? { username: "fixture" }
      : url.pathname === "/api/meta" ? { types: [], rules: {}, settings: {} }
      : url.pathname === "/api/stations" || url.pathname === "/api/refresh" ? { stations: [], settings: {} }
      : url.pathname === "/api/channel-onboarding/accounts" ? { accounts: [], unverifiedResources: [], channels: [], actions: [] }
      : { results: [], actions: [], users: [] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(baseURL, { timeout: 30000 });
  await page.locator(".jy-ov-metric.is-lead .jy-ov-value").waitFor();
  return { page, calls };
}

test("真实首页：分开全站消费与部分毛利、各自时间，初次只读汇总", async t => {
  const { page, calls } = await openPage(t);
  assert.equal(await page.locator(".jy-ov-metric.is-lead .jy-ov-value").textContent(), "$4,775.92");
  assert.match(await page.locator(".jy-ov-metric").nth(3).textContent(), /\$548\.13/);
  assert.match(await page.locator(".jy-ov-metric").nth(0).textContent(), /10:22/);
  assert.match(await page.locator(".jy-ov-metric").nth(3).textContent(), /10:16/);
  assert.match(await page.locator(".jy-ov-coverage").textContent(), /96\.8%/);
  assert.deepEqual(calls.filter(call => call.method !== "GET"), []);
  assert.equal(calls.some(call => /history/.test(call.path)), false);
});

test("昨天只切经营数据，当前客户余额不倒退；详情链接带选择日期", async t => {
  const { page } = await openPage(t);
  const balanceBefore = await page.locator(".jy-ov-customer-table").textContent();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/overview" && response.url().includes("yesterday"));
  await page.getByRole("button", { name: "昨天", exact: true }).click(); await response;
  await page.waitForFunction(() => document.querySelector(".jy-ov-metric.is-lead .jy-ov-value")?.textContent === "$20,506.26");
  assert.equal(await page.locator(".jy-ov-customer-table").textContent(), balanceBefore);
  assert.match(await page.locator(".jy-ov-customers").textContent(), /当前余额/);
  await page.locator(".jy-ov-metric").nth(1).click();
  assert.match(await page.getByRole("dialog").textContent(), /sample-a/);
  assert.match(await page.getByRole("dialog").textContent(), /9,296\.43/);
  assert.equal(await page.getByRole("dialog").getByRole("link", { name: "sample-a", exact: true }).getAttribute("href"), "/users?tab=users&user=101");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".jy-ov-metric").nth(3).click();
  assert.equal(await page.getByRole("dialog").getByRole("link", { name: "查看每日利润 →" }).getAttribute("href"), "/reconciliation?preset=yesterday");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "每日数据 →" }).click();
  const details = await page.getByRole("dialog").textContent();
  assert.match(details, /2026-11-15/); assert.doesNotMatch(details, /2026-11-22/);
});

test("未同步金融数据不显示0，普通客户用量可独立查看", async t => {
  const { page } = await openPage(t, { transform: data => ({ ...data, financial: { amount: null, asOf: null, reason: "尚未同步完整的主站消费账单", channels: [] }, profit: null }) });
  assert.equal(await page.locator(".jy-ov-metric.is-lead .jy-ov-value").textContent(), "—");
  assert.equal(await page.locator(".jy-ov-metric").nth(3).locator(".jy-ov-value").textContent(), "—");
  assert.match(await page.locator(".jy-ov-notice").textContent(), /普通客户用量仍可独立查看/);
  assert.equal(await page.locator(".jy-ov-chart svg").count(), 1);
});

test("目录或账单时间未确认时不宣称全部计入，也不显示假的金额进度", async t => {
  const { page } = await openPage(t, { transform: data => ({ ...data, coverage: { ...data.coverage, covered: null, missing: null, ratio: null, known: null, counted: null, timeWindowState: "unknown", missingChannels: [] } }) });
  const panel = page.locator(".jy-ov-coverage");
  assert.doesNotMatch(await panel.textContent(), /均已进入对账|100%/);
  assert.match(await panel.textContent(), /时间范围尚未确认/);
  assert.equal(await panel.locator(".jy-ov-coverage-track").count(), 0);
  await page.getByRole("button", { name: "查看昨日对账进度说明" }).click();
  assert.doesNotMatch(await page.getByRole("dialog").textContent(), /均已进入对账/);
});

test("未接渠道去接入，已绑定但未计入的渠道去查看账单", async t => {
  const { page } = await openPage(t, { transform: data => { data.coverage.missingChannels[1].status = "billing_missing"; return data; } });
  await page.getByRole("button", { name: "查看昨日对账进度说明" }).click();
  const rows = page.getByRole("dialog").locator("tbody tr");
  assert.match(await rows.nth(0).getByRole("link", { name: "接入渠道 →" }).getAttribute("href"), /^\/stations\?action=connect&ownStationId=.+&channelIds=/);
  assert.equal(await rows.nth(1).getByRole("link", { name: "查看账单 →" }).getAttribute("href"), "/reconciliation?preset=yesterday");
});

test("首页刷新限定今天和当前余额，不触发历史回补", async t => {
  const { page, calls } = await openPage(t);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/overview");
  await page.getByRole("button", { name: "刷新当前页面数据", exact: true }).click();
  await response;
  const writes = calls.filter(call => call.method === "POST");
  assert.deepEqual(writes.map(call => call.path).sort(), ["/api/refresh", "/api/users", "/api/reconciliation/query"].sort());
  assert.deepEqual(writes.find(call => call.path === "/api/reconciliation/query").body, { preset: "today", observe: true });
  assert.deepEqual(writes.find(call => call.path === "/api/refresh").body, { scope: "upstreams" });
  assert.equal(calls.some(call => /history/.test(call.path)), false);
});

for (const width of [1440, 768, 390]) for (const dark of [false, true]) test(`首页${width}px${dark ? "深色" : "浅色"}：无页面横向溢出、客户与上游入口真实`, async t => {
  const { page } = await openPage(t, { viewport: { width, height: width === 390 ? 844 : 1000 }, dark });
  await page.waitForTimeout(350);
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, theme: document.documentElement.dataset.theme }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
  const link = page.locator(".jy-ov-customer-name").first();
  assert.match(await link.getAttribute("href"), /^\/users\?tab=users&user=/);
  assert.equal(await page.locator(".jy-ov-suppliers").getByRole("link").getAttribute("href"), "/stations");
  if (dark) assert.equal(dimensions.theme, "dark");
  await page.waitForFunction(() => Number(document.querySelector(".jy-ov-chart-bar")?.getAttribute("width")) > 3);
  const bars = await page.locator(".jy-ov-chart-bar").evaluateAll(nodes => nodes.map(node => ({ x: Number(node.getAttribute("x")), width: Number(node.getAttribute("width")) })));
  assert.equal(bars.length, 7);
  assert.ok(bars.at(-1).x - bars[0].x > 120, "柱形需横跨图表，不能在手机上挤在左侧");
  if (process.env.UI_SHOT_DIR) {
    await mkdir(resolve(process.env.UI_SHOT_DIR), { recursive: true });
    await page.screenshot({ path: resolve(process.env.UI_SHOT_DIR, `overview-${width}-${dark ? "dark" : "light"}.png`), fullPage: true, animations: "disabled" });
  }
  if (width === 390) {
    await page.getByRole("button", { name: "今日消费榜", exact: true }).click();
    const firstSpend = page.locator(".jy-ov-mobile-spend").first();
    assert.equal(await firstSpend.isVisible(), true);
    assert.equal(await firstSpend.textContent(), "今天 $3,458.75");
    assert.match(await page.locator(".jy-ov-customer-name").first().getAttribute("href"), /user=101$/);
  }
});
