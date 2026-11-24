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
      : url.pathname === "/api/stations" || url.pathname === "/api/refresh" ? { stations: [{ id: "own", name: "初光云序", isOwn: true, type: "newapi", baseUrl: "https://example.invalid/" }], settings: {} }
      : url.pathname === "/api/channel-onboarding/accounts" ? { accounts: [], unverifiedResources: [], channels: [], actions: [] }
      : { results: [], actions: [], users: [] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(baseURL, { timeout: 30000 });
  await page.locator(".jy-ov-metric.is-lead .jy-ov-value").waitFor();
  return { page, calls };
}

test("真实首页：客户消费复用用户快照，与财务毛利分别展示时间，初次只读汇总", async t => {
  const { page, calls } = await openPage(t);
  assert.equal(await page.locator(".jy-ov-metric.is-lead .jy-ov-value").textContent(), "¥4,722.12");
  assert.match(await page.locator(".jy-ov-metric").nth(3).textContent(), /\$548\.13/);
  assert.match(await page.locator(".jy-ov-metric").nth(0).textContent(), /10:21/);
  assert.match(await page.locator(".jy-ov-metric").nth(3).textContent(), /10:16/);
  assert.match(await page.locator(".jy-ov-coverage").textContent(), /96\.8%/);
  assert.deepEqual(calls.filter(call => call.method !== "GET"), []);
  assert.equal(calls.some(call => /history/.test(call.path)), false);
  assert.match(await page.locator(".jy-ov-attention-strip").textContent(), /昨日对账尚未齐全/);
  assert.equal(await page.locator(".jy-ov-metric.is-lead .jy-ov-currency").textContent(), "¥");
});

test("昨天只切经营数据，当前客户余额不倒退；详情链接带选择日期", async t => {
  const { page } = await openPage(t);
  const balanceBefore = await page.locator(".jy-ov-customer-table").textContent();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/overview" && response.url().includes("yesterday"));
  await page.getByRole("button", { name: "选择时间范围", exact: true }).click();
  const picker = page.locator(".jy-time-range-panel");
  await picker.getByRole("button", { name: "昨天", exact: true }).click();
  await picker.getByRole("button", { name: "确认", exact: true }).click(); await response;
  await picker.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".jy-ov-metric.is-lead .jy-ov-value")?.textContent === "¥20,469.25");
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

test("未同步财务账单不影响客户消费和时间，毛利不借用客户金额", async t => {
  const { page } = await openPage(t, { transform: data => ({ ...data, financial: { amount: null, asOf: null, reason: "尚未同步完整的主站消费账单", channels: [] }, profit: null }) });
  assert.equal(await page.locator(".jy-ov-metric.is-lead .jy-ov-value").textContent(), "¥4,722.12");
  assert.equal(await page.locator(".jy-ov-metric").nth(3).locator(".jy-ov-value").textContent(), "—");
  assert.match(await page.locator(".jy-ov-notice").textContent(), /客户消费与用户运营保持同一来源/);
  assert.equal(await page.locator(".jy-ov-chart svg").count(), 1);
});

test("账单落后一小时只提示财务采集延迟，客户金额、表头时间和换算仍与用户运营一致", async t => {
  const { page } = await openPage(t, { transform: data => ({ ...data, own: { ...data.own, rate: 2 }, financial: { ...data.financial, asOf: data.now - 3600000 } }) });
  assert.equal(await page.locator(".jy-ov-metric.is-lead .jy-ov-value").textContent(), "¥9,444.25");
  assert.match(await page.locator(".jy-ov-metric").nth(0).textContent(), /用户消费汇总 · 10:21/);
  assert.match(await page.locator(".jy-ov-notice").textContent(), /财务账单截至 9:22，更新落后约 60 分钟/);
  assert.match(await page.locator(".jy-ov-metric").nth(3).textContent(), /\$548\.13/);
  assert.match(await page.locator(".jy-ov-data-footer").textContent(), /客户消费 10:21/);
  assert.match(await page.locator(".jy-topbar").textContent(), /10:21/);
});

test("客户尚未同步时显示缺失值，不能用旧财务账单冒充客户消费", async t => {
  const { page } = await openPage(t, { transform: data => ({ ...data, users: { ...data.users, consumption: { amount: null, asOf: null }, usageAt: null, ready: false } }) });
  assert.equal(await page.locator(".jy-ov-metric.is-lead .jy-ov-value").textContent(), "—");
  assert.match(await page.locator(".jy-ov-metric.is-lead").textContent(), /客户消费尚未同步/);
});

