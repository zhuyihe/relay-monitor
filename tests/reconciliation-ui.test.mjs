// Start the local dev server first. Set PLAYWRIGHT_MODULE to a Playwright module
// path when it is bundled outside this project, and PLAYWRIGHT_CHANNEL=msedge
// when Chromium is unavailable locally.
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.RECONCILIATION_UI_BASE_URL || "http://127.0.0.1:3099";

const window = { preset: "today", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };

function rule(id, name, amount, resultWindow = window) {
  return {
    rule: { id, tokenName: name, upstreamStationId: "upstream-1", fixedGroup: "default", channels: [{ channelId: Number(id.slice(-1)), name: `Channel ${id}` }] },
    requestedWindow: resultWindow,
    window: resultWindow,
    downstream: { state: "complete", calculationVersion: 3, billingSource: "channel-log-stat", amountUsd: amount, knownAmountUsd: amount, successfulCount: 1, expectedCount: 1, window: resultWindow },
    upstream: { state: "complete", calculationVersion: 3, amountUsd: 1, knownAmountUsd: 1, successfulCount: 1, expectedCount: 1, group: "default", window: resultWindow },
    calculation: { profitUsd: amount - 1, marginRate: (amount - 1) / amount },
    health: { code: "READY", issues: [] },
    lastSuccessfulAt: "2026-10-08T00:00:00.000Z",
  };
}

const configuration = {
  ownStation: { id: "own-1", cnyPerUsd: null },
  upstreams: [{ id: "upstream-1", name: "Fixture upstream" }],
  channels: [],
  rules: [rule("rule-1", "Rule A", 10).rule, rule("rule-2", "Rule B", 20).rule, rule("rule-3", "Rule C", 30).rule],
};

function response(results) {
  return { generatedAt: "2026-10-08T00:00:00.000Z", results };
}

async function openFixturePage(t, handler, viewport, clock = false) {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chromium" });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "block", ...(viewport ? { viewport, isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  page.setDefaultTimeout(5_000);
  await page.route("**/api/**", handler);
  await page.goto(`${baseURL}/reconciliation`, { timeout: 30000 });
  await page.getByText("Rule A").first().waitFor();
  return page;
}

