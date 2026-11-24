import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { buildUserGroupPage, resolveUserGroupsWindow } from "../server/user-groups.js";
import { buildUsersView } from "../lib/user-ops-view.js";
import { usersResponse } from "../server/user-ops-page.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.USER_GROUPS_UI_BASE_URL || "http://localhost:3099";
const now = Date.parse("2026-11-24T08:00:00Z"), tz = "Asia/Shanghai";
const groupA = "AWSB全模型-不带F-Coding", groupB = "A社官转不带F";
const directory = [
  { id: 1, username: "jyzzz", role: 1, status: 1, quotaUsd: 24714.39 },
  { id: 2, username: "Lucky-gangshen", role: 1, status: 1, quotaUsd: 2722.47 },
  { id: 3, username: "grace123", role: 1, status: 1, quotaUsd: 6357.54 },
  { id: 4, username: "zero-user", role: 1, status: 1, quotaUsd: 100 },
];
const daily = new Map(directory.map(user => [user.username, Array(90).fill(1)]));
const full = { ...buildUsersView({ now, tz, users: directory, daily, recentHours: new Map(), runways: new Map(), backfill: { done: true, days: 90, total: 90 } }),
  rate: 1, balanceSyncedMs: now, todaySyncedMs: now, refreshIntervalMs: 60000, ownStationId: "own" };
const source = [{ user: "jyzzz", group: groupA, amount: 7000, requests: 70 }, { user: "jyzzz", group: groupB, amount: 1000, requests: 10 },
  { user: "Lucky-gangshen", group: groupB, amount: 2000, requests: 20 }, { user: "grace123", group: groupA, amount: 500, requests: 5 }];

