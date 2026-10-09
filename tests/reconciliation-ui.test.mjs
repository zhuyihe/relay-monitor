// Start the local dev server first. Set PLAYWRIGHT_MODULE to a Playwright module
// path when it is bundled outside this project, and PLAYWRIGHT_CHANNEL=msedge
// when Chromium is unavailable locally.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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

function onboardingFixture(existing = true, type = "newapi", ids = [4]) {
  return {
    ownStation: { id: "own-1", baseUrl: "https://own.example" },
    upstreams: existing ? [{ id: "upstream-1", name: "Fixture upstream", type, monitorEnabled: true, baseUrl: "https://up.example", identity: type === "newapi-key" ? null : { provider: type.startsWith("sub2api") ? "sub2api" : "newapi", accountId: "42" } }] : [],
    channels: ids.map((id) => ({ id, name: id === 4 ? "New channel" : "New channel " + id, status: 1, baseUrl: "https://up.example", groups: ["local-sales"], revision: "revision-" + id, candidates: existing ? ["upstream-1"] : [], monitor: { status: "unlinked", stationIds: [] }, reconciliation: { status: "unconfigured", ruleIds: [] } })),
    rules: existing ? [{ ...rule("rule-1", "Rule A", 10).rule, ownStationId: "own-1", tokenId: 7, enabled: true }] : [],
    syncedAt: "2026-10-09T06:00:00.000Z", stale: false,
  };
}
const onboardingTokens = [{ id: 7, name: "Supplier Key", status: 1, group: "upstream-group" }, { id: 8, name: "New Key", status: 1, group: "upstream-group" }];
const preview = { billingEffectiveFromMs: Date.parse("2026-10-10T00:00:00+08:00"), firstQueryableAtMs: Date.parse("2026-10-11T00:00:00+08:00"), scopeChanged: true };
const ownSource = { stationId: "own-1", provider: "newapi", baseUrl: "https://own.example", accountId: "1", namespaceKey: "fixture-own-namespace" };

function probeResult(body, config, options = {}) {
  const selection = body.selections[0];
  const accountIdentity = { provider: selection.newStation?.type?.startsWith("sub2api") ? "sub2api" : "newapi", baseUrl: selection.newStation?.baseUrl || "https://up.example", accountId: "42" };
  const mainIdentity = (selection.newStation?.type || config.upstreams.find((entry) => entry.id === selection.stationId)?.type) === "newapi-key" ? null : accountIdentity;
  const groups = body.groups.map((group) => {
    const tokenId = group.reconciliation?.tokenId || null;
    const existing = tokenId === 7 ? [1, 2, 3] : [];
    const proposed = [...new Set([...existing, ...group.channels.map((entry) => entry.channelId)])];
    return {
      groupId: group.groupId, requestedGroupIds: [group.groupId], selectionIds: [group.selectionId], requestedChannelIds: group.channels.map((entry) => entry.channelId),
      status: group.reconciliation ? options.billingStatus || "ready" : "monitor_only",
      basis: { ownSource, sourceVersion: "source-v1", channelRevisions: Object.fromEntries(proposed.map((id) => [id, "revision-" + id])), resourceVersions: {}, accountIdentity, canonicalKey: tokenId ? "canonical-" + tokenId : null, tokenId, keyVersion: tokenId ? "key-v1" : null, existingRuleId: tokenId === 7 ? "rule-1" : null, existingScopeVersion: tokenId === 7 ? 1 : null, existingChannelIds: existing, proposedChannelIds: proposed, timezone: "Asia/Shanghai", billingEffectiveFromMs: preview.billingEffectiveFromMs, coverageDeclaration: group.reconciliation?.coverageDeclaration || { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] } },
      preview: { ...preview, costCoverage: group.reconciliation?.coverageDeclaration.answer === "none" ? "complete" : "unknown" },
    };
  });
  return {
    requestId: body.requestId, previewId: "preview-" + body.requestId, expiresAtMs: Date.now() + 600000, source: { ownSource, sourceVersion: "source-v1", resourceVersion: "own-v1" },
    selections: [{ selectionId: selection.selectionId, station: { id: selection.stationId || "new-up", name: "Fixture upstream" }, monitor: { status: "verified" }, authorizationStationId: selection.reconciliationAuthorization?.stationId || (mainIdentity ? selection.stationId || null : null), accountIdentity: mainIdentity, tokens: options.billingStatus ? [] : onboardingTokens, credentialUpdateRequired: !!options.requireUpdate }],
    groups,
    retryInput: { requestId: body.requestId, source: { ownStationId: body.ownStationId, ownSource, sourceVersion: "source-v1" }, selections: [{ selectionId: selection.selectionId, stationId: selection.stationId || null, type: selection.newStation?.type || config.upstreams.find((entry) => entry.id === selection.stationId)?.type || "newapi", baseUrl: selection.newStation?.baseUrl || "https://up.example", monitor: selection.monitor, additionalMonitorStationIds: selection.additionalMonitorStationIds || [], accountIdentity: mainIdentity, authorizationStationId: selection.reconciliationAuthorization?.stationId || null, authorizationIdentity: accountIdentity, credentialUpdateRequested: !!selection.updateCredentials && !!selection.newStation }], groups: groups.map((group, index) => ({ groupId: group.groupId, requestedGroupIds: group.requestedGroupIds, selectionIds: group.selectionIds, channels: body.groups[index].channels, reconciliationRequested: !!body.groups[index].reconciliation, reconciliation: group.basis.tokenId ? { canonicalKey: group.basis.canonicalKey, tokenId: group.basis.tokenId, timezone: "Asia/Shanghai", coverageDeclaration: group.basis.coverageDeclaration, previewEffectiveFromMs: preview.billingEffectiveFromMs } : null })) },
  };
}
function batchResult(body, probe, complete = true) {
  return { requestId: body.requestId, complete, retryInput: probe.retryInput, groups: probe.groups.map((group) => ({
    groupId: group.groupId, requestedGroupIds: group.requestedGroupIds, canonicalKey: group.basis.canonicalKey, complete,
    monitor: { status: body.selections[0].monitor ? "linked" : "not_requested", stationIds: body.selections[0].monitor ? [body.selections[0].stationId || "new-up"] : [] },
    reconciliation: { status: body.groups[0].reconciliation ? complete ? "configured" : "unverified" : "not_requested", ruleId: complete ? "rule-" + (group.basis.tokenId || "monitor") : undefined },
    saved: { stationIds: body.selections[0].monitor ? [body.selections[0].stationId || "new-up"] : [], authorizationStationId: !body.selections[0].monitor ? body.selections[0].stationId || "new-billing-auth" : body.selections[0].reconciliationAuthorization ? body.selections[0].reconciliationAuthorization.stationId || "billing-auth" : null, links: [], ruleId: complete && body.groups[0].reconciliation ? "rule-" + group.basis.tokenId : null, scopeVersion: 2, billingEffectiveFromMs: preview.billingEffectiveFromMs },
    channels: body.groups.find((entry) => entry.groupId === group.groupId).channels.map((entry) => ({ ...entry, complete, stationIds: [body.selections[0].stationId || "new-up"], ruleId: complete ? "rule-" + group.basis.tokenId : null, remainingActions: complete ? [] : ["retry_rule"] })),
    remainingActions: complete ? [] : ["repreview"],
  })) };
}
async function openOnboardingPage(t, options = {}) {
  const config = options.config || onboardingFixture(), probes = [], writes = [], reads = [], recoveries = [];
  let latestProbe, latestResult;
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") return fulfill(route, options.ruleConfiguration || configuration);
    if (path === "/api/reconciliation" || path === "/api/reconciliation/query") return fulfill(route, response(options.ruleResults || [rule("rule-1", "Rule A", 10)]));
    if (options.extraAPI) return options.extraAPI(route, path);
    throw new Error("unexpected fixture API: " + path);
  }, options.viewport, !!options.clock, async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/channel-onboarding/accounts") { reads.push({ path, method: request.method() }); return options.accounts ? options.accounts(route, reads) : fulfill(route, options.accountModel || { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }); }
    if (options.accountOperation && path.startsWith("/api/channel-onboarding/accounts/")) return options.accountOperation(route, path);
    if (request.method() === "GET" || path.endsWith("/sync")) { reads.push({ path, method: request.method() }); return options.discovery ? options.discovery(route, reads, config) : fulfill(route, config); }
    const body = request.postDataJSON();
    if (path === "/api/channel-onboarding/batch/probe") { probes.push(body); latestProbe = options.probe ? options.probe(body, probes.length, config) : probeResult(body, config, options); latestProbe.previewId += "-" + probes.length; return fulfill(route, latestProbe); }
    if (path === "/api/channel-onboarding/batch/recover") { recoveries.push(body); return fulfill(route, options.recover ? options.recover(body, latestResult) : latestResult || batchResult({ ...probes.at(-1) }, latestProbe, false)); }
    assert.equal(path, "/api/channel-onboarding/batch");
    writes.push(body);
    latestResult = options.connect ? options.connect(body, writes.length, latestProbe) : batchResult(body, latestProbe);
    if (latestResult.complete) for (const group of body.groups) for (const channel of group.channels) {
      const entry = config.channels.find((entry) => entry.id === channel.channelId);
      entry.monitor = { status: "linked", stationIds: [body.selections[0].stationId || "new-up"] }; entry.reconciliation = { status: group.reconciliation ? "configured" : "unconfigured", ruleIds: group.reconciliation ? ["rule-1"] : [] };
    }
    if (options.loseResponseAt === writes.length) return route.abort("failed");
    return fulfill(route, latestResult);
  });
  await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).click({ trial: true });
  return { page, config, probes, writes, reads, recoveries };
}
async function openOnboardingDrawer(page, batch = false) {
  if (batch) { await page.getByText("选择当前筛选渠道（最多 100 个）", { exact: true }).click(); await page.getByRole("button", { name: "批量接入所选渠道", exact: true }).click(); }
  else await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).click();
  return page.getByRole("dialog", { name: "接入监控与对账" });
}
async function verifyOnboarding(drawer) {
  const button = drawer.getByRole("button", { name: "验证并预览", exact: true });
  await button.scrollIntoViewIfNeeded();
  const devBadge = drawer.page().getByRole("button", { name: "Collapse issues badge", exact: true });
  if (await devBadge.isVisible()) await devBadge.click();
  await button.click(); await drawer.getByText("监控连接已验证，尚未保存", { exact: true }).waitFor();
}
async function chooseKey(page, drawer, name = "Supplier Key") { await drawer.getByRole("combobox", { name: "接入上游 Key", exact: true }).click(); await page.getByText(name + " · 上游分组 upstream-group", { exact: true }).last().click(); }
async function enableBilling(page, drawer, key = "Supplier Key") {
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await verifyOnboarding(drawer); await chooseKey(page, drawer, key); await verifyOnboarding(drawer);
  await drawer.getByRole("combobox", { name: "Key 消费范围", exact: true }).click(); await page.getByText("没有", { exact: true }).last().click();
  assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true); await verifyOnboarding(drawer);
}
async function saveOnboarding(drawer) { await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); }

