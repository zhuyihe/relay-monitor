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

async function openFixturePage(t, handler, viewport, clock = false, onboardingHandler = null) {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chromium" });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "block", ...(viewport ? { viewport, isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  page.setDefaultTimeout(5_000);
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname.startsWith("/api/channel-onboarding")) {
      return onboardingHandler ? onboardingHandler(route) : fulfill(route, { ownStation: null, channels: [], upstreams: [], rules: [], stale: false });
    }
    return handler(route);
  });
  await page.goto(`${baseURL}/reconciliation`, { timeout: 30000 });
  await page.getByText("Rule A").first().waitFor();
  return page;
}

async function fulfill(route, body) {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

function onboardingFixture(existing = true, type = "newapi") {
  return {
    ownStation: { id: "own-1", baseUrl: "https://own.example" },
    upstreams: existing ? [{ id: "upstream-1", name: "Fixture upstream", type, monitorEnabled: true, baseUrl: "https://up.example" }] : [],
    channels: [{ id: 4, name: "New channel", status: 1, baseUrl: "https://up.example", groups: ["local-sales"], revision: "revision-4", candidates: existing ? ["upstream-1"] : [], monitor: { status: "unlinked", stationIds: [] }, reconciliation: { status: "unconfigured", ruleIds: [] } }],
    rules: existing ? [{ ...rule("rule-1", "Rule A", 10).rule, ownStationId: "own-1", tokenId: 7, enabled: true }] : [],
    syncedAt: "2026-10-09T06:00:00.000Z", stale: false,
  };
}
const onboardingTokens = [
  { id: 7, name: "Supplier Key", status: 1, group: "upstream-group" },
  { id: 8, name: "New Key", status: 1, group: "upstream-group" },
];
const preview = { billingEffectiveFromMs: Date.parse("2026-10-10T00:00:00+08:00"), timezone: "Asia/Shanghai", costCoverage: "unknown" };

function probeResult(body) {
  return {
    station: { id: body.stationId || "new-up", name: "New channel" },
    monitor: { status: "verified" },
    reconciliation: body.reconciliation ? {
      status: "ready", tokens: onboardingTokens, upstreamStationId: body.reconciliation.upstreamStationId || body.stationId,
      existingRuleId: body.reconciliation.tokenId === 7 ? "rule-1" : null,
      existingChannelIds: body.reconciliation.tokenId === 7 ? [1] : [],
    } : { status: "not_requested" },
    preview: { ...preview, costCoverage: body.reconciliation?.costCoverage || "unknown" },
    channelRevision: "revision-4",
  };
}

async function openOnboardingPage(t, options = {}) {
  const config = options.config || onboardingFixture();
  const probes = [];
  const writes = [];
  const reads = [];
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (path === "/api/reconciliation" || path === "/api/reconciliation/query") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
    if (options.extraAPI) return options.extraAPI(route, path);
    throw new Error(`unexpected onboarding request: ${path}`);
  }, options.viewport, !!options.clock, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" || path.endsWith("/sync")) {
      reads.push({ path, method: request.method() });
      return options.discovery ? options.discovery(route, reads, config) : fulfill(route, config);
    }
    const body = request.postDataJSON();
    if (path.endsWith("/probe")) {
      probes.push(body);
      return options.probe ? fulfill(route, options.probe(body, probes.length)) : fulfill(route, probeResult(body));
    }
    assert.equal(path, "/api/channel-onboarding");
    writes.push(body);
    if (options.connect) return options.connect(route, body, writes.length);
    config.channels[0].monitor = { status: "linked", stationIds: [body.stationId || "new-up"] };
    config.channels[0].reconciliation = { status: body.reconciliation ? "configured" : "unconfigured", ruleIds: body.reconciliation ? ["rule-1"] : [] };
    return fulfill(route, { complete: true, monitor: { status: "linked", stationIds: config.channels[0].monitor.stationIds }, reconciliation: { status: body.reconciliation ? "configured" : "not_requested" }, saved: { stationIds: config.channels[0].monitor.stationIds, link: true } });
  });
  await page.getByRole("button", { name: "发现新渠道", exact: true }).waitFor();
  await page.getByRole("button", { name: "接入渠道 New channel" }).waitFor();
  await page.getByRole("button", { name: "接入渠道 New channel" }).click({ trial: true });
  return { page, config, probes, writes, reads };
}