function response(params) {
  const input = Object.fromEntries(params), window = resolveUserGroupsWindow(input, now, tz), scale = input.preset === "yesterday" ? 2 : 1;
  return buildUserGroupPage({ ...window, directory, current: full.users, ready: true, rate: 1, asOf: now, balanceAt: now, intervalMs: 60000,
    usage: directory.map(user => ({ key: user.username, quotaUnits: source.filter(row => row.user === user.username).reduce((sum, row) => sum + row.amount * 500000 * scale, 0), requests: 100 })),
    flow: source.map(row => ({ ...row, quotaUnits: row.amount * 500000 * scale })) }, input);
}
let browser;
after(async () => { await browser?.close(); });
async function openPage(t, { width = 1440, search = "tab=groups", fail = false, delay = 0, dark = false } = {}) {
  browser ||= await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: "block" });
  t.after(async () => { if (!t.passed) await page.screenshot({ path: `/tmp/relay-user-groups-failed-${width}-${Date.now()}.png`, fullPage: true }); await context.close(); });
  const page = await context.newPage(), calls = [], errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(dark => localStorage.setItem("app-shell-theme", dark ? "dark" : "light"), dark);
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()); calls.push({ path: url.pathname, method: req.method(), query: url.search });
    let body;
    if (url.pathname === "/api/users/groups") {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      body = response(url.searchParams);
      if (fail && req.method() === "POST") body.error = "USER_GROUPS_UNAVAILABLE";
    } else if (url.pathname === "/api/users") body = usersResponse(full, url.searchParams);
    else if (url.pathname === "/api/auth/me") body = { username: "fixture" };
    else if (url.pathname === "/api/stations") body = { stations: [{ id: "own", name: "初光云序", isOwn: true, baseUrl: "https://example.invalid", type: "newapi" }], settings: {} };
    else if (url.pathname === "/api/meta") body = { types: [], rules: {}, settings: {} };
    else if (url.pathname === "/api/channel-onboarding/accounts") body = { accounts: [], channels: [], unverifiedResources: [], actions: [] };
    else body = { results: [], actions: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${baseURL}/users?${search}`, { timeout: 30000 });
  await page.locator('.jy-ug-table [data-user-id="1"]').waitFor();
  if (!delay) await page.waitForFunction(() => document.querySelector('.jy-ug-spend')?.textContent.includes("8,000"));
  return { page, calls, errors };
}

test("用户是主行，真实渠道分组合并展示；不会访问模型分析和对账接口", async t => {
  const { page, calls, errors } = await openPage(t);
  assert.match(await page.locator('.jy-ug-user').first().textContent(), /jyzzz.*24,714\.39.*8,000\.00/s);
  const details = page.locator('.jy-ug-detail-row').first();
  assert.match(await details.textContent(), /AWSB全模型-不带F-Coding.*7,000\.00.*87\.5%/s);
  assert.match(await details.textContent(), /A社官转不带F.*1,000\.00.*12\.5%/s);
  assert.equal(await page.getByRole('button', { name: '展开全部', exact: true }).count(), 1);
  assert.equal(calls.some(call => /own\/analytics|reconciliation|users\/\d+/.test(call.path)), false);
  assert.deepEqual(errors, []);
});

test("筛选分组后保留总消费和原占比，搜索与排序走独立参数", async t => {
  const { page } = await openPage(t);
  await page.getByRole('combobox', { name: '筛选渠道分组', exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').getByText(groupB, { exact: true }).click();
  await page.waitForFunction(() => location.search.includes('channelGroup'));
  const jy = page.locator('[data-user-id="1"]');
  await page.waitForFunction(() => document.querySelector('[data-user-id="1"] .jy-ug-spend')?.textContent.includes('1,000.00'));
  assert.match(await jy.textContent(), /1,000\.00.*用户总消费 ¥8,000\.00/s);
  await page.getByRole('button', { name: '展开 jyzzz 的渠道分组明细', exact: true }).click();
  assert.match(await page.getByRole('table', { name: 'jyzzz 的渠道分组消费', exact: true }).textContent(), /12\.5%/);
  await page.getByRole('searchbox', { name: '搜索用户', exact: true }).fill('JYZZZ');
  await page.waitForFunction(() => document.querySelectorAll('.jy-ug-user').length === 1);
  assert.equal(await page.locator('.jy-ug-user').count(), 1);
});

test("日期只切消费，当前余额保持；抽屉使用所选日期、不访问模型详情", async t => {
  const { page, calls } = await openPage(t);
  await page.getByRole('button', { name: '选择时间范围', exact: true }).click();
  const picker = page.locator('.jy-time-range-panel');
  await picker.getByRole('button', { name: '昨天', exact: true }).click();
  await picker.getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.jy-ug-spend')?.textContent.includes('16,000.00'));
  assert.match(await page.locator('[data-user-id="1"]').textContent(), /24,714\.39/);
  await page.getByRole('button', { name: '查看 jyzzz 的渠道分组消费', exact: true }).click();
  const drawer = page.locator('.ant-drawer-body'); await drawer.waitFor();
  assert.match(await drawer.textContent(), /当前余额.*24,714\.39/s);
  assert.match(await drawer.textContent(), /2026\/11\/23.*16,000\.00/s);
  assert.equal(calls.some(call => /users\/\d+|own\/analytics/.test(call.path)), false);
});

test("余额从低到高排序，显示无消费用户时保留真实零消费", async t => {
  const { page } = await openPage(t);
  await page.getByRole('combobox', { name: '用户渠道分组排序', exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').getByText('余额从低到高', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.jy-ug-user')?.getAttribute('data-user-id') === '2');
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden' });
  await page.getByRole('checkbox', { name: '仅看有消费', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.jy-ug-user')?.getAttribute('data-user-id') === '4' && document.querySelector('.jy-ug-spend')?.textContent === '¥0.00');
  assert.match(await page.locator('.jy-ug-user').first().textContent(), /zero-user.*100\.00.*0\.00/s);
});

test("刷新只同步本模块，失败保留金额与明细", async t => {
  const { page, calls } = await openPage(t, { fail: true });
  await page.getByRole('button', { name: '刷新当前页面数据', exact: true }).click();
  await page.locator('.jy-ug-note').waitFor();
  assert.match(await page.locator('.jy-ug-spend').first().textContent(), /8,000\.00/);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.path), ['/api/users/groups']);
  assert.equal(calls.some(call => /reconciliation|own\/analytics/.test(call.path)), false);
});

for (const width of [1440, 768, 390]) test(`真实页面 ${width}px：长分组名和展开表不溢出`, async t => {
  const { page, errors } = await openPage(t, { width });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const detail = page.locator('.jy-ug-details').first();
  assert.equal(await detail.locator('tbody').evaluate(el => getComputedStyle(el).display), 'table-row-group');
  await page.getByRole('button', { name: '查看 Lucky-gangshen 的渠道分组消费', exact: true }).click();
  await page.locator('.ant-drawer-body').waitFor();
  assert.match(await page.locator('.ant-drawer-body').textContent(), /2,722\.47.*2,000\.00/s);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.UI_SHOT_DIR) {
    await mkdir(process.env.UI_SHOT_DIR, { recursive: true });
    await page.waitForFunction(() => { const rect = document.querySelector('.ant-drawer-content-wrapper')?.getBoundingClientRect(); return rect && Math.abs(rect.right - innerWidth) < 1 && document.querySelector('.jy-ug-results')?.getAttribute('aria-busy') === 'false'; });
    await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/user-groups-drawer-${width}.png`, fullPage: true });
    await page.locator('.ant-drawer-close').click();
    await page.locator('.ant-drawer-body').waitFor({ state: 'hidden' });
    await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/user-groups-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
});

test("首次读取分组时余额先显示，消费缺失不会伪装为零", async t => {
  const { page } = await openPage(t, { delay: 1600 });
  assert.match(await page.locator('[data-user-id="1"]').textContent(), /24,714\.39/);
  assert.equal(await page.locator('[data-user-id="1"] .jy-ug-spend').textContent(), '—');
  await page.waitForFunction(() => document.querySelector('.jy-ug-spend')?.textContent.includes('8,000.00'));
});