test("five existing-account channels choose one Key and confirm one genuine batch without credentials", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5, 6, 7, 8]) });
  const drawer = await openOnboardingDrawer(page, true); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 0);
  await enableBilling(page, drawer); await drawer.getByText("完整范围：#1、#2、#3、New channel、New channel 5、New channel 6、New channel 7、New channel 8", { exact: true }).waitFor();
  await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].selections.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].groups.length, 1); assert.deepEqual(writes[0].groups[0].channels.map((entry) => entry.channelId), [4, 5, 6, 7, 8]); assert.equal(writes[0].groups[0].reconciliation.tokenId, 7); assert.equal(writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); assert.ok(writes[0].previewId); assert.equal(probes.filter((entry) => entry.groups[0].reconciliation?.tokenId === 7).length, 2); assert.equal("newStation" in writes[0].selections[0], false);
});

test("different saved resource IDs for the same verified account reuse one existing authorization", async (t) => {
  const config = onboardingFixture(true, "newapi", [4, 5]);
  config.upstreams.push({ ...config.upstreams[0], id: "upstream-2", name: "Same account, another saved PAT" });
  config.channels[0].monitor = { status: "linked", stationIds: ["upstream-1"] };
  config.channels[1].monitor = { status: "linked", stationIds: ["upstream-2"] };
  const { page, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page, true);
  assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 0);
  await enableBilling(page, drawer); await saveOnboarding(drawer);
  assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal("newStation" in writes[0].selections[0], false); assert.equal(writes[0].groups.length, 1); assert.deepEqual(writes[0].groups[0].channels.map((entry) => entry.channelId), [4, 5]);
});

test("different Keys remain explicit groups and partial saves recover after reload using public intent", async (t) => {
  const { page, probes, writes, recoveries } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5]), connect(body, count, probe) {
    const result = batchResult(body, probe);
    if (count === 1) { result.complete = false; const second = result.groups[1]; second.complete = false; second.saved.ruleId = null; second.reconciliation = { status: "pending", reason: "第二把 Key 账单配置保存失败" }; second.channels.forEach((entry) => { entry.complete = false; entry.ruleId = null; entry.remainingActions = ["retry_rule"]; }); second.remainingActions = ["repreview"]; }
    return result;
  } });
  const drawer = await openOnboardingDrawer(page, true); await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await verifyOnboarding(drawer); await chooseKey(page, drawer); await drawer.getByText("这些渠道使用不同 Key，分别指定", { exact: true }).click();
  await drawer.getByRole("combobox", { name: "渠道 5 的上游 Key", exact: true }).click(); await page.getByText("New Key · 上游分组 upstream-group", { exact: true }).last().click(); await verifyOnboarding(drawer);
  await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("第二把 Key 账单配置保存失败", { exact: true }).waitFor(); assert.equal(writes.length, 1); assert.deepEqual(writes[0].groups.map((group) => group.reconciliation.tokenId), [7, 8]);
  await page.reload(); await page.getByRole("button", { name: "恢复上次接入", exact: true }).click(); await drawer.getByText("第二把 Key 账单配置保存失败", { exact: true }).waitFor();
  assert.equal(recoveries[0].requestId, writes[0].requestId); assert.deepEqual(recoveries[0].groups.map((group) => group.channels.map((entry) => entry.channelId)), [[4], [5]]); assert.equal("accessToken" in recoveries[0].selections[0], false); assert.equal("saved" in recoveries[0], false); assert.equal(recoveries[0].groups.length, 2);
  await verifyOnboarding(drawer); await drawer.getByRole("button", { name: "重试未完成步骤", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 2); assert.equal(writes[1].selections[0].stationId, "upstream-1"); assert.deepEqual(writes[1].groups.map((group) => group.channels.map((entry) => entry.channelId)), [[4], [5]]);
});

test("new New API credentials are entered once and keyboard cancellation after a probe creates nothing", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-new-pat"); await enableBilling(page, drawer);
  await drawer.getByRole("button", { name: "确认关联", exact: true }).click({ trial: true }); assert.equal(writes.length, 0); assert.equal(probes.at(-1).selections[0].newStation.accessToken, "fixture-new-pat"); await drawer.getByRole("button", { name: "验证并预览", exact: true }).focus(); await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 0);
});

test("monitor-only onboarding needs no Key and submits one batch", async (t) => {
  const { page, writes } = await openOnboardingPage(t); const drawer = await openOnboardingDrawer(page); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].groups[0].reconciliation, null);
});

test("Sub2API password mode clears hidden credentials and preserves unsupported billing as partial", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false), billingStatus: "unsupported", connect(body, count, probe) { const result = batchResult(body, probe, false); result.groups[0].reconciliation = { status: "unsupported", reason: "当前部署账单能力不支持" }; return result; } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("hidden-old-pat"); await drawer.getByLabel("监控方式", { exact: true }).click(); await page.getByText("Sub2API · 账号密码", { exact: true }).last().click(); await drawer.getByLabel("上游登录邮箱", { exact: true }).fill("fixture@example.test"); await drawer.getByLabel("上游登录密码", { exact: true }).fill("fixture-password");
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("当前部署账单能力不支持", { exact: true }).waitFor();
  assert.equal(writes[0].selections[0].newStation.type, "sub2api-password"); assert.equal("accessToken" in writes[0].selections[0].newStation, false); assert.equal(writes[0].selections[0].newStation.password, "fixture-password");
});

test("pure Key monitor supplements one dedicated billing authorization", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi-key") }); const drawer = await openOnboardingDrawer(page); await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await drawer.getByText("账单授权只补一次", { exact: true }).waitFor(); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-billing-pat"); await verifyOnboarding(drawer); await chooseKey(page, drawer); await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].selections[0].reconciliationAuthorization.newAuthorization.accessToken, "fixture-billing-pat");
});