test("手动刷新后客户金额与时间更新，旧财务金额和利润继续独立保留", async t => {
  let reads = 0;
  const { page } = await openPage(t, { transform: data => {
    if (++reads > 1) { data.users.consumption = { amount: 5000, asOf: data.users.usageAt + 60000 }; data.users.usageAt += 60000; data.users.balanceAt += 60000; }
    return data;
  } });
  await page.getByRole("button", { name: "刷新当前页面数据", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".jy-ov-metric.is-lead .jy-ov-value")?.textContent === "¥5,000.00");
  assert.match(await page.locator(".jy-ov-metric.is-lead").textContent(), /10:22/);
  assert.match(await page.getByRole("button", { name: "选择时间范围", exact: true }).textContent(), /10:22:03/);
  assert.match(await page.locator(".jy-ov-metric").nth(3).textContent(), /\$548\.13/);
  assert.match(await page.locator(".jy-ov-data-footer").textContent(), /财务账单 10:22/);
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
  if (width === 1440) {
    const box = selector => page.locator(selector).first().boundingBox();
    const [trend, row, customers, suppliers, heading, title, controls] = await Promise.all([box(".jy-ov-trend"), box(".jy-ov-customer-table tbody tr"), box(".jy-ov-customers"), box(".jy-ov-suppliers"), box(".jy-page-head"), box(".jy-page-title"), box(".jy-page-actions")]);
    assert.ok(Math.abs(trend.height - 330) <= 1, `图表需保持确认稿约330px，实际${trend.height}`);
    assert.ok(Math.abs(row.height - 62) <= 1, `客户行需保持62px，实际${row.height}`);
    assert.ok(Math.abs(customers.y - suppliers.y) < 1 && Math.abs(customers.height - suppliers.height) < 1, "客户与上游面板需同起点同高度");
    assert.ok(controls.x >= title.x + title.width && controls.y >= heading.y && controls.y + controls.height <= heading.y + heading.height + 1, "日期与数据说明需在标题同一区域");
    assert.equal(await page.locator(".jy-ov-intro").count(), 0);
  }
  if (process.env.UI_SHOT_DIR) {
    await mkdir(resolve(process.env.UI_SHOT_DIR), { recursive: true });
    await page.screenshot({ path: resolve(process.env.UI_SHOT_DIR, `overview-${width}-${dark ? "dark" : "light"}.png`), fullPage: true, animations: "disabled" });
  }
  if (width === 390) {
    const trend = await page.locator(".jy-ov-trend").boundingBox(), suppliers = await page.locator(".jy-ov-suppliers").boundingBox();
    assert.ok(trend.height > 300, "手机趋势图与脚注不能被面板裁掉");
    assert.ok(suppliers.height < 400, "两个上游不应留下整屏空白");
    await page.getByRole("button", { name: "今日消费榜", exact: true }).click();
    const firstSpend = page.locator(".jy-ov-customer-table tbody tr td:nth-child(2)").first();
    assert.equal(await firstSpend.isVisible(), true);
    assert.equal(await firstSpend.textContent(), "¥3,458.75");
    assert.match(await page.locator(".jy-ov-customer-name").first().getAttribute("href"), /user=101$/);
  }
});

test("侧栏保留一个主站控制台入口，常见桌面高度无需滚动，支持收起展开", async t => {
  const { page } = await openPage(t, { viewport: { width: 1440, height: 640 } });
  const sidebar = page.locator('.jy-sider');
  const main = sidebar.getByRole('link', { name: '初光云序主站，打开主站控制台', exact: true });
  await main.waitFor();
  assert.equal(await main.getAttribute('href'), 'https://example.invalid/dashboard');
  assert.equal(await main.getAttribute('target'), '_blank');
  assert.equal(await sidebar.getByText('打开主站', { exact: true }).count(), 0);
  assert.doesNotMatch(await sidebar.innerText(), /软件版本|2\.2\.0/);
  for (const height of [640, 720, 900]) {
    await page.setViewportSize({ width: 1440, height });
    const layout = await sidebar.evaluate(sidebar => {
      const nav = sidebar.querySelector('.jy-nav'), last = nav.lastElementChild.getBoundingClientRect(), rect = sidebar.getBoundingClientRect();
      return { width: rect.width, outside: sidebar.scrollHeight > sidebar.clientHeight + 1, inside: nav.scrollHeight > nav.clientHeight + 1, lastBottom: last.bottom, bottom: rect.bottom };
    });
    assert.equal(layout.width, 240);
    assert.equal(layout.outside, false, JSON.stringify(layout));
    assert.equal(layout.inside, false, JSON.stringify(layout));
    assert.ok(layout.lastBottom < layout.bottom, JSON.stringify(layout));
  }
  await page.getByRole('button', { name: '收起导航', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.jy-sider').getBoundingClientRect().width === 64);
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.jy-sider').getBoundingClientRect().width === 240);
  await main.waitFor();
  await page.context().route('https://example.invalid/dashboard', route => route.fulfill({ contentType: 'text/html', body: '<title>Main console</title>' }));
  const popup = page.waitForEvent('popup');
  await main.click();
  const target = await popup;
  await target.waitForURL('https://example.invalid/dashboard');
});

test("手机短窗口主站入口可见，菜单可滚动且不露出侧栏滚动条", async t => {
  const { page } = await openPage(t, { viewport: { width: 390, height: 667 } });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator('.jy-shell.is-nav-open').waitFor();
  await page.locator('.jy-workspace').waitFor();
  const scroll = await page.locator('.jy-nav').evaluate(nav => {
    nav.scrollTop = nav.scrollHeight;
    return { top: nav.scrollTop, hidden: getComputedStyle(nav).scrollbarWidth, webkit: getComputedStyle(nav, '::-webkit-scrollbar').display };
  });
  assert.ok(scroll.top > 0, '短窗口保留菜单滚动操作');
  assert.equal(scroll.hidden, 'none');
  assert.equal(scroll.webkit, 'none');
  await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.jy-sider')).visibility === 'hidden');
});