async function fulfill(route, body) {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

function onboardingFixture(existing = true) {
  return {
    ...configuration,
    ownStation: { ...configuration.ownStation, baseUrl: "https://own.example" },
    upstreams: existing ? [{ id: "upstream-1", name: "Fixture upstream", type: "newapi", baseUrl: "https://up.example" }] : [],
    channels: [{ id: 4, name: "New channel", status: 1, baseUrl: "https://up.example", groups: ["local-sales"] }],
    rules: existing ? [{ ...rule("rule-1", "Rule A", 10).rule, ownStationId: "own-1", tokenId: 7, enabled: true }] : [],
  };
}
const onboardingKeys = { tokens: [{ id: 7, name: "Supplier Key", status: 1, group: "upstream-group" }], groups: {} };

async function selectOnboardingKey(page) {
  const drawer = page.getByRole("dialog", { name: "接入监控与对账" });
  await drawer.getByRole("combobox", { name: "接入上游 Key" }).click();
  await page.getByText("Supplier Key · 上游分组 upstream-group", { exact: true }).last().click();
  return drawer;
}

test("channel onboarding reuses an account and appends to the existing Key without repeating credentials", async (t) => {
  const config = onboardingFixture();
  const writes = [];
  const page = await openFixturePage(t, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") return fulfill(route, config);
    if (path === "/api/reconciliation" || path === "/api/reconciliation/query") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
    if (path.endsWith("/keys")) return fulfill(route, onboardingKeys);
    if (path === "/api/reconciliation/rules/rule-1") {
      writes.push({ method: request.method(), body: request.postDataJSON() });
      config.rules[0].channels.push({ channelId: 4, name: "New channel" });
      return fulfill(route, { rule: config.rules[0] });
    }
    throw new Error(`unexpected onboarding request: ${path}`);
  });
  await page.getByRole("button", { name: "接入渠道 New channel" }).click();
  const drawer = await selectOnboardingKey(page);
  await drawer.getByText("加入已有对账规则", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "确认关联" }).click();
  await drawer.waitFor({ state: "hidden" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  assert.deepEqual(writes[0].body.salesChannelIds, [1, 4]);
  assert.equal(writes[0].body.tokenId, 7);
  await page.getByRole("button", { name: "接入渠道 New channel" }).waitFor({ state: "hidden" });
});

test("first-time onboarding prefills channel details and connects a monitor before the one-time Key association", async (t) => {
  const config = onboardingFixture(false);
  const accounts = [];
  const bindings = [];
  const page = await openFixturePage(t, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") return fulfill(route, config);
    if (path === "/api/reconciliation" || path === "/api/reconciliation/query") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
    if (path === "/api/reconciliation/upstreams") {
      accounts.push(request.postDataJSON());
      const station = { id: "new-up", name: "New channel", type: "newapi", baseUrl: "https://up.example" };
      config.upstreams.push(station);
      return fulfill(route, { station, created: true });
    }
    if (path.endsWith("/keys")) return fulfill(route, onboardingKeys);
    if (path === "/api/reconciliation/rules") {
      bindings.push(request.postDataJSON());
      return fulfill(route, {});
    }
    throw new Error(`unexpected onboarding request: ${path}`);
  }, { width: 390, height: 844 });
  await page.getByRole("button", { name: "接入渠道 New channel" }).click();
  const drawer = page.getByRole("dialog", { name: "接入监控与对账" });
  assert.equal(await drawer.getByLabel("上游站点地址", { exact: true }).inputValue(), "https://up.example");
  assert.equal(await drawer.getByLabel("上游账号名称", { exact: true }).inputValue(), "New channel");
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-pat");
  await drawer.getByRole("button", { name: "验证并接入账号" }).click();
  await drawer.getByText("账号已接入资源监控", { exact: true }).waitFor();
  await selectOnboardingKey(page);
  await drawer.getByRole("button", { name: "确认关联" }).click();
  await drawer.waitFor({ state: "hidden" });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accessToken, "fixture-pat");
  assert.deepEqual(bindings[0].salesChannelIds, [4]);
  assert.equal(bindings[0].upstreamStationId, "new-up");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
});

test("failed Key reads retain the connected account and offer an in-place retry", async (t) => {
  const config = onboardingFixture();
  let attempts = 0;
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") return fulfill(route, config);
    if (path === "/api/reconciliation") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
    if (path.endsWith("/keys")) {
      attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Key directory unavailable" }) });
      return fulfill(route, onboardingKeys);
    }
    throw new Error(`unexpected onboarding request: ${path}`);
  });
  await page.getByRole("button", { name: "接入渠道 New channel" }).click();
  const drawer = page.getByRole("dialog", { name: "接入监控与对账" });
  await drawer.getByText("Key directory unavailable", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "重新读取 Key" }).click();
  await selectOnboardingKey(page);
  assert.equal(attempts, 2);
});

test("visible-page discovery finds a newly added channel without re-entering its sales group", async (t) => {
  const config = onboardingFixture();
  let reads = 0;
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") { reads += 1; return fulfill(route, config); }
    if (path === "/api/reconciliation" || path === "/api/reconciliation/query") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
    throw new Error(`unexpected discovery request: ${path}`);
  }, undefined, true);
  config.channels.push({ id: 5, name: "Later channel", baseUrl: "https://up.example", status: 1, groups: ["new-sales-group"] });
  await page.clock.fastForward(60000);
  await page.getByRole("button", { name: "接入渠道 Later channel" }).waitFor();
  await page.getByText("本站分组：new-sales-group", { exact: true }).waitFor();
  assert.ok(reads >= 2);
});