async function openOnboardingDrawer(page) {
  const action = page.getByRole("button", { name: "接入渠道 New channel" });
  // 入场同步结束后才允许接入。
  await action.waitFor();
  await action.click();
  return page.getByRole("dialog", { name: "接入监控与对账" });
}
async function chooseKey(page, drawer, name = "Supplier Key") {
  await drawer.getByRole("combobox", { name: "接入上游 Key" }).click();
  await page.getByText(`${name} · 上游分组 upstream-group`, { exact: true }).last().click();
}
async function enableBilling(page, drawer, key = "Supplier Key") {
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click();
  const devBadge = page.getByRole("button", { name: "Collapse issues badge", exact: true });
  if (await devBadge.isVisible()) await devBadge.click();
  await drawer.getByRole("button", { name: "验证并预览", exact: true }).click();
  await drawer.getByText("监控连接已验证，尚未保存", { exact: true }).waitFor();
  await chooseKey(page, drawer, key);
  await drawer.getByRole("combobox", { name: "Key 消费范围" }).click();
  await page.getByText("该 Key 仅供已关联及本次加入的渠道使用", { exact: true }).last().click();
  assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true);
  if (await devBadge.isVisible()) await devBadge.click();
  await drawer.getByRole("button", { name: "验证并预览", exact: true }).click();
}
async function saveOnboarding(drawer) {
  await drawer.getByRole("button", { name: "确认关联", exact: true }).click();
  await drawer.waitFor({ state: "hidden" });
}

test("an existing account and Key are reused through one server-side channel append", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t);
  const drawer = await openOnboardingDrawer(page);
  assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 0);
  await enableBilling(page, drawer);
  await drawer.getByText("加入已有对账规则", { exact: true }).waitFor();
  await drawer.getByText("已有渠道：#1；本次加入：New channel", { exact: true }).waitFor();
  await saveOnboarding(drawer);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].stationId, "upstream-1");
  assert.equal(writes[0].channelId, 4);
  assert.equal(writes[0].reconciliation.tokenId, 7);
  assert.equal(writes[0].reconciliation.costCoverage, "complete");
  assert.equal(writes[0].reconciliation.previewEffectiveFromMs, preview.billingEffectiveFromMs);
  assert.equal("salesChannelIds" in writes[0], false);
  assert.equal(probes.length, 2);
  await page.getByText("监控：已关联", { exact: true }).waitFor();
});

test("an existing account can add a new Key without creating another monitoring account", async (t) => {
  const { page, writes } = await openOnboardingPage(t);
  const drawer = await openOnboardingDrawer(page);
  await enableBilling(page, drawer, "New Key");
  await saveOnboarding(drawer);
  assert.equal(writes[0].stationId, "upstream-1");
  assert.equal(writes[0].reconciliation.tokenId, 8);
  assert.equal("newStation" in writes[0], false);
});

test("first-time New API onboarding verifies without saving and confirms monitoring and billing once", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(false), viewport: { width: 390, height: 844 } });
  const drawer = await openOnboardingDrawer(page);
  assert.equal(await drawer.getByLabel("上游站点地址", { exact: true }).inputValue(), "https://up.example");
  assert.equal(await drawer.getByLabel("上游资源名称", { exact: true }).inputValue(), "New channel");
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-pat");
  await enableBilling(page, drawer);
  assert.equal(writes.length, 0);
  await saveOnboarding(drawer);
  assert.equal(probes[0].newStation.accessToken, "fixture-pat");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].newStation.accessToken, "fixture-pat");
  assert.equal(writes[0].reconciliation.tokenId, 7);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
});

test("monitor-only onboarding needs no Key or billing credential and cancelling a probe saves nothing", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-pat");
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await drawer.getByText("监控连接已验证，尚未保存", { exact: true }).waitFor();
  assert.equal(probes[0].reconciliation, undefined);
  assert.equal(writes.length, 0);
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  await drawer.waitFor({ state: "hidden" });
  assert.equal(writes.length, 0);
  const reopened = await openOnboardingDrawer(page);
  await reopened.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-pat");
  await reopened.getByRole("button", { name: "验证并预览" }).click();
  await saveOnboarding(reopened);
  assert.equal(writes[0].reconciliation, undefined);
});