test("pure Key recovery after reload reuses the saved dedicated billing authorization", async (t) => {
  const config = onboardingFixture(true, "newapi-key");
  const { page, probes, writes, recoveries } = await openOnboardingPage(t, { config, connect(body, count, probe) {
    const result = batchResult(body, probe, count > 1); result.groups[0].saved.authorizationStationId = "billing-auth";
    if (count === 1) { config.upstreams.push({ id: "billing-auth", name: "Saved billing account", type: "newapi", monitorEnabled: false, baseUrl: "https://up.example", identity: { provider: "newapi", accountId: "42" } }); result.groups[0].reason = "授权已保存，规则待完成"; }
    return result;
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-billing-pat"); await verifyOnboarding(drawer); await chooseKey(page, drawer); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("授权已保存，规则待完成", { exact: true }).waitFor();
  await page.reload(); await page.getByRole("button", { name: "恢复上次接入", exact: true }).click(); await drawer.getByText("授权已保存，规则待完成", { exact: true }).waitFor(); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 0);
  await verifyOnboarding(drawer); assert.equal(probes.at(-1).selections[0].reconciliationAuthorization.stationId, "billing-auth"); assert.equal(recoveries[0].selections[0].accountIdentity, null); await drawer.getByRole("button", { name: "重试未完成步骤", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 2); assert.equal("newAuthorization" in writes[1].selections[0].reconciliationAuthorization, false);
});

test("additional account and Key monitors retain their explicit overlap warning", async (t) => {
  const config = onboardingFixture(); config.upstreams.push({ id: "key-monitor", name: "Extra Key monitor", type: "newapi-key", monitorEnabled: true, baseUrl: "https://up.example" });
  const { page, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page); await drawer.getByText("同时关联其他已有监控资源（可选）", { exact: true }).click(); await drawer.getByRole("combobox", { name: "其他监控资源", exact: true }).click(); await page.getByText("Extra Key monitor", { exact: true }).last().click(); await drawer.getByText("核对整体监控成本", { exact: true }).waitFor(); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.deepEqual(writes[0].selections[0].additionalMonitorStationIds, ["key-monitor"]);
});

test("connection edits invalidate proof while a display-name edit preserves it", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) }); const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-pat"); await verifyOnboarding(drawer); await drawer.getByLabel("上游资源名称", { exact: true }).fill("Renamed"); assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isEnabled(), true); await drawer.getByLabel("上游站点地址", { exact: true }).fill("https://another.example"); assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true); assert.equal(writes.length, 0);
});

test("same-account update needs explicit consent and recovery cannot claim existing relations prove rotation", async (t) => {
  const { page, writes, recoveries } = await openOnboardingPage(t, { config: onboardingFixture(false), requireUpdate: true, connect(body, count, probe) {
    const result = batchResult(body, probe, false); result.groups[0].code = "CREDENTIAL_UPDATE_UNCONFIRMED"; result.groups[0].reason = "关联已保存，授权更新结果尚未确认，请重新预览"; result.groups[0].remainingActions = ["repreview"]; result.groups[0].reconciliation.status = "configured"; result.groups[0].saved.ruleId = "rule-7"; return result;
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-replacement"); await verifyOnboarding(drawer); assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true); await drawer.getByText("已发现相同账号，确认用本次授权更新已有凭证", { exact: true }).click(); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("关联已保存，授权更新结果尚未确认，请重新预览", { exact: true }).waitFor(); await drawer.getByRole("button", { name: "核对已保存结果", exact: true }).click(); assert.equal(writes[0].selections[0].updateCredentials, true); assert.equal(recoveries[0].selections[0].credentialUpdateRequested, true); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).inputValue(), "fixture-replacement");
});

test("manual discovery keeps a stale catalogue visible and disables new binding", async (t) => {
  const { page } = await openOnboardingPage(t, { discovery(route, reads, config) { return fulfill(route, reads.length > 2 ? { ...config, stale: true, error: "fixture catalogue unavailable" } : config); } });
  await page.getByRole("button", { name: "发现新渠道", exact: true }).click(); await page.getByText("渠道目录读取失败，正在显示上次发现的渠道", { exact: true }).waitFor(); assert.equal(await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).isDisabled(), true);
});

test("channel search and status filters do not silently select another account", async (t) => {
  const config = onboardingFixture(true, "newapi", [4, 5]); config.channels[1].baseUrl = "https://other.example"; config.channels[1].candidates = ["other-account"]; config.upstreams.push({ id: "other-account", name: "Other account", type: "newapi", baseUrl: "https://other.example", monitorEnabled: true });
  const { page } = await openOnboardingPage(t, { config }); await page.getByRole("textbox", { name: "搜索接入渠道", exact: true }).fill("local-sales"); const drawer = await openOnboardingDrawer(page, true); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 1); assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true);
});

test("five-channel batches fit 320/390/768/1440 widths without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5, 6, 7, 8]), viewport: { width, height: 900 } });
    const drawer = await openOnboardingDrawer(page, true); await enableBilling(page, drawer); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await saveOnboarding(drawer); assert.equal(writes.length, 1); await page.close();
  }
});

test("old rule editor previews one exact final set and confirms one PUT without recreating the rule", async (t) => {
  const row = rule("rule-1", "Rule A", 10);
  row.rule = { ...row.rule, tokenId: 7, timezone: "Asia/Shanghai", channels: [1, 2].map((channelId) => ({ channelId, name: "Sales " + channelId })) };
  const config = { ...configuration, channels: [1, 2, 3].map((id) => ({ id, name: "Sales " + id, status: 1 })), rules: [{ ...row.rule, enabled: true }] };
  const previews = [], puts = [];
  const { page } = await openOnboardingPage(t, { ruleConfiguration: config, ruleResults: [row], extraAPI(route, path) {
    const body = route.request().postDataJSON();
    if (path === "/api/reconciliation/rules/rule-1/preview") {
      previews.push(body);
      const group = probeResult({ requestId: "fixture", ownStationId: "own-1", selections: [{ selectionId: "primary", stationId: "upstream-1", monitor: false }], groups: [{ groupId: "rule-edit", selectionId: "primary", channels: body.salesChannelIds.map((channelId) => ({ channelId, channelRevision: "revision-" + channelId })), reconciliation: { tokenId: 7, coverageDeclaration: body.coverageDeclaration } }] }, onboardingFixture()).groups[0];
      return fulfill(route, { previewId: "exact-rule-preview", groupId: "rule-edit", expiresAtMs: Date.now() + 600000, basis: { ...group.basis, existingChannelIds: [1, 2], proposedChannelIds: body.salesChannelIds }, preview: group.preview });
    }
    if (path === "/api/reconciliation/rules/rule-1" && route.request().method() === "PUT") { puts.push(body); return fulfill(route, { rule: { ...row.rule, channels: body.salesChannelIds.map((channelId) => ({ channelId })) } }); }
    throw new Error("unexpected rule fixture API: " + path);
  } });
  await page.getByRole("button", { name: "操作 Rule A 的规则", exact: true }).click(); await page.getByText("编辑规则", { exact: true }).last().click();
  const drawer = page.getByRole("dialog", { name: "编辑对账规则", exact: true });
  await drawer.locator('.ant-select-selection-item[title="Sales 1 · ID 1"] .ant-select-selection-item-remove').click();
  await drawer.getByLabel("本站销售渠道", { exact: true }).click(); await page.getByText("Sales 3 · ID 3", { exact: true }).last().click(); await drawer.getByLabel("本站销售渠道", { exact: true }).press("Escape");
  await drawer.getByRole("button", { name: "预览对账规则", exact: true }).click(); await drawer.getByText("最终渠道：#2、#3", { exact: true }).waitFor(); await drawer.getByText("释放渠道：#1；原账单保留。", { exact: true }).waitFor(); assert.equal(puts.length, 0);
  await drawer.getByRole("button", { name: "保存对账规则", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(previews.length, 1); assert.equal(puts.length, 1); assert.deepEqual(puts[0].salesChannelIds, [2, 3]); assert.equal(puts[0].tokenId, 7); assert.equal(puts[0].groupId, "rule-edit"); assert.equal(puts[0].previewId, "exact-rule-preview"); assert.equal(puts[0].coverageDeclaration.answer, "unknown");
});

test("manual create uses genuine batch proof and retains account monitoring purpose", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { ruleConfiguration: { ...configuration, channels: [{ id: 4, name: "New channel", status: 1 }] }, extraAPI(route, path) {
    if (path === "/api/reconciliation/upstreams/upstream-1/keys") return fulfill(route, { tokens: onboardingTokens, groups: {} });
    throw new Error("unexpected create fixture API: " + path);
  } });
  await page.getByRole("button", { name: "添加对账规则", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "添加对账规则", exact: true });
  await drawer.getByLabel("上游账号", { exact: true }).click(); await page.getByText("Fixture upstream", { exact: true }).last().click(); await drawer.getByLabel("固定分组 Key", { exact: true }).click(); await page.getByText("Supplier Key · upstream-group", { exact: true }).last().click(); await drawer.getByLabel("本站销售渠道", { exact: true }).click(); await page.getByText("New channel · ID 4", { exact: true }).last().click(); await drawer.getByLabel("对账时区", { exact: true }).click();
  await drawer.getByRole("button", { name: "预览对账规则", exact: true }).click(); await drawer.getByText("最终渠道：#1、#2、#3、#4", { exact: true }).waitFor(); assert.equal(writes.length, 0); await drawer.getByRole("button", { name: "保存对账规则", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(probes.length, 1); assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].previewId, "preview-" + writes[0].requestId + "-1");
});