test("failed discovery keeps the previous channel visible and disables stale onboarding", async (t) => {
  const config = onboardingFixture();
  let reads = 0;
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") {
      reads += 1;
      return fulfill(route, reads > 1 ? { ...config, channels: [], channelsError: "目录暂不可用" } : config);
    }
    if (path === "/api/reconciliation") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
    throw new Error(`unexpected discovery request: ${path}`);
  });
  await page.getByRole("button", { name: "发现新渠道", exact: true }).click();
  await page.getByText("渠道目录读取失败，正在显示上次发现的渠道", { exact: true }).waitFor();
  const action = page.getByRole("button", { name: "接入渠道 New channel" });
  assert.equal(await action.isVisible(), true);
  assert.equal(await action.isDisabled(), true);
});

test("channel discovery and first-time connection fit compact, tablet and desktop widths", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const config = onboardingFixture(false);
    const page = await openFixturePage(t, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
      if (path === "/api/reconciliation/configuration") return fulfill(route, config);
      if (path === "/api/reconciliation") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
      throw new Error(`unexpected layout request: ${path}`);
    }, { width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px discovery list`);
    await page.getByRole("button", { name: "接入渠道 New channel" }).click();
    await page.getByRole("dialog", { name: "接入监控与对账" }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "接入监控与对账" }).locator(".ant-drawer-body").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `${width}px connection drawer`);
    await page.close();
  }
});

test("slow channel discovery does not start overlapping automatic directory requests", { timeout: 30000 }, async (t) => {
  const config = onboardingFixture();
  let reads = 0;
  let deferred;
  let started;
  const discoveryStarted = new Promise((resolve) => { started = resolve; });
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") {
      reads += 1;
      if (reads === 1) return fulfill(route, config);
      return new Promise((resolve) => { deferred = { route, resolve }; started(); });
    }
    if (path === "/api/reconciliation" || path === "/api/reconciliation/query") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
    throw new Error(`unexpected discovery request: ${path}`);
  }, undefined, true);
  await page.getByRole("button", { name: "发现新渠道", exact: true }).click();
  await discoveryStarted;
  await page.clock.fastForward(120000);
  assert.equal(reads, 2);
  deferred.resolve(fulfill(deferred.route, config));
  await page.getByRole("button", { name: "发现新渠道", exact: true }).waitFor();
});

test("two rule retries retain both independently returned amounts", async (t) => {
  const deferred = new Map();
  const requestStarted = new Map();
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (url.pathname === "/api/reconciliation") return fulfill(route, initial);
    if (url.pathname === "/api/reconciliation/query") {
      const { ruleIds } = route.request().postDataJSON();
      if (ruleIds?.[0]) return new Promise((resolve) => {
        deferred.set(ruleIds[0], { route, resolve });
        requestStarted.get(ruleIds[0])();
      });
    }
    return fulfill(route, { message: "unexpected API request" });
  });

  const rowA = page.locator("tr", { hasText: "Rule A" });
  const rowB = page.locator("tr", { hasText: "Rule B" });
  await rowA.getByText("$10.00", { exact: true }).waitFor();
  await rowB.getByText("$20.00", { exact: true }).waitFor();
  const retryAStarted = new Promise((resolve) => requestStarted.set("rule-1", resolve));
  const retryBStarted = new Promise((resolve) => requestStarted.set("rule-2", resolve));
  await rowA.getByRole("button", { name: /重试.*Rule A/ }).click();
  await rowB.getByRole("button", { name: /重试.*Rule B/ }).click();
  await retryAStarted;
  await retryBStarted;
  deferred.get("rule-1").resolve(fulfill(deferred.get("rule-1").route, response([rule("rule-1", "Rule A", 101)])));
  await page.locator("tr", { hasText: "$101.00" }).waitFor();
  deferred.get("rule-2").resolve(fulfill(deferred.get("rule-2").route, response([rule("rule-2", "Rule B", 41)])));
  await page.locator("tr", { hasText: "$41.00" }).waitFor();
});

test("a same-preset refresh marks old totals as reference until its replacement arrives", async (t) => {
  let deferred;
  let startQuery;
  const queryStarted = new Promise((resolve) => { startQuery = resolve; });
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (url.pathname === "/api/reconciliation") return fulfill(route, initial);
    if (url.pathname === "/api/reconciliation/query") return new Promise((resolve) => { deferred = { route, resolve }; startQuery(); });
    return fulfill(route, { message: "unexpected API request" });
  });

  await page.locator("tr", { hasText: "$10.00" }).waitFor();
  const summary = page.locator(".reconciliation-summary");
  await summary.getByText("$60.00", { exact: true }).waitFor();
  await summary.getByText("$57.00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前对账窗口" }).click();
  await queryStarted;
  await page.getByText("本站收费（本次）", { exact: true }).waitFor();
  await page.locator("tr", { hasText: "$10.00" }).waitFor();
  await summary.getByText("待获取", { exact: true }).first().waitFor();
  await summary.getByText("$60.00", { exact: true }).waitFor({ state: "hidden" });
  await summary.getByText("本次查询尚未取得当前窗口金额", { exact: false }).waitFor();
  deferred.resolve(fulfill(deferred.route, response([rule("rule-1", "Rule A", 11), rule("rule-2", "Rule B", 21), rule("rule-3", "Rule C", 31)])));
  await page.getByText("本站收费（本次）", { exact: true }).waitFor({ state: "hidden" });
  await summary.getByText("$63.00", { exact: true }).waitFor();
  await page.locator("tr", { hasText: "$11.00" }).waitFor();
});

test("a later retry may finish before an earlier retry without losing either result", async (t) => {
  const deferred = new Map();
  const started = new Map();
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const id = route.request().postDataJSON().ruleIds?.[0];
      return new Promise((resolve) => { deferred.set(id, { route, resolve }); started.get(id)(); });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const readyA = new Promise((resolve) => started.set("rule-1", resolve));
  const readyB = new Promise((resolve) => started.set("rule-2", resolve));
  await page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: /重试.*Rule A/ }).click();
  await page.locator("tr", { hasText: "Rule B" }).getByRole("button", { name: /重试.*Rule B/ }).click();
  await Promise.all([readyA, readyB]);
  deferred.get("rule-2").resolve(fulfill(deferred.get("rule-2").route, response([rule("rule-2", "Rule B", 42)])));
  await page.locator("tr", { hasText: "$42.00" }).waitFor();
  deferred.get("rule-1").resolve(fulfill(deferred.get("rule-1").route, response([rule("rule-1", "Rule A", 102)])));
  await page.locator("tr", { hasText: "$102.00" }).waitFor();
});

test("one failed retry leaves another rule's successful result and controls usable", async (t) => {
  const deferred = new Map();
  const started = new Map();
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const id = route.request().postDataJSON().ruleIds?.[0];
      return new Promise((resolve) => { deferred.set(id, { route, resolve }); started.get(id)(); });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const readyA = new Promise((resolve) => started.set("rule-1", resolve));
  const readyB = new Promise((resolve) => started.set("rule-2", resolve));
  const rowA = page.locator("tr", { hasText: "Rule A" });
  const rowB = page.locator("tr", { hasText: "Rule B" });
  const retryAButton = rowA.getByRole("button", { name: /重试.*Rule A/ });
  const retryBButton = rowB.getByRole("button", { name: /重试.*Rule B/ });
  await retryAButton.click();
  await retryBButton.click();
  await Promise.all([readyA, readyB]);
  deferred.get("rule-2").resolve(fulfill(deferred.get("rule-2").route, response([rule("rule-2", "Rule B", 43)])));
  await rowB.getByText("$43.00", { exact: true }).waitFor();
  await retryBButton.locator(".ant-btn-loading-icon").waitFor({ state: "hidden" });
  deferred.get("rule-1").resolve(deferred.get("rule-1").route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture retry failure" }) }));
  await rowA.getByText("fixture retry failure", { exact: true }).waitFor();
  await rowB.getByText("$43.00", { exact: true }).waitFor();
});

test("a late single-rule response from an old window cannot replace a newer window", async (t) => {
  const oldWindow = window;
  const newWindow = { preset: "7d", startMs: 10, endMs: 2000, timezone: "Asia/Shanghai" };
  const deferred = {};
  const started = {};
  const initial = response([rule("rule-1", "Rule A", 10, oldWindow), rule("rule-2", "Rule B", 20, oldWindow), rule("rule-3", "Rule C", 30, oldWindow)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const body = route.request().postDataJSON();
      const key = body.ruleIds?.[0] ? "oldRetry" : "newWindow";
      return new Promise((resolve) => { deferred[key] = { route, resolve }; started[key](); });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const oldRetryStarted = new Promise((resolve) => { started.oldRetry = resolve; });
  const newWindowStarted = new Promise((resolve) => { started.newWindow = resolve; });
  const retryAButton = page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: /重试.*Rule A/ });
  await retryAButton.click();
  await oldRetryStarted;
  await page.getByText("近 7 天", { exact: true }).click();
  await page.locator(".reconciliation-query-action").first().click();
  await newWindowStarted;
  deferred.newWindow.resolve(fulfill(deferred.newWindow.route, response([rule("rule-1", "Rule A", 70, newWindow), rule("rule-2", "Rule B", 80, newWindow), rule("rule-3", "Rule C", 90, newWindow)])));
  await page.locator("tr", { hasText: "$70.00" }).waitFor();
  await retryAButton.locator(".ant-btn-loading-icon").waitFor();
  deferred.oldRetry.resolve(fulfill(deferred.oldRetry.route, response([rule("rule-1", "Rule A", 101, oldWindow)])));
  await retryAButton.locator(".ant-btn-loading-icon").waitFor({ state: "hidden" });
  await page.locator("tr", { hasText: "$70.00" }).waitFor();
  await page.locator("tr", { hasText: "$101.00" }).waitFor({ state: "hidden" });
});

test("a bulk response replaces a newer retry when their actual windows differ", async (t) => {
  const bulkWindow = { preset: "today", startMs: 2000, endMs: 3000, timezone: "Asia/Shanghai" };
  let bulk;
  let retry;
  let resolveBulkStarted;
  let resolveRetryStarted;
  const bulkStarted = new Promise((resolve) => { resolveBulkStarted = resolve; });
  const retryStarted = new Promise((resolve) => { resolveRetryStarted = resolve; });
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const isRetry = Boolean(route.request().postDataJSON().ruleIds?.[0]);
      return new Promise((resolve) => {
        if (isRetry) { retry = { route, resolve }; resolveRetryStarted(); }
        else { bulk = { route, resolve }; resolveBulkStarted(); }
      });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const summary = page.locator(".reconciliation-summary");
  await summary.getByText("$60.00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前对账窗口" }).click();
  await bulkStarted;
  await page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: /重试.*Rule A/ }).click();
  await retryStarted;
  const retryDelivery = fulfill(retry.route, response([rule("rule-1", "Rule A", 101)]));
  retry.resolve(retryDelivery);
  await retryDelivery;
  await page.locator("tr", { hasText: "$101.00" }).waitFor();
  bulk.resolve(fulfill(bulk.route, response([rule("rule-1", "Rule A", 70, bulkWindow), rule("rule-2", "Rule B", 80, bulkWindow), rule("rule-3", "Rule C", 90, bulkWindow)])));
  await page.locator("tr", { hasText: "$70.00" }).waitFor();
  await page.locator("tr", { hasText: "$101.00" }).waitFor({ state: "hidden" });
  await summary.getByText("$240.00", { exact: true }).waitFor();
});

test("a late bulk response for the same window preserves a newer rule retry", async (t) => {
  let bulk;
  let retry;
  let resolveBulkStarted;
  let resolveRetryStarted;
  const bulkStarted = new Promise((resolve) => { resolveBulkStarted = resolve; });
  const retryStarted = new Promise((resolve) => { resolveRetryStarted = resolve; });
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const isRetry = Boolean(route.request().postDataJSON().ruleIds?.[0]);
      return new Promise((resolve) => {
        if (isRetry) { retry = { route, resolve }; resolveRetryStarted(); }
        else { bulk = { route, resolve }; resolveBulkStarted(); }
      });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const rowA = page.locator("tr", { hasText: "Rule A" });
  const retryAButton = rowA.getByRole("button", { name: /重试.*Rule A/ });
  const summary = page.locator(".reconciliation-summary");
  await page.getByRole("button", { name: "刷新当前对账窗口" }).click();
  await bulkStarted;
  await retryAButton.click();
  await retryStarted;
  retry.resolve(fulfill(retry.route, response([rule("rule-1", "Rule A", 101)])));
  await rowA.getByText("$101.00", { exact: true }).waitFor();
  bulk.resolve(fulfill(bulk.route, response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)])));
  await retryAButton.locator(".ant-btn-loading-icon").waitFor({ state: "hidden" });
  await rowA.getByText("$101.00", { exact: true }).waitFor();
  await summary.getByText("$151.00", { exact: true }).waitFor();
});

async function verifyMobileRefreshAndRetry(t, width) {
  let retry;
  let refresh;
  let resolveRetryStarted;
  let resolveRefreshStarted;
  const retryRequestStarted = new Promise((resolve) => { resolveRetryStarted = resolve; });
  const refreshRequestStarted = new Promise((resolve) => { resolveRefreshStarted = resolve; });
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const target = route.request().postDataJSON().ruleIds?.[0] ? "retry" : "refresh";
      return new Promise((resolve) => {
        if (target === "retry") { retry = { route, resolve }; resolveRetryStarted(); }
        else { refresh = { route, resolve }; resolveRefreshStarted(); }
      });
    }
    return fulfill(route, { message: "unexpected API request" });
  }, { width, height: 844 });
  const cardA = page.locator(".reconciliation-mobile-item", { hasText: "Rule A" });
  const summary = page.locator(".reconciliation-summary");
  await cardA.waitFor();
  if (!(await cardA.textContent())?.includes("$10.00")) throw new Error(`unexpected mobile card: ${await cardA.textContent()}`);
  await cardA.getByRole("button", { name: "重试当前规则", exact: true }).click();
  await retryRequestStarted;
  retry.resolve(fulfill(retry.route, response([rule("rule-1", "Rule A", 101)])));
  await cardA.getByText("$101.00").waitFor();
  await summary.getByText("$151.00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前对账窗口" }).click();
  await refreshRequestStarted;
  await cardA.getByText("$101.00").waitFor();
  await page.getByText("本站收费（本次）", { exact: true }).waitFor();
  await summary.getByText("待获取", { exact: true }).first().waitFor();
  await summary.getByText("$151.00", { exact: true }).waitFor({ state: "hidden" });
  await page.getByText("本次查询尚未取得当前窗口金额", { exact: false }).waitFor();
  refresh.resolve(fulfill(refresh.route, response([rule("rule-1", "Rule A", 11), rule("rule-2", "Rule B", 21), rule("rule-3", "Rule C", 31)])));
  await cardA.getByText("$11.00").waitFor();
  await summary.getByText("$63.00", { exact: true }).waitFor();
  if (!await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)) throw new Error(`${width}px document root overflows horizontally`);
}

test("390px mobile refresh and retry remain usable without root overflow", async (t) => {
  await verifyMobileRefreshAndRetry(t, 390);
});

test("320px mobile refresh and retry remain usable without root overflow", async (t) => {
  await verifyMobileRefreshAndRetry(t, 320);
});