test("Sub2API password onboarding clears hidden credentials and retains a pending billing result", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, {
    config: onboardingFixture(false),
    probe: (body) => ({ ...probeResult(body), reconciliation: { status: "unverified", tokens: [], reason: "实际部署扣费字段待验证" } }),
    connect: (route) => fulfill(route, { complete: false, monitor: { status: "linked" }, reconciliation: { status: "unverified", reason: "实际部署扣费字段待验证" }, saved: { stationIds: ["sub-up"], link: true }, retryInput: { stationId: "sub-up" } }),
  });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("discarded-pat");
  await drawer.getByLabel("监控方式", { exact: true }).click();
  await page.getByText("Sub2API · 账号密码", { exact: true }).last().click();
  await drawer.getByLabel("上游登录邮箱", { exact: true }).fill("fixture@example.com");
  await drawer.getByLabel("上游登录密码", { exact: true }).fill("fixture-password");
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click();
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await drawer.getByText("账单能力待验证", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "确认关联" }).click();
  await drawer.getByText("接入尚有待完成步骤，已保存部分会继续复用", { exact: true }).waitFor();
  assert.equal(probes[0].newStation.type, "sub2api-password");
  assert.equal("accessToken" in probes[0].newStation, false);
  assert.equal(writes[0].newStation.password, "fixture-password");
  assert.equal(await drawer.isVisible(), true);
});

test("a Key monitor supplements billing authorization in the same flow without another monitor", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi-key") });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click();
  await drawer.getByText("账单授权只补一次", { exact: true }).waitFor();
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("billing-only-pat");
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await chooseKey(page, drawer);
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await saveOnboarding(drawer);
  assert.equal(writes[0].stationId, "upstream-1");
  assert.equal(writes[0].newStation, undefined);
  assert.equal(writes[0].reconciliation.newAuthorization.accessToken, "billing-only-pat");
  assert.deepEqual(writes[0].additionalMonitorStationIds, []);
});

test("additional account and Key monitors show the existing whole-monitor cost overlap before confirmation", async (t) => {
  const config = onboardingFixture();
  config.upstreams.push({ id: "key-monitor", name: "Existing Key monitor", type: "newapi-key", monitorEnabled: true, baseUrl: "https://up.example" });
  const { page, writes } = await openOnboardingPage(t, { config });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("combobox", { name: "其他监控资源" }).click();
  await page.getByText("Existing Key monitor", { exact: true }).last().click();
  await drawer.getByText("核对整体监控成本", { exact: true }).waitFor();
  await drawer.getByText("账号余额与 Key 额度可能覆盖同一消费。", { exact: false }).waitFor();
  await drawer.getByRole("combobox", { name: "其他监控资源" }).press("Escape");
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await saveOnboarding(drawer);
  assert.deepEqual(writes[0].additionalMonitorStationIds, ["key-monitor"]);
  assert.equal(writes[0].includeInProfit, undefined);
});

test("editing connection fields invalidates a successful probe while changing the display name preserves it", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-pat");
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  const confirm = drawer.getByRole("button", { name: "确认关联" });
  await confirm.click({ trial: true });
  await drawer.getByLabel("上游资源名称", { exact: true }).fill("Renamed upstream");
  assert.equal(await confirm.isDisabled(), false);
  await drawer.getByLabel("上游站点地址", { exact: true }).fill("https://changed.example");
  assert.equal(await confirm.isDisabled(), true);
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await saveOnboarding(drawer);
  assert.equal(probes.length, 2);
  assert.equal(writes[0].newStation.baseUrl, "https://changed.example");
});