test("a lost batch response recovers persisted results without returned browser IDs or another confirm", async (t) => {
  const { page, writes, recoveries } = await openOnboardingPage(t, { loseResponseAt: 1 });
  const drawer = await openOnboardingDrawer(page); await enableBilling(page, drawer); await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("全部请求步骤已保存", { exact: true }).waitFor();
  assert.equal(writes.length, 1); assert.equal(recoveries.length, 1); assert.equal(recoveries[0].requestId, writes[0].requestId); assert.equal(recoveries[0].selections[0].stationId, "upstream-1"); assert.equal("saved" in recoveries[0], false); assert.equal(await drawer.getByRole("button", { name: "重试未完成步骤", exact: true }).isDisabled(), true);
});

test("a new billing-only account is confirmed without creating another monitor", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) }); const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-billing-only"); await drawer.getByText("关联余额监控", { exact: true }).click(); await enableBilling(page, drawer); await saveOnboarding(drawer); assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].selections[0].newStation.accessToken, "fixture-billing-only");
});

test("the resources page retains the same batch entry and original resource configuration", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { extraAPI(route, path) {
    if (path === "/api/stations") return fulfill(route, { stations: [], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    throw new Error("unexpected station fixture API: " + path);
  } });
  await page.goto(baseURL + "/stations"); const drawer = await openOnboardingDrawer(page); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].groups[0].channels[0].channelId, 4); await page.getByRole("button", { name: /添加资源/ }).click(); await page.getByRole("dialog", { name: "添加上游资源", exact: true }).waitFor();
});

test("catalogue sync occurs on entry and manual discovery, without page-minute polling", async (t) => {
  const { page, reads } = await openOnboardingPage(t, { clock: true }); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 1); await page.clock.fastForward(70000); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 1); await page.getByRole("button", { name: "发现新渠道", exact: true }).click(); await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).click({ trial: true }); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 2);
});

// Public shapes and facts from server/channel-onboarding.test.js accountReadFixture/U03 cases.
function accountReadFixture() {
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const identity = (provider, accountId) => ({ provider, baseUrl: "https://same.test", accountId });
  const source = { stationId: "own", provider: "newapi", baseUrl: "https://own.test", accountId: "1", namespaceKey: hash(["newapi", "https://own.test", "1"]) };
  const resource = (id, account, extra = {}) => ({ id, name: id, type: "newapi", baseUrl: "https://same.test", monitorEnabled: true, archivedAt: null, authVersion: 1, resourceVersion: "version-" + id,
    identity: account, verification: account ? "verified" : "unverified", purposes: { monitor: true, billingRuleIds: [] }, balance: { ok: true, remaining: 10 }, lowBalanceUsd: null, cnyPerUsd: null, includeInProfit: true, noRenewal: false, hasAccessToken: true, hasApiKey: false, hasPassword: false, ...extra });
  const member = (channelId) => ({ ownSource: source, ownStationId: "own", channelId, name: "Channel " + channelId });
  const aIdentity = identity("newapi", "A"), bIdentity = identity("newapi", "B"), subIdentity = identity("sub2api", "A");
  const aKey = hash(["newapi", "https://same.test", "A"]), bKey = hash(["newapi", "https://same.test", "B"]), subKey = hash(["sub2api", "https://same.test", "A"]);
  const action = (kind, label, target = {}) => ({ id: kind + ":" + hash(target), kind, label, accountKey: null, stationId: null, ruleId: null, ownStationId: null, channelIds: [], window: null, href: "/stations", ...target });
  const key = (accountId, tokenId, extra = {}) => ({ canonicalKey: hash(["newapi", "https://same.test", accountId, tokenId]), tokenId, tokenName: "Key " + tokenId,
    ruleIds: [accountId + "-active"], activeRuleIds: [accountId + "-active"], scopeAmbiguous: false, channels: [member(1)], costCoverage: "unknown", coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [2] }, scopeVersion: 3, billingEffectiveFromMs: 1791561600000, firstQueryableAtMs: 1791648000000, ...extra });
  const a = { accountKey: aKey, siteKey: hash(["newapi", "https://same.test"]), identity: aIdentity,
    resources: [resource("A-archived", aIdentity, { archivedAt: "2026-10-01T00:00:00Z", purposes: { monitor: true, billingRuleIds: ["A-history"] } }), resource("A-billing", aIdentity, { monitorEnabled: false, purposes: { monitor: false, billingRuleIds: ["A-active"] } }),
      resource("A-monitor-1", aIdentity, { lowBalanceUsd: 27, cnyPerUsd: 0.7, includeInProfit: false, noRenewal: true, balance: { ok: false, remaining: 10, account: null, error: "403 [已隐藏] [已隐藏] [已隐藏]" } }), resource("A-monitor-2", aIdentity, { purposes: { monitor: true, billingRuleIds: ["A-stopped"] } })],
    keys: [key("A", 9, { ruleIds: ["A-active", "A-history"], channels: [member(1), member(3)] }), key("A", 10, { ruleIds: ["A-stopped"], activeRuleIds: [], channels: [member(2)] })],
    actions: [action("update_authorization", "更新账号授权", { accountKey: aKey, href: `/stations?action=authorization&accountKey=${aKey}` }), action("confirm_coverage", "核对这把 Key 的全部用途", { accountKey: aKey, ruleId: "A-active", ownStationId: "own", channelIds: [2], href: "/stations?action=coverage&ruleId=A-active" })] };
  const b = { accountKey: bKey, siteKey: a.siteKey, identity: bIdentity, resources: [resource("B-monitor", bIdentity)], keys: [key("B", 9, { costCoverage: "complete", coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] }, channels: [member(2)] })], actions: [action("inspect_balance", "查看余额与监控", { accountKey: bKey, stationId: "B-monitor" })] };
  const sub = { accountKey: subKey, siteKey: hash(["sub2api", "https://same.test"]), identity: subIdentity, resources: [resource("Sub-JWT", subIdentity, { type: "sub2api" }), resource("Sub-password", subIdentity, { type: "sub2api-password", hasAccessToken: false, hasPassword: true })], keys: [], actions: [] };
  const unverifiedResources = [resource("pure-key", null, { type: "newapi-key", hasAccessToken: false, hasApiKey: true }), resource("unknown-legacy", null)];
  const channels = [1, 2, 3].map((id) => ({ id, name: "Channel " + id, type: 1, status: id === 2 ? 2 : 1, baseUrl: "https://same.test", groups: ["sales"], revision: "revision-" + id, missing: id === 3,
    monitor: { status: id === 1 ? "linked" : "unlinked", stationIds: id === 1 ? ["A-monitor-1", "A-monitor-2", "pure-key"] : [] }, reconciliation: { status: "configured", ruleIds: id === 1 ? ["A-active"] : id === 2 ? ["B-active", "A-stopped"] : ["A-history"] } }));
  return { accounts: [a, b, sub], unverifiedResources, channels, actions: [...a.actions, ...b.actions, action("connect_channels", "接入这些渠道", { stationId: "pure-key", ownStationId: "own", channelIds: [1], href: "/stations?action=connect&ownStationId=own&channelIds=1" }), action("verify_identity", "核验账号身份", { stationId: "unknown-legacy", ownStationId: "own", href: "/stations?action=verify&stationId=unknown-legacy" })], generatedAt: "2026-10-09T07:00:00.000Z" };
}
async function openAccountsPage(t, options = {}) {
  const model = options.model || accountReadFixture(), mutations = [], accountRequests = [];
  const originalStations = [
    { id: options.ownStationId || "own", name: "Own station", type: "newapi", baseUrl: "https://own.test", isOwn: true, monitorEnabled: true, hasAccessToken: true, balance: { ok: true, remaining: 50 } },
    ...model.accounts.flatMap((account) => account.resources), ...model.unverifiedResources,
  ].map((entry) => ({ ...entry, isOwn: !!entry.isOwn, userId: ["A-monitor-1", "st_u04_a1"].includes(entry.id) ? "operator-A" : "", email: entry.id === "Sub-password" ? "saved-sub@example.test" : "", costAliases: ["A-monitor-1", "st_u04_a1"].includes(entry.id) ? ["kept_alias"] : [], tokenInfo: null, prediction: null, spark: [], todayUsed: null }));
  const { page } = await openOnboardingPage(t, { viewport: options.viewport, accountModel: model, accountOperation: options.accountOperation, accounts(route) {
    accountRequests.push(route.request().method()); return options.accounts ? options.accounts(route, accountRequests.length, model) : fulfill(route, model);
  }, extraAPI(route, path) {
    if (route.request().method() !== "GET") { const mutation = { path, method: route.request().method(), body: route.request().postData() ? route.request().postDataJSON() : null }; mutations.push(mutation); if (options.mutation) return options.mutation(route, mutation, originalStations); throw new Error("unexpected account-center write"); }
    if (path === "/api/stations") { const params = new URL(route.request().url()).searchParams; return fulfill(route, { stations: originalStations.filter((entry) => (!entry.archivedAt || params.get("includeArchived") === "true") && (entry.monitorEnabled !== false || params.get("includeUnmonitored") === "true")), settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } }); }
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }, { value: "newapi-key", label: "Key", needs: ["apiKey"] }, { value: "sub2api", label: "Sub2API", needs: ["accessToken"] }, { value: "sub2api-password", label: "Sub2API password", needs: ["email", "password"] }], rules: {} });
    throw new Error("unexpected account fixture API: " + path);
  } });
  await page.goto(baseURL + "/stations"); const center = page.getByRole("region", { name: "账号关系中心" }); if (options.initialFailure) await center.getByRole("button", { name: "重试账号关系", exact: true }).waitFor(); else await center.getByText(/显示 3\/3 个已核验账号/).waitFor();
  const badge = page.getByRole("button", { name: "Collapse issues badge", exact: true }); if (await badge.isVisible()) await badge.click();
  return { page, center, model, mutations, accountRequests, originalStations };
}
async function expandAccount(center, account) { await center.locator(`[data-site-key="${account.siteKey}"]`).getByRole("button", { name: new RegExp("账号 " + account.identity.accountId + " ") }).click(); return center.locator(`[data-account-key="${account.accountKey}"]`); }

async function openAuthorizationPage(t, options = {}) {
  const model = accountReadFixture(), probes = [], updates = [], recoveries = [], operations = new Map();
  const rename = { "A-monitor-1": "st_u04_a1", "A-monitor-2": "st_u04_a2", "A-billing": "st_u04_billing", "A-archived": "st_u04_archived", "B-monitor": "st_u04_b", "pure-key": "st_u04_key", "unknown-legacy": "st_u04_unknown", own: "st_u04_own" };
  const account = model.accounts[0], b = model.accounts[1]; account.identity.accountId = "42"; b.identity.accountId = "43";
  for (const item of [account, b]) {
    item.accountKey = createHash("sha256").update(JSON.stringify([item.identity.provider, item.identity.baseUrl, item.identity.accountId])).digest("hex");
    for (const resource of item.resources) { resource.id = rename[resource.id] || resource.id; resource.identity = { ...item.identity }; resource.purposes.billingRuleIds = resource.id === "st_u04_billing" ? ["rule_u04"] : []; }
    for (const key of item.keys) if (key.activeRuleIds.length) { key.ruleIds = item === account ? ["rule_u04", "rule_history"] : ["rule_b"]; key.activeRuleIds = [key.ruleIds[0]]; }
  }
  for (const resource of model.unverifiedResources) resource.id = rename[resource.id];
  for (const channel of model.channels) { channel.monitor.stationIds = channel.monitor.stationIds.map((id) => rename[id] || id); channel.reconciliation.ruleIds = channel.id === 1 ? ["rule_u04"] : channel.reconciliation.ruleIds; }
  for (const item of model.accounts) for (const key of item.keys) for (const channel of key.channels) { channel.ownStationId = "st_u04_own"; channel.ownSource.stationId = "st_u04_own"; }
  let originalStations, donorRejected = false;
  const resources = model.accounts.flatMap((item) => item.resources);
  const intent = (body) => ({ requestId: body.requestId, targetStationIds: [...body.targetStationIds] });
  const impact = (targets) => ({ monitorStationIds: targets.filter((target) => target.purposes.monitor).map((target) => target.stationId), billingRuleIds: [...new Set(targets.flatMap((target) => target.billingRuleIds))], channels: [{ ownStationId: "st_u04_own", channelId: 1, name: "Sales 1" }] });
  const project = (body, targetAccount) => {
    const targets = body.targetStationIds.flatMap((id) => {
      const resource = targetAccount.resources.find((entry) => entry.id === id && !entry.archivedAt);
      return resource ? [{ stationId: id, authVersion: resource.authVersion, resourceVersion: resource.resourceVersion, currentType: resource.type, newType: body.authorization?.type || resource.type, purposes: resource.purposes, monitorChannelIds: resource.purposes.monitor ? [1] : [], billingRuleIds: resource.purposes.billingRuleIds, billingChannelIds: resource.purposes.billingRuleIds.length ? [1] : [] }] : [];
    });
    return { requestId: body.requestId, previewId: "authorization-preview-" + probes.length, expiresAtMs: Date.now() + 600000, accountKey: targetAccount.accountKey, identity: targetAccount.identity, targets, excluded: body.targetStationIds.filter((id) => !targets.some((target) => target.stationId === id)).map((stationId) => ({ stationId, reason: "账号身份未核验，已排除" })), impact: impact(targets), retryInput: intent(body) };
  };
  const opened = await openAccountsPage(t, { model, viewport: options.viewport, ownStationId: "st_u04_own", async accountOperation(route, path) {
    const body = route.request().postDataJSON(), targetAccount = model.accounts.find((item) => path.includes(item.accountKey)); assert.ok(targetAccount);
    if (path.endsWith("/probe")) {
      probes.push(body);
      if (body.authorization?.accessToken === "account-B") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "ACCOUNT_IDENTITY_CHANGED", error: "替换授权属于另一个账号，请另行接入" }) });
      if (body.reuseSavedAuthorization && options.invalidDonor && !donorRejected) { donorRejected = true; return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "AUTHORIZATION_UNVERIFIED", error: "已保存授权验证失败 [已隐藏]" }) }); }
      if (body.reuseSavedAuthorization && options.noDonor) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "SAVED_AUTHORIZATION_UNAVAILABLE", error: "尚无已确认更新的授权可复用，请重新输入" }) });
      const preview = project(body, targetAccount); operations.set(body.requestId, { preview, saved: operations.get(body.requestId)?.saved || new Set() }); return fulfill(route, preview);
    }
    const operation = operations.get(body.requestId); assert.ok(operation, "recovery uses the original credential-free intent");
    if (path.endsWith("/recover")) {
      recoveries.push(body); assert.deepEqual(body, operation.preview.retryInput);
      const targets = body.targetStationIds.map((stationId) => ({ stationId, status: operation.saved.has(stationId) ? "already_updated" : "repreview_required", savedAuthVersion: operation.saved.has(stationId) ? 2 : null, ...(operation.saved.has(stationId) ? {} : { code: "PREVIEW_REQUIRED", reason: "请重新预览" }), remainingActions: operation.saved.has(stationId) ? [] : ["repreview"] }));
      return fulfill(route, { requestId: body.requestId, accountKey: targetAccount.accountKey, complete: targets.every((target) => target.status === "already_updated"), targets, excluded: operation.preview.excluded, impact: operation.preview.impact, retryInput: intent(body) });
    }
    updates.push(body); assert.equal(body.previewId, operation.preview.previewId);
    const targets = operation.preview.targets.map((target) => {
      if (operation.saved.has(target.stationId)) return { stationId: target.stationId, status: "already_updated", savedAuthVersion: 2, remainingActions: [] };
      if ((options.partial && target.stationId === "st_u04_a2" || options.noDonor) && updates.length === 1) return { stationId: target.stationId, status: "failed", savedAuthVersion: null, code: "AUTHORIZATION_UPDATE_FAILED", reason: "保存失败，请稍后重试", remainingActions: ["repreview"] };
      operation.saved.add(target.stationId); const resource = resources.find((entry) => entry.id === target.stationId); resource.authVersion += 1; resource.resourceVersion += "-updated"; resource.type = target.newType;
      Object.assign(originalStations.find((entry) => entry.id === target.stationId), { authVersion: resource.authVersion, resourceVersion: resource.resourceVersion, type: resource.type });
      return { stationId: target.stationId, status: "updated", savedAuthVersion: resource.authVersion, remainingActions: [] };
    });
    targets.push(...operation.preview.excluded.map((target) => ({ stationId: target.stationId, status: "failed", savedAuthVersion: null, code: "TARGET_EXCLUDED", reason: target.reason, remainingActions: ["verify_identity", "repreview"] })));
    const result = { requestId: body.requestId, accountKey: targetAccount.accountKey, complete: targets.every((target) => target.status !== "failed"), targets, excluded: operation.preview.excluded, impact: operation.preview.impact, retryInput: operation.preview.retryInput };
    if (options.loseResponse && updates.length === 1) return route.abort("failed"); return fulfill(route, result);
  }, mutation(route, mutation, stations) {
    if (mutation.method === "PUT") {
      const id = decodeURIComponent(mutation.path.split("/").at(-1)), resource = resources.find((entry) => entry.id === id); assert.ok(resource);
      assert.deepEqual(Object.keys(mutation.body).sort(), ["expectedAuthVersion", "expectedResourceVersion", "monitorEnabled"]);
      assert.equal(mutation.body.expectedAuthVersion, resource.authVersion); assert.equal(mutation.body.expectedResourceVersion, resource.resourceVersion);
      resource.monitorEnabled = mutation.body.monitorEnabled; resource.purposes.monitor = mutation.body.monitorEnabled; if (!resource.monitorEnabled) resource.includeInProfit = false; resource.resourceVersion += "-purpose";
      Object.assign(stations.find((entry) => entry.id === id), { monitorEnabled: resource.monitorEnabled, includeInProfit: resource.includeInProfit, resourceVersion: resource.resourceVersion }); return fulfill(route, { ok: true });
    }
    assert.equal(mutation.method, "DELETE"); const ruleId = mutation.path.split("/").at(-1); for (const item of model.accounts) for (const key of item.keys) key.activeRuleIds = key.activeRuleIds.filter((id) => id !== ruleId); return fulfill(route, { ok: true });
  } });
  originalStations = opened.originalStations;
  return { ...opened, probes, updates, recoveries };
}
async function openAccountAuthorization(page, center, account) {
  const expanded = await expandAccount(center, account); await expanded.getByRole("button", { name: `更新账号授权 ${account.identity.provider} ${account.identity.accountId}`, exact: true }).click();
  return page.getByRole("dialog", { name: `更新账号授权 · ${account.identity.accountId}`, exact: true });
}
async function previewAuthorization(drawer) { await drawer.getByRole("button", { name: "预览授权更新", exact: true }).click(); await drawer.getByText("授权更新预览，尚未保存", { exact: true }).waitFor(); }
async function confirmAccountAuthorization(drawer) { const button = drawer.getByRole("button", { name: "确认更新所选授权", exact: true }); await button.click(); await drawer.getByText(/本次所选目标已完成授权更新|部分目标尚未更新，已保存目标保留/).waitFor(); await drawer.locator(".ant-drawer-close").waitFor(); }