test("a partial save retries using saved IDs while retaining an authorization that was not saved", async (t) => {
  const { page, writes } = await openOnboardingPage(t, {
    config: onboardingFixture(false),
    connect: (route, body, count) => fulfill(route, count === 1 ? {
      complete: false, monitor: { status: "linked" }, reconciliation: { status: "unavailable", reason: "账单保存暂时失败" },
      saved: { stationIds: ["new-up"], link: true }, retryInput: { stationId: "new-up" },
    } : { complete: true, monitor: { status: "linked" }, reconciliation: { status: "configured" }, saved: { stationIds: ["new-up"], ruleId: "new-rule" } }),
  });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByLabel("监控方式", { exact: true }).click();
  await page.getByText("New API · Key 额度", { exact: true }).last().click();
  await drawer.getByLabel("上游 API Key", { exact: true }).fill("fixture-key");
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click();
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("billing-only-pat");
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await chooseKey(page, drawer);
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await drawer.getByRole("button", { name: "确认关联" }).click();
  await drawer.getByText("账单保存暂时失败", { exact: false }).waitFor();
  await drawer.getByRole("button", { name: "重试未完成步骤" }).click();
  await drawer.waitFor({ state: "hidden" });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].stationId, "new-up");
  assert.equal(writes[1].newStation, undefined);
  assert.equal(writes[1].reconciliation.newAuthorization.accessToken, "billing-only-pat");
  assert.equal(writes[1].reconciliation.tokenId, 7);
});

test("same-account credential replacement requires an explicit confirmation in the drawer", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false), probe: (body) => ({ ...probeResult(body), credentialUpdateRequired: true }) });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("replacement-pat");
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await drawer.getByText("已发现相同账号，确认用本次授权更新已有凭证", { exact: true }).waitFor();
  assert.equal(await drawer.getByRole("button", { name: "确认关联" }).isDisabled(), true);
  await drawer.getByText("已发现相同账号，确认用本次授权更新已有凭证", { exact: true }).click();
  await saveOnboarding(drawer);
  assert.equal(writes[0].updateCredentials, true);
  assert.equal(writes[0].newStation.accessToken, "replacement-pat");
});

test("a saved billing authorization can be updated after partial onboarding in the same drawer", async (t) => {
  const config = onboardingFixture(true, "newapi-key");
  const { page, writes } = await openOnboardingPage(t, {
    config,
    probe: (body) => body.reconciliation?.newAuthorization?.accessToken === "billing-pat-new"
      ? { ...probeResult(body), credentialUpdateRequired: true }
      : { ...probeResult(body), reconciliation: { status: "unavailable", tokens: [], reason: "原授权无法读取 Key 目录" } },
    connect: (route, body, count) => {
      if (count === 1) {
        config.upstreams.push({ id: "billing-grant", name: "Saved billing grant", type: "newapi", monitorEnabled: false, baseUrl: "https://up.example" });
        return fulfill(route, { complete: false, monitor: { status: "linked" }, reconciliation: { status: "unavailable", reason: "原授权无法读取 Key 目录" }, saved: { stationIds: ["upstream-1"], authorizationStationId: "billing-grant", link: true }, retryInput: { stationId: "upstream-1", updateCredentials: false, reconciliation: { upstreamStationId: "billing-grant" } } });
      }
      return fulfill(route, { complete: true, monitor: { status: "linked" }, reconciliation: { status: "configured" }, saved: { stationIds: ["upstream-1"], authorizationStationId: "billing-grant", ruleId: "rule-1" } });
    },
  });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click();
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("billing-pat-old");
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await drawer.getByRole("button", { name: "确认关联" }).click();
  await drawer.getByText("接入尚有待完成步骤，已保存部分会继续复用", { exact: true }).waitFor();
  await drawer.getByRole("combobox", { name: "接入账单授权" }).click();
  await page.getByText("补充或更新账号账单授权", { exact: true }).last().click();
  await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("billing-pat-new");
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await drawer.getByText("已发现相同账号，确认用本次授权更新已有凭证", { exact: true }).click();
  await chooseKey(page, drawer);
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await drawer.getByRole("button", { name: "重试未完成步骤" }).click();
  await drawer.waitFor({ state: "hidden" });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].stationId, "upstream-1");
  assert.equal(writes[1].newStation, undefined);
  assert.equal(writes[1].updateCredentials, true);
  assert.equal(writes[1].reconciliation.upstreamStationId, undefined);
  assert.equal(writes[1].reconciliation.newAuthorization.accessToken, "billing-pat-new");
});