test("account authorization inputs once and confirms three explicit targets while excluding same-site B, own, archived and pure Key", async (t) => {
  const { page, center, model, probes, updates, originalStations } = await openAuthorizationPage(t), account = model.accounts[0]; const before = originalStations.map((resource) => ({ id: resource.id, userId: resource.userId, costAliases: resource.costAliases, lowBalanceUsd: resource.lowBalanceUsd, cnyPerUsd: resource.cnyPerUsd, includeInProfit: resource.includeInProfit, noRenewal: resource.noRenewal }));
  const drawer = await openAccountAuthorization(page, center, account); assert.equal(await drawer.locator('input[type="password"]').count(), 1); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("one-new-pat"); await previewAuthorization(drawer);
  assert.deepEqual(probes[0].targetStationIds, ["st_u04_billing", "st_u04_a1", "st_u04_a2"]); assert.deepEqual(probes[0].authorization, { type: "newapi", baseUrl: "https://same.test", accessToken: "one-new-pat", userId: "42" });
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("account-authorization-recovery-v05"))); assert.deepEqual(stored, { accountKey: account.accountKey, retryInput: { requestId: probes[0].requestId, targetStationIds: probes[0].targetStationIds } }); assert.doesNotMatch(JSON.stringify(stored), /pat|authorization|previewId|marker/);
  await drawer.getByText(/排除记录：.*已归档.*其他账号.*纯 Key.*本站/).waitFor(); await drawer.getByText("影响账单规则：rule_u04", { exact: true }).waitFor(); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); assert.equal(await drawer.locator('[data-authorization-target]').count(), 3); assert.equal(await drawer.locator('input[type="password"]').count(), 0); assert.equal(await page.evaluate(() => sessionStorage.getItem("account-authorization-recovery-v05")), null);
  assert.deepEqual(originalStations.map((resource) => ({ id: resource.id, userId: resource.userId, costAliases: resource.costAliases, lowBalanceUsd: resource.lowBalanceUsd, cnyPerUsd: resource.cnyPerUsd, includeInProfit: resource.includeInProfit, noRenewal: resource.noRenewal })), before); assert.equal(model.accounts[1].resources[0].authVersion, 1);
});

test("Sub2API JWT and password switches clear hidden authorization and invalidate the previous preview", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[2]);
  await drawer.getByLabel("更新访问令牌", { exact: true }).fill("old-jwt-input"); await previewAuthorization(drawer); await drawer.getByRole("combobox", { name: "更新授权方式", exact: true }).click(); await page.getByText("Sub2API 邮箱与密码", { exact: true }).last().click(); assert.equal(await drawer.getByRole("button", { name: "确认更新所选授权", exact: true }).isDisabled(), true);
  await drawer.getByLabel("更新登录邮箱", { exact: true }).fill("new@example.test"); await drawer.getByLabel("更新登录密码", { exact: true }).fill("temporary-password"); await previewAuthorization(drawer); assert.equal(probes[1].authorization.accessToken, undefined);
  await drawer.getByRole("combobox", { name: "更新授权方式", exact: true }).click(); await page.getByText("Sub2API 登录令牌", { exact: true }).last().click(); assert.equal(await drawer.getByLabel("更新访问令牌", { exact: true }).inputValue(), ""); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("new-jwt-input"); await previewAuthorization(drawer); assert.deepEqual(probes[2].authorization, { type: "sub2api", baseUrl: "https://same.test", accessToken: "new-jwt-input" }); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); assert.notEqual(probes[0].requestId, probes[2].requestId);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); await center.locator(`[data-account-key="${model.accounts[2].accountKey}"]`).getByRole("button", { name: "更新账号授权 sub2api A", exact: true }).click(); await drawer.getByRole("combobox", { name: "更新授权方式", exact: true }).click(); await page.getByText("Sub2API 邮箱与密码", { exact: true }).last().click(); assert.equal(await drawer.getByLabel("更新登录邮箱", { exact: true }).inputValue(), ""); assert.equal(await drawer.getByLabel("更新登录密码", { exact: true }).inputValue(), ""); await drawer.getByLabel("更新登录邮箱", { exact: true }).fill("final@example.test"); await drawer.getByLabel("更新登录密码", { exact: true }).fill("final-password"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); assert.deepEqual(updates[1].authorization, { type: "sub2api-password", baseUrl: "https://same.test", email: "final@example.test", password: "final-password" });
});

test("partial authorization reload uses readonly recovery before a new saved-donor preview and one confirmation", async (t) => {
  const { page, center, model, probes, updates, recoveries } = await openAuthorizationPage(t, { partial: true }); let drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("partial-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.locator('[data-authorization-target="st_u04_a2"]').getByText("A-monitor-2：更新失败", { exact: true }).waitFor();
  await page.reload(); await center.getByRole("button", { name: "恢复上次授权更新", exact: true }).click(); drawer = page.getByRole("dialog", { name: "更新账号授权 · 42", exact: true }); await drawer.getByText("A-monitor-1：已保存，无需重复更新", { exact: true }).waitFor(); assert.equal(probes.length, 1); assert.equal(updates.length, 1); assert.equal(recoveries.length, 1); assert.deepEqual(recoveries[0], { requestId: probes[0].requestId, targetStationIds: probes[0].targetStationIds });
  await drawer.getByRole("button", { name: "重新验证并补未完成", exact: true }).click(); await drawer.getByText("授权更新预览，尚未保存", { exact: true }).waitFor(); assert.equal(probes[1].reuseSavedAuthorization, true); assert.equal(probes[1].authorization, undefined); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a1").authVersion, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a2").authVersion, 2);
});

test("authorization response loss reads saved outcomes without submitting the update again", async (t) => {
  const { page, center, model, updates, recoveries } = await openAuthorizationPage(t, { loseResponse: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("response-loss-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.getByText("A-billing：已保存，无需重复更新", { exact: true }).waitFor(); assert.equal(updates.length, 1); assert.equal(recoveries.length, 1); assert.equal(await page.evaluate(() => sessionStorage.getItem("account-authorization-recovery-v05")), null);
});

test("an invalid saved donor starts a new authorization operation for only unfinished targets", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t, { partial: true, invalidDonor: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("initial-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.getByRole("button", { name: "重新验证并补未完成", exact: true }).click(); await drawer.getByText(/请重新输入授权，已开始新的更新操作/).waitFor(); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("replacement-pat"); await previewAuthorization(drawer); assert.notEqual(probes[2].requestId, probes[0].requestId); assert.deepEqual(probes[2].targetStationIds, ["st_u04_a2"]); await drawer.getByText(/已确认更新，本次不再改写：.*A-monitor-1/).waitFor(); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a1").authVersion, 2);
});

test("unknown authorization targets are opt-in and exclusions never count as updated resources", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); const unknown = drawer.getByRole("checkbox", { name: "更新目标 unknown-legacy", exact: true }); assert.equal(await unknown.isChecked(), false); await unknown.check(); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("checked-pat"); await previewAuthorization(drawer); assert.equal(probes[0].targetStationIds.includes("st_u04_unknown"), true); await drawer.getByText("排除 unknown-legacy：账号身份未核验，已排除", { exact: true }).waitFor(); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); await drawer.getByText("部分目标尚未更新，已保存目标保留", { exact: true }).waitFor(); await drawer.locator('[data-authorization-target="st_u04_unknown"]').getByText("unknown-legacy：更新失败", { exact: true }).waitFor(); assert.equal(await drawer.getByText("本次所选目标已完成授权更新", { exact: true }).count(), 0);
  await drawer.getByRole("button", { name: "重新输入授权，开始新的更新", exact: true }).click(); assert.equal(await drawer.getByRole("checkbox", { name: "更新目标 A-monitor-1", exact: true }).isChecked(), false); assert.equal(await drawer.getByRole("checkbox", { name: "更新目标 A-monitor-2", exact: true }).isChecked(), false); assert.equal(await drawer.getByRole("checkbox", { name: "更新目标 A-billing", exact: true }).isChecked(), false); assert.equal(await unknown.isChecked(), false); assert.equal(updates.length, 1);
});