test("the resources page uses the same monitor-only channel onboarding without a page switch", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { extraAPI: (route, path) => {
    if (path === "/api/stations") return fulfill(route, { stations: [], settings: {} });
    if (path === "/api/meta") return fulfill(route, { types: [], rules: [] });
    throw new Error(`unexpected resources request: ${path}`);
  } });
  await page.goto(`${baseURL}/stations`, { timeout: 30000 });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await saveOnboarding(drawer);
  assert.equal(new URL(page.url()).pathname, "/stations");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].stationId, "upstream-1");
  assert.equal(writes[0].reconciliation, undefined);
});

test("a midnight preview change requires revalidation and uses the new complete-day boundary", async (t) => {
  const nextPreview = { ...preview, billingEffectiveFromMs: preview.billingEffectiveFromMs + 86400000 };
  const { page, writes } = await openOnboardingPage(t, {
    probe: (body, count) => ({ ...probeResult(body), preview: count > 2 ? nextPreview : preview }),
    connect: (route, body, count) => fulfill(route, count === 1 ? { complete: false, monitor: { status: "linked" }, reconciliation: { status: "pending", reason: "完整日边界已变化" }, code: "EFFECTIVE_PREVIEW_CHANGED", preview: nextPreview, saved: { stationIds: ["upstream-1"], link: true }, retryInput: { stationId: "upstream-1" } } : { complete: true, monitor: { status: "linked" }, reconciliation: { status: "configured" } }),
  });
  const drawer = await openOnboardingDrawer(page);
  await enableBilling(page, drawer);
  await drawer.getByRole("button", { name: "确认关联" }).click();
  await drawer.getByText("完整日边界已变化，请重新验证并确认新的生效时间。", { exact: true }).waitFor();
  assert.equal(await drawer.getByRole("button", { name: "重试未完成步骤" }).isDisabled(), true);
  await drawer.getByRole("button", { name: "验证并预览" }).click();
  await drawer.getByRole("button", { name: "重试未完成步骤" }).click();
  await drawer.waitFor({ state: "hidden" });
  assert.equal(writes[1].reconciliation.previewEffectiveFromMs, nextPreview.billingEffectiveFromMs);
});

test("manual discovery finds a new channel and no page-minute polling repeats the sync", async (t) => {
  const { page, config, reads } = await openOnboardingPage(t, { clock: true });
  const initial = reads.length;
  config.channels.push({ ...config.channels[0], id: 5, name: "Later channel", groups: ["new-sales-group"] });
  await page.clock.fastForward(60000);
  assert.equal(reads.length, initial);
  await page.getByRole("button", { name: "发现新渠道", exact: true }).click();
  await page.getByRole("button", { name: "接入渠道 Later channel" }).waitFor();
  await page.getByText("本站分组：new-sales-group", { exact: true }).waitFor();
});

test("failed discovery keeps the previous catalogue visible and disables stale onboarding", async (t) => {
  let failed = false;
  const { page } = await openOnboardingPage(t, {
    discovery: (route, reads, config) => fulfill(route, failed ? { ...config, channels: [], stale: true, error: "目录暂不可用" } : config),
  });
  failed = true;
  await page.getByRole("button", { name: "发现新渠道", exact: true }).click();
  await page.getByText("渠道目录读取失败，正在显示上次发现的渠道", { exact: true }).waitFor();
  const action = page.getByRole("button", { name: "接入渠道 New channel" });
  assert.equal(await action.isVisible(), true);
  assert.equal(await action.isDisabled(), true);
});

test("channel discovery and first-time forms fit compact, tablet and desktop widths", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page } = await openOnboardingPage(t, { config: onboardingFixture(false), viewport: { width, height: 900 } });
    const drawer = await openOnboardingDrawer(page);
    await drawer.getByLabel("上游系统访问令牌", { exact: true }).waitFor();
    assert.ok((await page.getByRole("button", { name: "发现新渠道", exact: true }).boundingBox()).height >= 40, `${width}px discover touch target`);
    assert.ok((await drawer.getByRole("button", { name: "确认关联", exact: true }).boundingBox()).height >= 44, `${width}px confirm touch target`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px root`);
    assert.equal(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth), true, `${width}px drawer`);
  }
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