test("authorization from same-site account B cannot update account A and requires a fresh valid preview", async (t) => {
  const { page, center, model, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("account-B"); await drawer.getByRole("button", { name: "预览授权更新", exact: true }).click(); await drawer.getByText("替换授权属于另一个账号，请另行接入", { exact: true }).waitFor(); assert.equal(await drawer.getByRole("button", { name: "确认更新所选授权", exact: true }).isDisabled(), true); assert.equal(updates.length, 0); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("correct-account-A"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1);
});

test("authorization with no saved donor requests fresh input and a new operation without a preview bypass", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t, { noDonor: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("failed-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.getByRole("button", { name: "重新验证并补未完成", exact: true }).click(); await drawer.getByText(/尚无已确认更新的授权可复用/).waitFor(); assert.equal(updates.length, 1); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("fresh-pat"); await previewAuthorization(drawer); assert.notEqual(probes[2].requestId, probes[0].requestId); assert.equal(probes[2].targetStationIds.length, 3); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2);
});

test("pause and re-enable retain complete resource settings while stopping one Key leaves other monitors and history intact", async (t) => {
  const { page, center, model, mutations, originalStations } = await openAuthorizationPage(t); let a = await expandAccount(center, model.accounts[0]); const resource = () => a.locator('[data-resource-id="st_u04_a1"]'); await resource().getByRole("button", { name: "暂停监控 A-monitor-1", exact: true }).click(); let modal = page.getByRole("dialog", { name: "暂停「A-monitor-1」监控？", exact: true }); await modal.getByText(/Key 账单核算继续/).waitFor(); await modal.getByRole("button", { name: "确认用途操作", exact: true }).click(); await modal.waitFor({ state: "hidden" }); await page.reload(); await center.getByText(/显示 3\/3/).waitFor(); a = await expandAccount(center, model.accounts[0]); await resource().getByText("监控暂停 / 未启用", { exact: true }).waitFor(); assert.equal(await page.locator(".resource-list-card").getByText("A-monitor-1", { exact: true }).count(), 0);
  await resource().getByRole("button", { name: "查看原资源设置 A-monitor-1", exact: true }).click(); const editor = page.getByRole("dialog", { name: "编辑上游资源", exact: true }); assert.equal(await editor.getByLabel("用户 ID（New-Api-User）", { exact: true }).inputValue(), "operator-A"); assert.equal(await editor.getByLabel("成本渠道匹配别名", { exact: true }).inputValue(), "kept_alias"); await editor.getByRole("button", { name: /取\s*消/ }).click();
  await resource().getByRole("button", { name: "启用监控 A-monitor-1", exact: true }).click(); modal = page.getByRole("dialog", { name: "启用「A-monitor-1」监控？", exact: true }); await modal.getByText("现有成本设置：不纳入", { exact: true }).waitFor(); await modal.getByRole("button", { name: "确认用途操作", exact: true }).click(); await modal.waitFor({ state: "hidden" }); await resource().getByText("余额监控", { exact: true }).waitFor(); assert.equal(originalStations.find((entry) => entry.id === "st_u04_a1").includeInProfit, false);
  await a.getByRole("button", { name: /Key 9 · #9/ }).click(); await a.getByRole("button", { name: "停止 Key 9 的账单核算", exact: true }).click(); modal = page.getByRole("dialog", { name: "停止此 Key 的账单核算？", exact: true }); await modal.getByText(/Channel 1 #1.*st_u04_own/).waitFor(); await modal.getByRole("button", { name: "确认用途操作", exact: true }).click(); await modal.waitFor({ state: "hidden" }); await a.getByText("有效规则：无", { exact: true }).first().waitFor(); assert.equal(await a.getByRole("button", { name: "停止 Key 9 的账单核算", exact: true }).count(), 0); assert.deepEqual(mutations.map(({ method, path }) => [method, path]), [["PUT", "/api/stations/st_u04_a1"], ["PUT", "/api/stations/st_u04_a1"], ["DELETE", "/api/reconciliation/rules/rule_u04"]]); assert.equal(model.accounts[0].resources.find((entry) => entry.id === "st_u04_a2").monitorEnabled, true); assert.equal(model.accounts[0].keys[0].ruleIds.includes("rule_history"), true); assert.equal(await center.getByRole("button", { name: /暂停监控 st_u04_own/ }).count(), 0);
});

test("authorization target changes invalidate preview and keyboard cancellation works at 320/390/768/1440 without overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, center, model, updates } = await openAuthorizationPage(t, { viewport: { width, height: 900 } }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("width-pat"); await previewAuthorization(drawer); const target = drawer.getByRole("checkbox", { name: "更新目标 A-monitor-2", exact: true }); await target.focus(); await page.keyboard.press("Space"); assert.equal(await drawer.getByRole("button", { name: "确认更新所选授权", exact: true }).isDisabled(), true); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `authorization overflow at ${width}`); await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(updates.length, 0);
  }
});

test("account center preserves mixed accounts, original resource IDs, dedicated purpose and independent pure Keys", async (t) => {
  const { page, center, model, mutations } = await openAccountsPage(t);
  assert.equal(await center.locator("[data-site-key]").count(), 2); const a = await expandAccount(center, model.accounts[0]), b = await expandAccount(center, model.accounts[1]), sub = await expandAccount(center, model.accounts[2]);
  assert.equal(await a.locator("[data-resource-id]").count(), 3); assert.equal(await b.locator("[data-resource-id='B-monitor']").count(), 1); assert.equal(await sub.locator("[data-resource-id]").count(), 2);
  const dedicated = a.locator("[data-resource-id='A-billing']"); await dedicated.getByText("监控暂停 / 未启用", { exact: true }).waitFor(); await dedicated.getByRole("button", { name: "查看原资源设置 A-billing", exact: true }).waitFor(); assert.equal(await page.locator(".resource-list-card").getByText("A-billing", { exact: true }).count(), 0); await a.getByText(/提醒阈值：\$27.00；折算汇率：0.7 RMB\/USD；成本设置：不纳入；不再续费/).waitFor();
  assert.equal(await a.locator("[data-resource-id='pure-key']").count(), 0); await center.locator("[data-unverified-resource-id='pure-key']").getByText("关联本站渠道：Channel 1 #1", { exact: true }).waitFor(); await center.locator("[data-unverified-resource-id='unknown-legacy']").getByText("账号身份待核验", { exact: true }).waitFor(); assert.equal(await center.locator("[data-resource-id='own']").count(), 0);
  await a.getByRole("button", { name: /Key 9 · #9/ }).click(); await a.getByText("Channel 3 · #3", { exact: true }).waitFor(); await a.getByText("当前范围版本：3 · 用途范围待确认", { exact: true }).waitFor(); await a.getByRole("button", { name: /Key 10 · #10/ }).click(); await a.getByText("历史范围版本：3 · 用途范围待确认", { exact: true }).waitFor(); await a.getByText("有效规则：无", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看归档资源", exact: true }).click(); await a.locator("[data-resource-id='A-archived']").waitFor(); await page.getByText("自营", { exact: true }).waitFor(); assert.doesNotMatch(await center.innerText(), /余额合计|总余额|\$30\.00/); assert.equal(await center.getByRole("link").count(), 0); assert.equal(mutations.length, 0);
});

test("account search and attention filters preserve relationships and open only the original complete editor object", async (t) => {
  const { page, center, model, mutations } = await openAccountsPage(t); await center.getByRole("textbox", { name: "搜索账号关系" }).fill("A-monitor-1"); await center.getByText(/显示 1\/3 个已核验账号/).waitFor(); const a = await expandAccount(center, model.accounts[0]);
  await a.getByRole("button", { name: "查看原资源设置 A-monitor-1", exact: true }).click(); const editor = page.getByRole("dialog", { name: "编辑上游资源", exact: true }); await editor.waitFor(); assert.equal(await editor.getByLabel("用户 ID（New-Api-User）", { exact: true }).inputValue(), "operator-A"); assert.equal(await editor.getByLabel("成本渠道匹配别名", { exact: true }).inputValue(), "kept_alias"); await editor.getByRole("button", { name: /取\s*消/ }).click(); await editor.waitFor({ state: "hidden" });
  await center.getByRole("textbox", { name: "搜索账号关系" }).fill("Sub-password"); const sub = await expandAccount(center, model.accounts[2]); await sub.getByRole("button", { name: "查看原资源设置 Sub-password", exact: true }).click(); await editor.waitFor(); assert.equal(await editor.getByLabel("登录邮箱", { exact: true }).inputValue(), "saved-sub@example.test"); await editor.getByRole("button", { name: /取\s*消/ }).click(); await editor.waitFor({ state: "hidden" });
  await center.getByRole("textbox", { name: "搜索账号关系" }).fill("Key 10"); await expandAccount(center, model.accounts[0]); await a.getByRole("button", { name: /Key 10 · #10/ }).click(); await a.getByText("Channel 2 · #2", { exact: true }).waitFor(); assert.equal(await a.locator("[data-resource-id]").count(), 3);
  await center.getByRole("textbox", { name: "搜索账号关系" }).fill(""); await center.getByRole("combobox", { name: "账号关系状态" }).click(); await page.getByText("需处理", { exact: true }).last().click(); await center.getByText(/显示 1\/3 个已核验账号/).waitFor(); assert.equal(await center.getByRole("button", { name: /账号 B / }).count(), 0);
  await center.getByRole("textbox", { name: "搜索账号关系" }).fill("pure-key"); await center.getByText(/显示 0\/3 个已核验账号；待核验资源 1\/2/).waitFor(); await center.locator("[data-unverified-resource-id='pure-key']").waitFor(); assert.equal(mutations.length, 0);
});

test("conflicting active Key scopes remain unknown and never expose one selected scope as unified", async (t) => {
  const model = accountReadFixture(), key = model.accounts[0].keys[0]; Object.assign(key, { activeRuleIds: ["A-active", "A-conflict"], ruleIds: ["A-active", "A-conflict", "A-history"], scopeAmbiguous: true, costCoverage: "unknown", coverageDeclaration: { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] }, scopeVersion: null, billingEffectiveFromMs: null, firstQueryableAtMs: null }); key.channels.push({ ownSource: null, ownStationId: "old-own", channelId: 1, name: "Legacy channel 1" });
  const { center } = await openAccountsPage(t, { model }); const a = await expandAccount(center, model.accounts[0]); await a.getByRole("button", { name: /Key 9 · #9/ }).click(); const scope = a.locator(`[data-canonical-key="${key.canonicalKey}"]`); await scope.getByText("存在多个有效规则，范围待核对", { exact: true }).waitFor(); await scope.getByText("来源待核验 · old-own", { exact: true }).waitFor(); assert.doesNotMatch(await scope.innerText(), /当前范围版本|生效边界|2026-10/); assert.match(await scope.innerText(), /A-active、A-conflict/);
});

test("account read failure retains the last public relationships and retry restores the center", async (t) => {
  const { center, accountRequests, mutations } = await openAccountsPage(t, { accounts(route, count, model) { return count === 2 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "账号关系暂不可用" }) }) : fulfill(route, model); } });
  await center.getByRole("button", { name: "刷新账号关系", exact: true }).click(); await center.getByText("账号关系刷新失败，正在显示上次结果", { exact: true }).waitFor(); await center.getByRole("button", { name: /账号 B / }).waitFor(); await center.getByRole("button", { name: "重试账号关系", exact: true }).click(); await center.getByText("账号关系刷新失败，正在显示上次结果", { exact: true }).waitFor({ state: "hidden" }); assert.deepEqual(accountRequests, ["GET", "GET", "GET"]); assert.equal(mutations.length, 0);
});

test("an initial account read failure offers a working retry without affecting original monitoring resources", async (t) => {
  const { page, center, accountRequests } = await openAccountsPage(t, { initialFailure: true, accounts(route, count, model) { return count === 1 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "账号关系暂不可用" }) }) : fulfill(route, model); } });
  await page.getByText("自营", { exact: true }).waitFor(); await center.getByRole("button", { name: "重试账号关系", exact: true }).click(); await center.getByText(/显示 3\/3 个已核验账号/).waitFor(); assert.deepEqual(accountRequests, ["GET", "GET"]);
});

test("account and Key expansion works by keyboard across 320/390/768/1440 widths without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, center, model } = await openAccountsPage(t, { viewport: { width, height: 900 } }); const site = center.locator(`[data-site-key="${model.accounts[0].siteKey}"]`), accountButton = site.getByRole("button", { name: /账号 A / }); await accountButton.focus(); await page.keyboard.press("Enter"); const a = center.locator(`[data-account-key="${model.accounts[0].accountKey}"]`); await a.waitFor(); const keyButton = a.getByRole("button", { name: /Key 9 · #9/ }); await keyButton.focus(); await page.keyboard.press("Enter"); await a.getByText("Channel 3 · #3", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `account center overflow at ${width}`); await keyButton.focus(); await page.keyboard.press("Enter"); await a.getByText("Channel 3 · #3", { exact: true }).waitFor({ state: "hidden" });
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
